//! Sidebid: sell tokens to the best offer. Tokens stay in the seller's
//! wallet behind an exact delegate until a sale settles atomically.
//!
//! No instruction here is an admin path: no config, pause or fee. Every lamport
//! and token movement follows one of the rules in the program README. The
//! upgrade authority, while it exists, sits outside these rules: see the README.
//!
//! Feature `withdraw-only` builds the shutdown version: every instruction that
//! creates a listing, bids, buys or completes a sale fails with `WithdrawOnly`,
//! and only the paths that send SOL home and close accounts stay. See
//! "Withdraw-only shutdown" in the README.
#![cfg_attr(
    feature = "withdraw-only",
    allow(unreachable_code, unused_variables, unused_imports, dead_code)
)]
use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token_interface::{
    self, Approve, Mint, Revoke, TokenAccount, TokenInterface, TransferChecked,
};

mod checks;
use checks::*;

declare_id!("5ATUD6arr5QJQtGxH8naPwFcZoDsuosmAVJcsaZ19HDp");

// Shown on Solana Explorer and Solscan. Changing any value changes the binary.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Sidebid",
    project_url: "https://sidebid.fun",
    contacts: "email:sidebid@outlook.com",
    policy: "https://sidebid.fun/docs",
    preferred_languages: "en",
    source_code: "https://github.com/sidebid/sidebid",
    auditors: "None"
}

pub const LISTING_SEED: &[u8] = b"listing";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CREDIT_SEED: &[u8] = b"credit";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const ACCEPT_SEED: &[u8] = b"accept";

/// The only key that may create accept mode listings. It cannot move funds or
/// tokens: its one power is `create_accept_listing`. A literal, so a verified
/// build reproduces it with no environment. Its secret lives only on the server.
#[cfg(not(feature = "test-listing-key"))]
pub const LISTING_SERVER_KEY: Pubkey = Pubkey::from_str_const("5uoQXnzrrrsrS5VoFKqnwVtBukrhbA4NuXNaJAPz5yTm");
/// Tests only: the public key derived in tests/fixtures/test-listing-key.mjs.
/// Feature `test-listing-key` is off by default, and scripts/check-release.mjs
/// fails if a release .so contains these bytes.
#[cfg(feature = "test-listing-key")]
pub const LISTING_SERVER_KEY: Pubkey = Pubkey::from_str_const("9uFeiSbk6UBfEtPmNJiGCPeik6vtc8MDCgUQrbDZQP91");

/// Lowest price or bid. Above the rent exempt minimum of an empty account
/// (890,880 lamports), so a payment can always revive a closed wallet and can
/// always fund a credit account.
pub const MIN_PRICE_LAMPORTS: u64 = 1_000_000;
pub const MIN_DURATION_SECS: i64 = 10;
/// Longest auction or tagged card countdown. Limits how long a bid can be held.
pub const MAX_AUCTION_SECS: i64 = 60 * 60;
/// A fixed listing holds nobody's SOL, so a longer expiry locks nothing.
pub const MAX_FIXED_SECS: i64 = 30 * 24 * 60 * 60;
/// Last second bids can move the end at most this far past the original end.
pub const MAX_EXTENSION_SECS: i64 = 300;
pub const SNIPE_WINDOW_SECS: i64 = 15;
pub const SNIPE_EXTENSION_SECS: i64 = 15;
/// If a finished auction still cannot settle this long after its end (for
/// example a freeze authority froze the winner), the bid can go home.
pub const SETTLE_GRACE_SECS: i64 = 24 * 60 * 60;
pub const MIN_ACCEPT_WINDOW_SECS: i64 = 60;
pub const MAX_ACCEPT_WINDOW_SECS: i64 = 60 * 60;

#[program]
pub mod sidebid {
    use super::*;

    /// Creates the listing and approves its PDA for exactly `amount`.
    pub fn create_listing(ctx: Context<CreateListing>, args: CreateListingArgs) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        require!(args.amount > 0, SidebidError::ZeroAmount);
        require!(args.price >= MIN_PRICE_LAMPORTS, SidebidError::PriceTooLow);
        let token = &ctx.accounts.seller_token_account;
        require!(token.amount >= args.amount, SidebidError::InsufficientTokens);
        require!(!token.is_frozen(), SidebidError::TokenAccountFrozen);
        check_mint_extensions(&ctx.accounts.mint.to_account_info())?;

        // Reject out of range values before any arithmetic can wrap.
        let duration = i64::try_from(args.duration_secs).map_err(|_| SidebidError::BadDuration)?;
        let end_time = match args.mode {
            ListingMode::Accept => return err!(SidebidError::WrongMode),
            ListingMode::Bidding => {
                require!(
                    (MIN_DURATION_SECS..=MAX_AUCTION_SECS).contains(&duration),
                    SidebidError::BadDuration
                );
                require!(args.pass.is_none(), SidebidError::PassOnBidding);
                now.checked_add(duration).ok_or(SidebidError::Overflow)?
            }
            ListingMode::Fixed if duration == 0 => 0, // 0 means no expiry
            ListingMode::Fixed => {
                require!(
                    (MIN_DURATION_SECS..=MAX_FIXED_SECS).contains(&duration),
                    SidebidError::BadDuration
                );
                now.checked_add(duration).ok_or(SidebidError::Overflow)?
            }
        };
        let hard_end_time = match args.mode {
            ListingMode::Bidding => end_time
                .checked_add(MAX_EXTENSION_SECS)
                .ok_or(SidebidError::Overflow)?,
            _ => end_time,
        };

        let listing_key = ctx.accounts.listing.key();
        let (pass_signer, campaign) = match args.pass {
            Some(pass) => {
                require!(pass.signer != Pubkey::default(), SidebidError::BadPassConfig);
                // A default campaign means this listing is its own campaign.
                let campaign = if pass.campaign == Pubkey::default() {
                    listing_key
                } else {
                    pass.campaign
                };
                (pass.signer, campaign)
            }
            None => (Pubkey::default(), Pubkey::default()),
        };

        ctx.accounts.listing.set_inner(Listing {
            seller: ctx.accounts.seller.key(),
            token_account: ctx.accounts.seller_token_account.key(),
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            amount: args.amount,
            price: args.price,
            end_time,
            top_bidder: Pubkey::default(),
            top_bid: 0,
            pass_signer,
            campaign,
            mode: args.mode,
            state: ListingState::Live,
            decimals: ctx.accounts.mint.decimals,
            bump: ctx.bumps.listing,
            vault_bump: ctx.bumps.vault,
            rent_payer: ctx.accounts.seller.key(),
            accept_window_secs: 0,
            hard_end_time,
        });

        // The only delegate this program ever sets, always exactly `amount`.
        token_interface::approve(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Approve {
                    to: ctx.accounts.seller_token_account.to_account_info(),
                    delegate: ctx.accounts.listing.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            args.amount,
        )?;

        emit!(Listed {
            listing: listing_key,
            seller: ctx.accounts.seller.key(),
            mint: ctx.accounts.mint.key(),
            amount: args.amount,
            price: args.price,
            end_time,
            mode: args.mode,
        });
        Ok(())
    }

    /// Server only: opens a tagged card for a wallet that holds the tokens now.
    /// No seller signature and no delegate, so nothing here can touch the
    /// tokens. `listing_id` comes from the server, normally a hash of the post.
    pub fn create_accept_listing(
        ctx: Context<CreateAcceptListing>,
        _listing_id: [u8; 32],
        args: CreateAcceptArgs,
    ) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        require!(args.amount > 0, SidebidError::ZeroAmount);
        require!(args.min_bid >= MIN_PRICE_LAMPORTS, SidebidError::PriceTooLow);
        let token = &ctx.accounts.seller_token_account;
        require!(token.amount >= args.amount, SidebidError::InsufficientTokens);
        require!(!token.is_frozen(), SidebidError::TokenAccountFrozen);
        check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
        let duration = i64::try_from(args.duration_secs).map_err(|_| SidebidError::BadDuration)?;
        require!(
            (MIN_DURATION_SECS..=MAX_AUCTION_SECS).contains(&duration),
            SidebidError::BadDuration
        );
        let window = i64::try_from(args.accept_window_secs).map_err(|_| SidebidError::BadDuration)?;
        require!(
            (MIN_ACCEPT_WINDOW_SECS..=MAX_ACCEPT_WINDOW_SECS).contains(&window),
            SidebidError::BadDuration
        );
        let end_time = now.checked_add(duration).ok_or(SidebidError::Overflow)?;
        let hard_end_time = end_time
            .checked_add(MAX_EXTENSION_SECS)
            .ok_or(SidebidError::Overflow)?;
        let seller = token.owner;
        ctx.accounts.listing.set_inner(Listing {
            seller,
            token_account: token.key(),
            mint: ctx.accounts.mint.key(),
            token_program: ctx.accounts.token_program.key(),
            amount: args.amount,
            price: args.min_bid,
            end_time,
            top_bidder: Pubkey::default(),
            top_bid: 0,
            pass_signer: Pubkey::default(),
            campaign: Pubkey::default(),
            mode: ListingMode::Accept,
            state: ListingState::Live,
            decimals: ctx.accounts.mint.decimals,
            bump: ctx.bumps.listing,
            vault_bump: ctx.bumps.vault,
            rent_payer: ctx.accounts.server.key(),
            accept_window_secs: window,
            hard_end_time,
        });
        emit!(Listed {
            listing: ctx.accounts.listing.key(),
            seller,
            mint: ctx.accounts.mint.key(),
            amount: args.amount,
            price: args.min_bid,
            end_time,
            mode: ListingMode::Accept,
        });
        Ok(())
    }

    /// Seller only, inside the window after the end. One transaction: tokens
    /// from the seller to the winner, SOL from the vault to the seller. May
    /// spend from any token account the seller owns. `expected_*` stop a
    /// recreated listing swapping the deal under a pending signature.
    pub fn accept(ctx: Context<Accept>, expected_amount: u64, expected_bid: u64) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        require!(a.listing.state == ListingState::Live, SidebidError::NotLive);
        require!(a.listing.mode == ListingMode::Accept, SidebidError::WrongMode);
        require!(
            a.listing.amount == expected_amount && a.listing.top_bid == expected_bid,
            SidebidError::ListingChanged
        );
        require!(now >= a.listing.end_time, SidebidError::AuctionNotEnded);
        let deadline = a
            .listing
            .end_time
            .checked_add(a.listing.accept_window_secs)
            .ok_or(SidebidError::Overflow)?;
        require!(now < deadline, SidebidError::AcceptWindowClosed);
        require!(a.listing.top_bid > 0, SidebidError::NoBids);
        require!(
            a.seller_token_account.amount >= a.listing.amount,
            SidebidError::InsufficientTokens
        );

        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.seller_token_account.to_account_info(),
                    mint: a.mint.to_account_info(),
                    to: a.winner_token_account.to_account_info(),
                    authority: a.seller.to_account_info(),
                },
            ),
            a.listing.amount,
            a.listing.decimals,
        )?;
        let vault_bump = [a.listing.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];
        pay(
            &a.vault.to_account_info(),
            vault_seeds,
            &a.seller.to_account_info(),
            &a.seller_credit.to_account_info(),
            listing_key,
            a.vault.lamports(),
            &a.system_program,
        )?;
        emit!(Accepted {
            listing: listing_key,
            winner: a.listing.top_bidder,
            seller: a.listing.seller,
            amount: a.listing.amount,
            price: a.listing.top_bid,
        });
        close_listing_account(
            &mut a.listing,
            &a.rent_receiver.to_account_info(),
            &a.rent_receiver_credit.to_account_info(),
        )
    }

    /// Takes a new top bid. The previous bidder is repaid in this transaction.
    /// `expected_token_amount`, `expected_mint` and `max_end_time` stop a seller
    /// changing the deal under a pending bid by cancelling and relisting at the
    /// same address. Clients pass the listing's `hard_end_time` as `max_end_time`.
    pub fn place_bid(
        ctx: Context<PlaceBid>,
        amount: u64,
        expected_token_amount: u64,
        expected_mint: Pubkey,
        max_end_time: i64,
    ) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        require!(a.listing.state == ListingState::Live, SidebidError::NotLive);
        require!(a.listing.mode != ListingMode::Fixed, SidebidError::WrongMode);
        require!(
            a.listing.amount == expected_token_amount
                && a.listing.mint == expected_mint
                && a.listing.hard_end_time <= max_end_time,
            SidebidError::ListingChanged
        );
        require!(now < a.listing.end_time, SidebidError::AuctionEnded);
        require!(
            can_fill(&a.listing, listing_key, &a.seller_token_account.to_account_info()),
            SidebidError::SellerTokensUnavailable
        );
        require!(
            amount >= a.listing.price && amount >= MIN_PRICE_LAMPORTS,
            SidebidError::BidBelowMinimum
        );
        require!(amount > a.listing.top_bid, SidebidError::BidNotAboveTop);
        if a.listing.top_bid > 0 {
            require!(
                amount >= minimum_next_bid(a.listing.top_bid)?,
                SidebidError::RaiseTooSmall
            );
        }

        let vault_bump = [a.listing.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];

        // Repay first so a bidder raising their own bid only needs the difference.
        if a.listing.top_bid > 0 {
            let prev = a.prev_bidder.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            let credit = a.prev_bidder_credit.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            require_keys_eq!(prev.key(), a.listing.top_bidder, SidebidError::MissingPrevBidder);
            pay(
                &a.vault.to_account_info(),
                vault_seeds,
                &prev.to_account_info(),
                &credit.to_account_info(),
                listing_key,
                a.listing.top_bid,
                &a.system_program,
            )?;
        }

        system_program::transfer(
            CpiContext::new(
                a.system_program.key(),
                Transfer {
                    from: a.bidder.to_account_info(),
                    to: a.vault.to_account_info(),
                },
            ),
            amount,
        )?;

        a.listing.top_bidder = a.bidder.key();
        a.listing.top_bid = amount;
        let remaining = a.listing.end_time.checked_sub(now).ok_or(SidebidError::Overflow)?;
        if remaining <= SNIPE_WINDOW_SECS {
            a.listing.end_time = a
                .listing
                .end_time
                .checked_add(SNIPE_EXTENSION_SECS)
                .ok_or(SidebidError::Overflow)?
                .min(a.listing.hard_end_time);
        }
        emit!(BidPlaced {
            listing: listing_key,
            bidder: a.bidder.key(),
            amount,
            end_time: a.listing.end_time,
        });
        Ok(())
    }

    /// After the end, anyone may settle: tokens to the winner, SOL to the
    /// seller, listing closed, all in one transaction.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        require!(a.listing.state == ListingState::Live, SidebidError::NotLive);
        require!(a.listing.mode == ListingMode::Bidding, SidebidError::WrongMode);
        require!(now >= a.listing.end_time, SidebidError::AuctionNotEnded);
        require!(a.listing.top_bid > 0, SidebidError::NoBids);
        require!(
            can_deliver(&a.listing, listing_key, &a.seller_token_account.to_account_info()),
            SidebidError::SellerTokensUnavailable
        );

        deliver_tokens(
            &a.listing,
            &a.seller_token_account.to_account_info(),
            &a.mint.to_account_info(),
            &a.winner_token_account.to_account_info(),
            a.token_program.key(),
        )?;
        let vault_bump = [a.listing.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];
        // Includes anything donated to the vault: a remainder below the rent
        // minimum would otherwise fail the transaction.
        pay(
            &a.vault.to_account_info(),
            vault_seeds,
            &a.seller.to_account_info(),
            &a.seller_credit.to_account_info(),
            listing_key,
            a.vault.lamports(),
            &a.system_program,
        )?;
        emit!(Settled {
            listing: listing_key,
            winner: a.listing.top_bidder,
            seller: a.listing.seller,
            amount: a.listing.amount,
            price: a.listing.top_bid,
        });
        close_listing_account(&mut a.listing, &a.seller.to_account_info(), &a.seller_credit.to_account_info())
    }

    /// Anyone may call this when the seller can no longer deliver (moved
    /// tokens, revoked, closed or froze the account) or when a finished auction
    /// has stayed unsettled past the grace period. The top bidder gets all SOL
    /// back and the listing is marked Gone. In accept mode the same holds once
    /// the accept window has passed or the seller no longer holds the tokens,
    /// and the listing is marked Ghosted.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        require!(a.listing.state == ListingState::Live, SidebidError::NotLive);
        #[cfg(not(feature = "withdraw-only"))]
        let deliverable =
            can_fill(&a.listing, listing_key, &a.seller_token_account.to_account_info());
        let has_bid = a.listing.top_bid > 0;
        let accept_mode = a.listing.mode == ListingMode::Accept;
        // A no bid card has nobody to refund and must not read "Seller ghosted".
        // It is closed with close_listing after its end instead.
        require!(has_bid || !accept_mode, SidebidError::NoBids);
        // Withdraw-only: no sale can complete any more, so the bid goes home now.
        #[cfg(not(feature = "withdraw-only"))]
        {
            let wait = if accept_mode {
                a.listing.accept_window_secs
            } else {
                SETTLE_GRACE_SECS
            };
            let stale = has_bid
                && now >= a.listing.end_time.checked_add(wait).ok_or(SidebidError::Overflow)?;
            require!(!deliverable || stale, SidebidError::RefundNotAllowed);
        }

        let refunded = a.listing.top_bid;
        if has_bid {
            let bidder = a.top_bidder.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            let credit = a.top_bidder_credit.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            require_keys_eq!(bidder.key(), a.listing.top_bidder, SidebidError::MissingPrevBidder);
            let vault_bump = [a.listing.vault_bump];
            let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];
            pay(
                &a.vault.to_account_info(),
                vault_seeds,
                &bidder.to_account_info(),
                &credit.to_account_info(),
                listing_key,
                a.vault.lamports(),
                &a.system_program,
            )?;
        }
        emit!(MarkedGone {
            listing: listing_key,
            bidder: a.listing.top_bidder,
            refunded,
        });
        a.listing.top_bidder = Pubkey::default();
        a.listing.top_bid = 0;
        a.listing.state = if accept_mode {
            ListingState::Ghosted
        } else {
            ListingState::Gone
        };
        Ok(())
    }

    /// Seller only. Before the end, or any time with no bids. Repays the top
    /// bidder, removes this listing's delegate and closes the listing. Never
    /// touches a delegate the seller set for something else.
    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        let has_bid = a.listing.top_bid > 0;
        // A seller who does not want a tagged card simply does not accept it.
        require!(a.listing.mode != ListingMode::Accept, SidebidError::WrongMode);
        // Withdraw-only: settle is gone, so a seller may also cancel after the end.
        #[cfg(not(feature = "withdraw-only"))]
        if has_bid {
            require!(now < a.listing.end_time, SidebidError::AuctionEnded);
        }
        let vault_bump = [a.listing.vault_bump];
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];
        if has_bid {
            let bidder = a.top_bidder.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            let credit = a.top_bidder_credit.as_ref().ok_or(SidebidError::MissingPrevBidder)?;
            require_keys_eq!(bidder.key(), a.listing.top_bidder, SidebidError::MissingPrevBidder);
            pay(
                &a.vault.to_account_info(),
                vault_seeds,
                &bidder.to_account_info(),
                &credit.to_account_info(),
                listing_key,
                a.vault.lamports(),
                &a.system_program,
            )?;
        } else if a.vault.lamports() > 0 {
            // Only donations can be here. Sweep so the seller is not left with dust.
            pay(
                &a.vault.to_account_info(),
                vault_seeds,
                &a.seller.to_account_info(),
                &a.seller_credit.to_account_info(),
                listing_key,
                a.vault.lamports(),
                &a.system_program,
            )?;
        }

        // Revoke only when it can succeed and is ours to remove. A closed,
        // transferred or frozen account must not block the cancel.
        let token_info = a.seller_token_account.to_account_info();
        if delegate_is_ours(&a.listing, listing_key, &token_info) {
            token_interface::revoke(CpiContext::new(
                a.token_program.key(),
                Revoke {
                    source: token_info,
                    authority: a.seller.to_account_info(),
                },
            ))?;
        }
        emit!(Cancelled {
            listing: listing_key,
            refunded: a.listing.top_bid,
        });
        close_listing_account(&mut a.listing, &a.seller.to_account_info(), &a.seller_credit.to_account_info())
    }

    /// First buyer takes a fixed price listing. The buyer is the only signer.
    /// `expected_*` protect against a relist at the same address.
    pub fn buy_fixed(ctx: Context<BuyFixed>, expected_price: u64, expected_amount: u64) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let a = ctx.accounts;
        require!(a.listing.pass_signer == Pubkey::default(), SidebidError::PassRequired);
        execute_fixed_buy(
            &mut a.listing,
            &a.buyer,
            &a.seller.to_account_info(),
            &a.seller_credit.to_account_info(),
            &a.seller_token_account.to_account_info(),
            &a.mint.to_account_info(),
            &a.buyer_token_account.to_account_info(),
            a.token_program.key(),
            &a.system_program,
            expected_price,
            expected_amount,
        )
    }

    /// Fixed buy gated by a server pass. The instruction right before this one
    /// must be the ed25519 verify of the pass. The claim account makes a second
    /// use of the same X id in this campaign fail.
    pub fn buy_fixed_with_pass(
        ctx: Context<BuyFixedWithPass>,
        x_id_hash: [u8; 32],
        pass_expiry: i64,
        expected_price: u64,
        expected_amount: u64,
    ) -> Result<()> {
        #[cfg(feature = "withdraw-only")]
        return err!(ShutdownError::WithdrawOnly);
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        require!(a.listing.pass_signer != Pubkey::default(), SidebidError::PassNotUsed);
        require!(now <= pass_expiry, SidebidError::PassExpired);
        let message = pass_message(&a.listing.campaign, &a.buyer.key(), &x_id_hash, pass_expiry);
        verify_pass_ed25519(
            &a.instructions.to_account_info(),
            &a.listing.pass_signer,
            &message,
        )?;
        execute_fixed_buy(
            &mut a.listing,
            &a.buyer,
            &a.seller.to_account_info(),
            &a.seller_credit.to_account_info(),
            &a.seller_token_account.to_account_info(),
            &a.mint.to_account_info(),
            &a.buyer_token_account.to_account_info(),
            a.token_program.key(),
            &a.system_program,
            expected_price,
            expected_amount,
        )
    }

    /// Anyone may close a Gone or Ghosted listing, or an expired one with no
    /// bids. Rent goes back to whoever paid it, never to the caller. A listing
    /// whose delegate is still on the seller's account stays open for the
    /// seller's `cancel`, the only path that can remove it: strangers can't
    /// revoke, and closing first would leave a dangling approval behind.
    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        let listing_key = a.listing.key();
        #[cfg(not(feature = "withdraw-only"))]
        {
            let expired_unsold = a.listing.state == ListingState::Live
                && a.listing.top_bid == 0
                && a.listing.end_time != 0
                && now >= a.listing.end_time;
            require!(
                a.listing.state != ListingState::Live || expired_unsold,
                SidebidError::CloseNotAllowed
            );
            // Accept mode never sets a delegate, so a seller approving the listing
            // address by hand must not be able to hold the server's rent hostage.
            require!(
                a.listing.mode == ListingMode::Accept
                    || !delegate_is_ours(&a.listing, listing_key, &a.seller_token_account.to_account_info()),
                SidebidError::DelegateStillSet
            );
        }
        // Withdraw-only: any listing without a bid closes, in any state and
        // with or without a leftover approval. A bid must go home through
        // refund first. Nothing in this build can use the approval: settle and
        // both buys are off, so it is left for the seller to revoke.
        #[cfg(feature = "withdraw-only")]
        require!(a.listing.top_bid == 0, SidebidError::CloseNotAllowed);
        if a.vault.lamports() > 0 {
            let vault_bump = [a.listing.vault_bump];
            let vault_seeds: &[&[u8]] = &[VAULT_SEED, listing_key.as_ref(), &vault_bump];
            pay(
                &a.vault.to_account_info(),
                vault_seeds,
                &a.rent_receiver.to_account_info(),
                &a.rent_receiver_credit.to_account_info(),
                listing_key,
                a.vault.lamports(),
                &a.system_program,
            )?;
        }
        close_listing_account(&mut a.listing, &a.rent_receiver.to_account_info(), &a.rent_receiver_credit.to_account_info())
    }

    /// Pays out a credit: SOL that could not be pushed to an account because
    /// that account cannot legally receive it (see `checks::can_receive`).
    pub fn claim_credit(ctx: Context<ClaimCredit>, listing: Pubkey) -> Result<()> {
        let a = ctx.accounts;
        let amount = a.credit.lamports();
        require!(amount > 0, SidebidError::NothingToClaim);
        let owner = a.owner.key();
        let bump = [ctx.bumps.credit];
        let seeds: &[&[u8]] = &[CREDIT_SEED, listing.as_ref(), owner.as_ref(), &bump];
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.key(),
                Transfer {
                    from: a.credit.to_account_info(),
                    to: a.destination.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }

    /// Withdraw-only: anyone may push a credit to its owner, the address the
    /// credit is derived from, never anywhere else. Fails while the owner still
    /// cannot receive; `claim_credit` stays open to the owner either way.
    #[cfg(feature = "withdraw-only")]
    pub fn push_credit(ctx: Context<PushCredit>, listing: Pubkey) -> Result<()> {
        let a = ctx.accounts;
        let amount = a.credit.lamports();
        require!(amount > 0, SidebidError::NothingToClaim);
        require!(
            can_receive(&a.owner.to_account_info(), amount)?,
            ShutdownError::OwnerCannotReceive
        );
        let owner = a.owner.key();
        let bump = [ctx.bumps.credit];
        let seeds: &[&[u8]] = &[CREDIT_SEED, listing.as_ref(), owner.as_ref(), &bump];
        system_program::transfer(
            CpiContext::new_with_signer(
                a.system_program.key(),
                Transfer {
                    from: a.credit.to_account_info(),
                    to: a.owner.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ListingMode {
    Bidding,
    Fixed,
    Accept,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ListingState {
    Live,
    Gone,
    Ghosted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PassConfig {
    /// Ed25519 key whose passes this listing accepts. Chosen by the seller.
    pub signer: Pubkey,
    /// Shared campaign id. Default means the listing is its own campaign.
    pub campaign: Pubkey,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CreateListingArgs {
    pub mode: ListingMode,
    /// Token base units sold, all or nothing.
    pub amount: u64,
    /// Fixed price, or minimum bid, in lamports.
    pub price: u64,
    /// Bidding: required. Fixed: 0 means no expiry.
    pub duration_secs: u64,
    pub pass: Option<PassConfig>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CreateAcceptArgs {
    pub amount: u64,
    pub min_bid: u64,
    pub duration_secs: u64,
    pub accept_window_secs: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub token_account: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub amount: u64,
    pub price: u64,
    pub end_time: i64,
    pub top_bidder: Pubkey,
    pub top_bid: u64,
    pub pass_signer: Pubkey,
    pub campaign: Pubkey,
    pub mode: ListingMode,
    pub state: ListingState,
    pub decimals: u8,
    pub bump: u8,
    pub vault_bump: u8,
    /// Who gets the rent back: the seller, or the server for a tagged card.
    pub rent_payer: Pubkey,
    /// Accept mode only. Seconds after end_time the seller may accept.
    pub accept_window_secs: i64,
    /// Latest end_time any bid can reach. Bidding and accept: original end plus
    /// MAX_EXTENSION_SECS. Fixed: same as end_time.
    pub hard_end_time: i64,
}

/// Exists only to make a second use of one X id fail. Never closed.
#[account]
#[derive(InitSpace)]
pub struct Claim {}

#[derive(Accounts)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    // One live listing per token account, as an SPL account has one delegate.
    #[account(
        init,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, seller_token_account.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: PDA with no data, only its bump is read here.
    #[account(seeds = [VAULT_SEED, listing.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    // Associated token account only: its address fixes the mint, so a listing
    // address can never come back holding a different coin.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program
    )]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(listing_id: [u8; 32])]
pub struct CreateAcceptListing<'info> {
    #[account(mut, address = LISTING_SERVER_KEY @ SidebidError::NotListingServer)]
    pub server: Signer<'info>,
    // Own seed space: a tagged card can never occupy a seller's own listing
    // address, whose seed is their token account.
    #[account(
        init,
        payer = server,
        space = 8 + Listing::INIT_SPACE,
        seeds = [ACCEPT_SEED, listing_id.as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: PDA with no data, only its bump is read here.
    #[account(seeds = [VAULT_SEED, listing.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: the wallet named as seller. Pinned by the associated token account below.
    pub seller: UncheckedAccount<'info>,
    /// Read only: must hold the amount. Associated token account only, as in
    /// create_listing, so "the seller no longer holds" reads a stable address.
    #[account(
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program
    )]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(mut, address = listing.seller @ SidebidError::NotSeller)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub seller_credit: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = listing.mint,
        token::authority = seller,
        token::token_program = token_program
    )]
    pub seller_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: pinned to the listing, validated by the token program.
    #[account(address = listing.mint)]
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = listing.mint,
        token::authority = listing.top_bidder,
        token::token_program = token_program
    )]
    pub winner_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: pinned to the listing.
    #[account(mut, address = listing.rent_payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// CHECK: address verified before it is ever credited.
    #[account(mut)]
    pub rent_receiver_credit: UncheckedAccount<'info>,
    #[account(address = listing.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: address pinned to the listing, parsed defensively in `can_deliver`.
    #[account(address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: must equal listing.top_bidder, checked in the handler. May be any
    /// kind of account, which is why it is unchecked and only credited.
    #[account(mut)]
    pub prev_bidder: Option<UncheckedAccount<'info>>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub prev_bidder_credit: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: pinned to the listing.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub seller_credit: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, parsed defensively in `can_deliver`.
    #[account(mut, address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, validated by the token program.
    #[account(address = listing.mint)]
    pub mint: UncheckedAccount<'info>,
    /// Any token account the winner owns, not only their ATA. A winner cannot
    /// block settle by breaking one account, as anyone can open a fresh one.
    #[account(
        mut,
        token::mint = listing.mint,
        token::authority = listing.top_bidder,
        token::token_program = token_program
    )]
    pub winner_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = listing.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: pinned to the listing. Often closed, so it must stay unchecked.
    #[account(address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: must equal listing.top_bidder, checked in the handler.
    #[account(mut)]
    pub top_bidder: Option<UncheckedAccount<'info>>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub top_bidder_credit: Option<UncheckedAccount<'info>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
    #[account(mut, address = listing.seller)]
    pub seller: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub seller_credit: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing. May be closed or transferred.
    #[account(mut, address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: must equal listing.top_bidder, checked in the handler.
    #[account(mut)]
    pub top_bidder: Option<UncheckedAccount<'info>>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub top_bidder_credit: Option<UncheckedAccount<'info>>,
    #[account(address = listing.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyFixed<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    /// CHECK: pinned to the listing.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: address verified inside `pay_from_buyer` before it is ever credited.
    #[account(mut)]
    pub seller_credit: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, parsed defensively in `can_deliver`.
    #[account(mut, address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, validated by the token program.
    #[account(address = listing.mint)]
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = listing.mint,
        token::authority = buyer,
        token::token_program = token_program
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = listing.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(x_id_hash: [u8; 32])]
pub struct BuyFixedWithPass<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    /// Keyed by pass signer too: otherwise anyone could make a listing naming
    /// someone else's campaign, sign their own passes, and burn that campaign's
    /// claims for chosen X ids.
    #[account(
        init,
        payer = buyer,
        space = 8 + Claim::INIT_SPACE,
        seeds = [CLAIM_SEED, listing.pass_signer.as_ref(), listing.campaign.as_ref(), x_id_hash.as_ref()],
        bump
    )]
    pub claim: Account<'info, Claim>,
    /// CHECK: address pinned to the instructions sysvar.
    #[account(address = solana_instructions_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing.
    #[account(mut, address = listing.seller)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: address verified inside `pay_from_buyer` before it is ever credited.
    #[account(mut)]
    pub seller_credit: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, parsed defensively in `can_deliver`.
    #[account(mut, address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing, validated by the token program.
    #[account(address = listing.mint)]
    pub mint: UncheckedAccount<'info>,
    #[account(
        mut,
        token::mint = listing.mint,
        token::authority = buyer,
        token::token_program = token_program
    )]
    pub buyer_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(address = listing.token_program)]
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, seeds = [VAULT_SEED, listing.key().as_ref()], bump = listing.vault_bump)]
    pub vault: SystemAccount<'info>,
    /// CHECK: pinned to the listing. May be closed, so it stays unchecked.
    #[account(address = listing.token_account)]
    pub seller_token_account: UncheckedAccount<'info>,
    /// CHECK: pinned to the listing.
    #[account(mut, address = listing.rent_payer)]
    pub rent_receiver: UncheckedAccount<'info>,
    /// CHECK: address verified inside `pay` before it is ever credited.
    #[account(mut)]
    pub rent_receiver_credit: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(listing: Pubkey)]
pub struct ClaimCredit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, listing.as_ref(), owner.key().as_ref()], bump)]
    pub credit: SystemAccount<'info>,
    /// CHECK: the owner picks where their own money goes.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "withdraw-only")]
#[derive(Accounts)]
#[instruction(listing: Pubkey)]
pub struct PushCredit<'info> {
    /// CHECK: the credit's owner. The seeds below derive the credit from this
    /// address, so the SOL can only go to the account it was parked for.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, seeds = [CREDIT_SEED, listing.as_ref(), owner.key().as_ref()], bump)]
    pub credit: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Listed {
    pub listing: Pubkey,
    pub seller: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub price: u64,
    pub end_time: i64,
    pub mode: ListingMode,
}

#[event]
pub struct BidPlaced {
    pub listing: Pubkey,
    pub bidder: Pubkey,
    pub amount: u64,
    pub end_time: i64,
}

#[event]
pub struct Settled {
    pub listing: Pubkey,
    pub winner: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub price: u64,
}

#[event]
pub struct Accepted {
    pub listing: Pubkey,
    pub winner: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub price: u64,
}

#[event]
pub struct MarkedGone {
    pub listing: Pubkey,
    pub bidder: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct Cancelled {
    pub listing: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct Bought {
    pub listing: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub amount: u64,
    pub price: u64,
}

#[event]
pub struct CreditParked {
    pub listing: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum SidebidError {
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("Price or minimum is below the floor")]
    PriceTooLow,
    #[msg("Seller holds less than the listed amount")]
    InsufficientTokens,
    #[msg("Token account is frozen")]
    TokenAccountFrozen,
    #[msg("Length out of range")]
    BadDuration,
    #[msg("Bidding listings cannot carry a pass")]
    PassOnBidding,
    #[msg("Pass signer must be set")]
    BadPassConfig,
    #[msg("This mint has a Token 2022 extension Sidebid does not accept")]
    UnsupportedMintExtension,
    #[msg("Malformed mint account")]
    BadMint,
    #[msg("Listing is not live")]
    NotLive,
    #[msg("Wrong listing mode for this instruction")]
    WrongMode,
    #[msg("Listing differs from what this transaction expected")]
    ListingChanged,
    #[msg("Auction has ended")]
    AuctionEnded,
    #[msg("Auction has not ended")]
    AuctionNotEnded,
    #[msg("Seller can no longer deliver these tokens")]
    SellerTokensUnavailable,
    #[msg("Bid is below the minimum")]
    BidBelowMinimum,
    #[msg("Bid must be above the top bid")]
    BidNotAboveTop,
    #[msg("Previous bidder accounts are missing or wrong")]
    MissingPrevBidder,
    #[msg("Auction has no bids")]
    NoBids,
    #[msg("Refund is only for listings the seller can no longer deliver")]
    RefundNotAllowed,
    #[msg("This listing needs a pass")]
    PassRequired,
    #[msg("This listing takes no pass")]
    PassNotUsed,
    #[msg("Pass has expired")]
    PassExpired,
    #[msg("Pass verify instruction is missing or invalid")]
    BadPass,
    #[msg("Fixed price listing has expired")]
    ListingExpired,
    #[msg("Listing cannot be closed in this state")]
    CloseNotAllowed,
    #[msg("Credit account address is wrong")]
    BadCreditAccount,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Raise must be at least 2% or 0.001 SOL, whichever is larger")]
    RaiseTooSmall,
    #[msg("The seller must cancel to remove the delegate first")]
    DelegateStillSet,
    #[msg("Only the listing server key may create this listing")]
    NotListingServer,
    #[msg("Only the seller stored on the listing may do this")]
    NotSeller,
    #[msg("The accept window has closed")]
    AcceptWindowClosed,
    #[msg("Arithmetic overflow")]
    Overflow,
}

/// Withdraw-only build errors, numbered from 7000 so every SidebidError code
/// keeps its meaning across the upgrade.
#[cfg(feature = "withdraw-only")]
#[error_code(offset = 7000)]
pub enum ShutdownError {
    #[msg("Withdraw only: this program is shutting down. Refunds, cancels, closes and credits only")]
    WithdrawOnly,
    #[msg("The credit's owner still cannot receive SOL; the owner must claim_credit")]
    OwnerCannotReceive,
}
