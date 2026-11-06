//! Pure checks and the shared money movements.
use crate::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use solana_sdk_ids::ed25519_program;

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_TLV_START: usize = 166; // 165 bytes of base and padding, 1 account type byte

/// Token 2022 mint extensions that cannot change who receives what. Everything
/// else is refused: transfer fees shortchange the winner, hooks run foreign
/// code in settle, a permanent delegate can take the tokens, default-frozen and
/// pausable can block a sale, non-transferable can never settle.
const ALLOWED_MINT_EXTENSIONS: [u16; 6] = [
    18, // MetadataPointer
    19, // TokenMetadata
    20, // GroupPointer
    21, // TokenGroup
    22, // GroupMemberPointer
    23, // TokenGroupMember
];

pub fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    let data = mint.try_borrow_data()?;
    if data.len() <= 82 {
        return Ok(()); // no extensions possible
    }
    require!(data.len() >= MINT_TLV_START, SidebidError::BadMint);
    let mut i = MINT_TLV_START;
    while i + 4 <= data.len() {
        let kind = u16::from_le_bytes([data[i], data[i + 1]]);
        if kind == 0 {
            break; // Uninitialized: rest of the account is unused
        }
        require!(
            ALLOWED_MINT_EXTENSIONS.contains(&kind),
            SidebidError::UnsupportedMintExtension
        );
        let len = u16::from_le_bytes([data[i + 2], data[i + 3]]) as usize;
        i = i.checked_add(4 + len).ok_or(SidebidError::Overflow)?;
    }
    Ok(())
}

/// Token account fields, read by offset so a closed or foreign account is a
/// plain `false` and never an error that could block a refund.
struct TokenView {
    mint: Pubkey,
    owner: Pubkey,
    amount: u64,
    delegate: Option<Pubkey>,
    frozen: bool,
    delegated_amount: u64,
}

fn read_token(listing: &Listing, info: &AccountInfo) -> Option<TokenView> {
    if *info.owner != listing.token_program {
        return None;
    }
    let data = info.try_borrow_data().ok()?;
    if data.len() < TOKEN_ACCOUNT_LEN {
        return None;
    }
    let pk = |at: usize| Pubkey::try_from(&data[at..at + 32]).ok();
    let u = |at: usize| data[at..at + 8].try_into().ok().map(u64::from_le_bytes);
    let state = data[108];
    if state != 1 && state != 2 {
        return None; // uninitialized
    }
    Some(TokenView {
        mint: pk(0)?,
        owner: pk(32)?,
        amount: u(64)?,
        delegate: if data[72] == 1 { pk(76) } else { None },
        frozen: state == 2,
        delegated_amount: u(121)?,
    })
}

/// True only if a transfer of the listing's amount from this account can work.
pub fn can_deliver(listing: &Listing, listing_key: Pubkey, info: &AccountInfo) -> bool {
    match read_token(listing, info) {
        Some(t) => {
            t.mint == listing.mint
                && t.owner == listing.seller
                && !t.frozen
                && t.delegate == Some(listing_key)
                && t.delegated_amount >= listing.amount
                && t.amount >= listing.amount
        }
        None => false,
    }
}

/// Accept mode: the seller signs at accept, so holding the tokens is enough.
/// Read from the account stored at creation, never one the caller picks: an
/// empty account anyone opened in the seller's name must not prove they ghosted.
pub fn seller_holds(listing: &Listing, info: &AccountInfo) -> bool {
    match read_token(listing, info) {
        Some(t) => {
            t.mint == listing.mint
                && t.owner == listing.seller
                && !t.frozen
                && t.amount >= listing.amount
        }
        None => false,
    }
}

/// Whether this listing's sale can still happen, for its mode.
pub fn can_fill(listing: &Listing, listing_key: Pubkey, info: &AccountInfo) -> bool {
    if listing.mode == ListingMode::Accept {
        seller_holds(listing, info)
    } else {
        can_deliver(listing, listing_key, info)
    }
}

/// True if revoking is both possible and only removes this listing's delegate.
pub fn delegate_is_ours(listing: &Listing, listing_key: Pubkey, info: &AccountInfo) -> bool {
    match read_token(listing, info) {
        Some(t) => t.owner == listing.seller && !t.frozen && t.delegate == Some(listing_key),
        None => false,
    }
}

/// Lowest valid next bid: the top bid plus 2% (rounded up) or 0.001 SOL,
/// whichever is larger. With the extension cap this prices out running the clock.
pub fn minimum_next_bid(top_bid: u64) -> Result<u64> {
    let raise = top_bid.div_ceil(50).max(MIN_PRICE_LAMPORTS);
    Ok(top_bid.checked_add(raise).ok_or(SidebidError::Overflow)?)
}

/// Whether crediting `amount` to `dest` can pass the runtime's checks. A failed
/// credit fails the whole transaction, so without this one unpayable account
/// could freeze an auction: an executable account refuses lamport changes, and
/// an account must end the transaction rent exempt.
pub fn can_receive(dest: &AccountInfo, amount: u64) -> Result<bool> {
    let post = match dest.lamports().checked_add(amount) {
        Some(post) => post,
        None => return Ok(false),
    };
    Ok(dest.is_writable && !dest.executable && Rent::get()?.is_exempt(post, dest.data_len()))
}

fn check_credit_address(credit: &AccountInfo, listing_key: Pubkey, owner: &Pubkey) -> Result<()> {
    let (expected, _) = Pubkey::find_program_address(
        &[CREDIT_SEED, listing_key.as_ref(), owner.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(credit.key(), expected, SidebidError::BadCreditAccount);
    Ok(())
}

/// Pays out of the vault to `dest`, or parks the SOL in `dest`'s credit account
/// (a system owned PDA, the lamports are the record) if `dest` cannot receive.
pub fn pay<'info>(
    vault: &AccountInfo<'info>,
    vault_seeds: &[&[u8]],
    dest: &AccountInfo<'info>,
    credit: &AccountInfo<'info>,
    listing_key: Pubkey,
    amount: u64,
    system: &Program<'info, System>,
) -> Result<()> {
    let to = if can_receive(dest, amount)? {
        dest
    } else {
        check_credit_address(credit, listing_key, dest.key)?;
        emit!(CreditParked {
            listing: listing_key,
            owner: dest.key(),
            amount,
        });
        credit
    };
    system_program::transfer(
        CpiContext::new_with_signer(
            system.key(),
            Transfer {
                from: vault.clone(),
                to: to.clone(),
            },
            &[vault_seeds],
        ),
        amount,
    )
}

/// Moves exactly the listing's amount with the listing PDA as delegate.
pub fn deliver_tokens<'info>(
    listing: &Account<'info, Listing>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    token_program: Pubkey,
) -> Result<()> {
    let bump = [listing.bump];
    let seeds: &[&[u8]] = &[LISTING_SEED, listing.token_account.as_ref(), &bump];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            token_program,
            TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: listing.to_account_info(),
            },
            &[seeds],
        ),
        listing.amount,
        listing.decimals,
    )
}

/// Closes the listing. Rent goes to the seller, or their credit if unpayable.
pub fn close_listing_account<'info>(
    listing: &mut Account<'info, Listing>,
    seller: &AccountInfo<'info>,
    seller_credit: &AccountInfo<'info>,
) -> Result<()> {
    let key = listing.key();
    let target = if can_receive(seller, listing.to_account_info().lamports())? {
        seller
    } else {
        check_credit_address(seller_credit, key, seller.key)?;
        seller_credit
    };
    listing.close(target.clone())
}

#[allow(clippy::too_many_arguments)]
pub fn execute_fixed_buy<'info>(
    listing: &mut Account<'info, Listing>,
    buyer: &Signer<'info>,
    seller: &AccountInfo<'info>,
    seller_credit: &AccountInfo<'info>,
    seller_token: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    buyer_token: &AccountInfo<'info>,
    token_program: Pubkey,
    system: &Program<'info, System>,
    expected_price: u64,
    expected_amount: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let key = listing.key();
    require!(listing.state == ListingState::Live, SidebidError::NotLive);
    require!(listing.mode == ListingMode::Fixed, SidebidError::WrongMode);
    require!(
        listing.price == expected_price && listing.amount == expected_amount,
        SidebidError::ListingChanged
    );
    require!(
        listing.end_time == 0 || now < listing.end_time,
        SidebidError::ListingExpired
    );
    require!(
        can_deliver(listing, key, seller_token),
        SidebidError::SellerTokensUnavailable
    );

    deliver_tokens(listing, seller_token, mint, buyer_token, token_program)?;

    let to = if can_receive(seller, listing.price)? {
        seller
    } else {
        check_credit_address(seller_credit, key, seller.key)?;
        emit!(CreditParked {
            listing: key,
            owner: seller.key(),
            amount: listing.price,
        });
        seller_credit
    };
    system_program::transfer(
        CpiContext::new(
            system.key(),
            Transfer {
                from: buyer.to_account_info(),
                to: to.clone(),
            },
        ),
        listing.price,
    )?;
    emit!(Bought {
        listing: key,
        buyer: buyer.key(),
        seller: seller.key(),
        amount: listing.amount,
        price: listing.price,
    });
    close_listing_account(listing, seller, seller_credit)
}

pub const PASS_DOMAIN: &[u8; 16] = b"SIDEBID_PASS_V1\0";
pub const PASS_MESSAGE_LEN: usize = 16 + 32 + 32 + 32 + 32 + 8;

/// domain | program id | campaign | buyer | x id hash | expiry (i64 LE).
pub fn pass_message(
    campaign: &Pubkey,
    buyer: &Pubkey,
    x_id_hash: &[u8; 32],
    expiry: i64,
) -> [u8; PASS_MESSAGE_LEN] {
    let mut m = [0u8; PASS_MESSAGE_LEN];
    m[..16].copy_from_slice(PASS_DOMAIN);
    m[16..48].copy_from_slice(crate::ID.as_ref());
    m[48..80].copy_from_slice(campaign.as_ref());
    m[80..112].copy_from_slice(buyer.as_ref());
    m[112..144].copy_from_slice(x_id_hash);
    m[144..152].copy_from_slice(&expiry.to_le_bytes());
    m
}

/// Requires the previous instruction to be a one-signature ed25519 verify whose
/// offsets all point inside itself at the exact standard layout. Reading the
/// key and message without checking the offsets is the classic hole: the
/// precompile would have verified bytes held somewhere else.
pub fn verify_pass_ed25519(
    instructions: &AccountInfo,
    signer: &Pubkey,
    message: &[u8; PASS_MESSAGE_LEN],
) -> Result<()> {
    const HEADER: usize = 16;
    const PUBKEY_AT: usize = HEADER;
    const SIG_AT: usize = PUBKEY_AT + 32;
    const MSG_AT: usize = SIG_AT + 64;
    const THIS_INSTRUCTION: u16 = u16::MAX;

    let current = load_current_index_checked(instructions)?;
    let previous = current.checked_sub(1).ok_or(SidebidError::BadPass)?;
    let ix = load_instruction_at_checked(previous as usize, instructions)?;
    require_keys_eq!(ix.program_id, ed25519_program::ID, SidebidError::BadPass);
    require!(ix.accounts.is_empty(), SidebidError::BadPass);
    let d = &ix.data;
    require!(d.len() == MSG_AT + PASS_MESSAGE_LEN, SidebidError::BadPass);
    require!(d[0] == 1 && d[1] == 0, SidebidError::BadPass);
    let field = |i: usize| u16::from_le_bytes([d[2 + i * 2], d[3 + i * 2]]);
    require!(
        field(0) as usize == SIG_AT
            && field(1) == THIS_INSTRUCTION
            && field(2) as usize == PUBKEY_AT
            && field(3) == THIS_INSTRUCTION
            && field(4) as usize == MSG_AT
            && field(5) as usize == PASS_MESSAGE_LEN
            && field(6) == THIS_INSTRUCTION,
        SidebidError::BadPass
    );
    require!(&d[PUBKEY_AT..SIG_AT] == signer.as_ref(), SidebidError::BadPass);
    require!(&d[MSG_AT..] == message.as_slice(), SidebidError::BadPass);
    Ok(())
}
