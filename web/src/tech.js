// The technology content: SVG diagrams styled by the site CSS, the engine chapters and the docs. Built from the
// runtime config, so names, handles and addresses change without a rebuild. Diagram labels are generic on purpose.
import { icon, sol, short, esc } from './fmt.js'

let DGN = 0
const arrowDefs = (id) => `<defs><marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" class="dg-head"/></marker><marker id="${id}h" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" class="dg-head hot"/></marker></defs>`
const svgOpen = (w, h, label, id) => `<svg class="dg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${label}">${arrowDefs(id)}`
const box = (x, y, w, h, t, s, cls = '') => `<g class="dg-node ${cls}"><rect class="dg-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/><text class="dg-l" x="${x + 14}" y="${y + 26}">${t}</text>${s ? `<text class="dg-s" x="${x + 14}" y="${y + 46}">${s}</text>` : ''}</g>`
const line = (d, id, hot) => `<path class="dg-line ${hot ? 'dg-flow' : ''}" d="${d}" marker-end="url(#${id}${hot ? 'h' : ''})"/>`
const tx = (x, y, t, cls = 'dg-s', a = 'start') => `<text class="${cls}" x="${x}" y="${y}" text-anchor="${a}">${t}</text>`
const xName = (B) => (B.xHandle ? '@' + B.xHandle : 'our X account')

// Worked example for the chart math: 3.84% of supply, 21.4 SOL of chart value, a 30 SOL pool
export const EXAMPLE = { chart: 21.4, pool: 30 }
export const chartMath = (v, r) => ({ get: (v * r) / (r + v), drop: (1 - (r / (r + v)) ** 2) * 100 })

export const DIAGRAMS = {
  atomic() {
    const id = 'mk' + DGN++
    return svgOpen(600, 300, 'Settle moves tokens and SOL in one transaction', id) +
      `<rect class="dg-frame" x="14" y="14" width="572" height="272" rx="12"/>` + tx(32, 42, 'ONE TRANSACTION', 'dg-k') + tx(568, 42, 'settle()', 'dg-m', 'end') +
      box(40, 70, 170, 74, 'Seller wallet', 'the listed tokens') + box(390, 70, 170, 74, 'Winner wallet', 'top bidder') + box(215, 196, 170, 70, 'Bid vault', 'top bid, held', 'hot') +
      line('M212 100H386', id, 1) + tx(299, 90, 'tokens, transfer_checked', 'dg-s', 'middle') +
      line('M214 232C140 232 125 200 125 148', id, 1) + tx(42, 214, 'SOL to the seller', 'dg-s') +
      tx(568, 262, 'Both legs land,', 'dg-s', 'end') + tx(568, 278, 'or neither does.', 'dg-s', 'end') + '</svg>'
  },
  wallet() {
    const id = 'mk' + DGN++
    const ph = [[150, 'Listed'], [270, 'Bidding'], [390, 'Ends'], [500, 'Settled']]
    return svgOpen(600, 270, 'Tokens stay in the seller wallet until the sale completes', id) +
      `<rect class="dg-box dash" x="150" y="16" width="430" height="36" rx="6"/>` + tx(164, 39, 'Approval: the listing may move exactly the listed amount', 'dg-s') +
      tx(20, 96, 'Your wallet', 'dg-l') + tx(20, 186, 'Winner', 'dg-l') +
      `<path class="dg-line mute" d="M130 92H580M130 182H580"/>` +
      ph.map(([x, n]) => `<path class="dg-tick" d="M${x} 66V206"/>` + tx(x, 232, n, 'dg-s', 'middle')).join('') +
      `<rect class="dg-bar" x="150" y="80" width="350" height="24" rx="4"/>` + tx(162, 97, 'Your tokens, still in your balance', 'dg-bt') +
      `<rect class="dg-bar hot" x="500" y="170" width="80" height="24" rx="4"/>` + line('M500 106V164', id, 1) +
      tx(20, 260, 'Move the tokens or cancel before the end and the listing turns Gone. The bidder is refunded.', 'dg-s') + '</svg>'
  },
  clock() {
    const id = 'mk' + DGN++
    const blocks = [0, 1, 2, 3].map((i) => `<rect class="dg-bar ${i === 3 ? 'hot' : ''}" x="${330 + i * 40}" y="96" width="37" height="28" rx="3"/>` + tx(348.5 + i * 40, 115, '+15s', 'dg-bt', 'middle')).join('')
    return svgOpen(600, 270, 'Late bids add 15 seconds, capped at 5 minutes extra', id) +
      `<path class="dg-line mute" d="M30 110H570"/>` + `<rect class="dg-zone" x="300" y="70" width="30" height="80"/>` + tx(315, 62, 'last 15s', 'dg-s', 'middle') +
      `<path class="dg-tick" d="M330 70V160M566 70V160"/>` + tx(330, 178, 'original end', 'dg-s', 'middle') + tx(566, 178, 'hard end', 'dg-s', 'end') +
      tx(30, 100, 'countdown', 'dg-s') + blocks + `<path class="dg-line dash" d="M492 110H562"/>` + tx(528, 100, 'up to 5 min', 'dg-s', 'middle') +
      [0, 1, 2].map((i) => `<circle class="dg-dot" cx="${306 + i * 9}" cy="138" r="4"/>`).join('') + tx(30, 142, 'late bids', 'dg-s') +
      tx(30, 214, 'Minimum raise', 'dg-l') + ['1.000', '1.020', '1.041'].map((v, i) => `<rect class="dg-box ${i === 2 ? 'hot' : ''}" x="${180 + i * 140}" y="196" width="96" height="32" rx="16"/>` + tx(228 + i * 140, 217, v + ' SOL', 'dg-m', 'middle') + (i < 2 ? line(`M${280 + i * 140} 212H${316 + i * 140}`, id) + tx(298 + i * 140, 246, '+2%', 'dg-s', 'middle') : '')).join('') +
      tx(30, 262, 'or 0.001 SOL, whichever is larger', 'dg-s') + '</svg>'
  },
  post(B) {
    const id = 'mk' + DGN++
    return svgOpen(600, 310, 'Listing by posting on X', id) +
      box(14, 30, 174, 74, 'Post on X', (B.xHandle ? '@' + B.xHandle : 'tag us') + ' sell…') + box(213, 30, 174, 74, 'Wallet checked', 'holds the tokens?') + box(412, 30, 174, 74, 'Card goes live', 'countdown starts') +
      line('M190 67H209', id, 1) + line('M389 67H408', id, 1) + line('M499 106V140', id, 1) +
      box(412, 144, 174, 64, 'Accept window', '10 minutes') +
      box(412, 236, 174, 64, 'Seller signs once', 'swap happens', 'hot') + box(213, 236, 174, 64, 'No accept', 'Seller ghosted, refund') +
      line('M499 210V232', id, 1) + line('M410 190C330 190 300 205 300 232', id) +
      tx(14, 150, 'No signature to list.', 'dg-s') + tx(14, 170, 'A post alone can never', 'dg-s') + tx(14, 190, 'move tokens.', 'dg-s') + '</svg>'
  },
  pass() {
    const id = 'mk' + DGN++
    return svgOpen(600, 300, 'One deal per X account checked on chain', id) +
      `<rect class="dg-frame" x="14" y="14" width="356" height="200" rx="12"/>` + tx(30, 40, "BUYER'S TRANSACTION", 'dg-k') + tx(354, 40, 'buyer signs alone', 'dg-s', 'end') +
      box(32, 56, 320, 66, 'ed25519 verify', 'server pass: listing, buyer, X id hash, expiry') + box(32, 134, 320, 64, 'buy_fixed_with_pass', 'reads the pass through the instructions sysvar', 'hot') +
      line('M354 166H410', id, 1) + box(414, 128, 172, 76, 'Claim account', 'campaign + X id hash') + tx(428, 194, '+ pass signer', 'dg-s') +
      `<path class="dg-line dash" d="M32 256H360"/>` + tx(32, 246, 'Second try from the same X account, any wallet', 'dg-s') +
      line('M360 256H410', id) + `<g class="dg-node"><rect class="dg-box no" x="414" y="232" width="172" height="48" rx="6"/></g>` + tx(500, 262, 'fails on chain', 'dg-l', 'middle') + '</svg>'
  },
  bot() {
    const id = 'mk' + DGN++
    return svgOpen(600, 270, 'The sale bot settles at the end time', id) +
      `<path class="dg-line mute" d="M30 140H200"/>` + tx(30, 128, 'countdown', 'dg-s') + `<circle class="dg-dot hot" cx="200" cy="140" r="7"/>` + tx(200, 172, 'end time', 'dg-s', 'middle') +
      line('M208 140C250 140 250 70 296 70', id, 1) + line('M208 140C250 140 250 206 296 206', id) +
      box(300, 36, 286, 70, 'settle(), within seconds', 'tokens to winner, SOL to seller', 'hot') + box(300, 172, 286, 70, 'refund()', 'seller moved tokens: bid back, Gone') +
      tx(30, 236, 'No signature needed.', 'dg-s') + tx(30, 254, 'Winners can settle with one tap.', 'dg-s') + '</svg>'
  },
  cost() {
    const c = chartMath(EXAMPLE.chart, EXAMPLE.pool), here = EXAMPLE.chart * 0.86, id = 'mk' + DGN++
    const pre = 'M20 120L50 112L80 118L110 104L140 110L170 98L200 102'
    return svgOpen(600, 270, 'Selling on the chart against selling here', id) +
      tx(20, 30, 'ON THE CHART', 'dg-k') + tx(320, 30, 'HERE', 'dg-k') +
      `<path class="dg-line mute" d="M20 210H280M320 210H580"/>` +
      `<path class="dg-chart" d="${pre}L206 196L240 192L280 198"/>` + `<path class="dg-drop" d="M206 102V196"/>` + tx(214, 156, `drops ${Math.round(c.drop)}%`, 'dg-l') +
      `<path class="dg-chart" d="${pre.replace(/M20/, 'M320').replace(/L(\d+)/g, (m, x) => 'L' + (+x + 300))}L540 100L580 104"/>` + `<circle class="dg-dot hot" cx="506" cy="102" r="7"/>` + tx(506, 84, 'sale', 'dg-s', 'middle') +
      tx(20, 244, `You get about ${sol(c.get)} SOL`, 'dg-l') + tx(320, 244, `You get ${sol(here)} SOL, chart flat`, 'dg-l hotT') + '</svg>'
  },
}

export const WHY = (B) => [
  { id: 'atomic', k: 'Settlement', h: 'One transaction, or nothing happens.', d: 'atomic',
    p: ['When a countdown ends, the contract runs settle. In that single Solana transaction it moves the tokens from the seller to the winner with transfer_checked and pays the SOL from the bid vault to the seller. If any part fails, the transaction fails and nothing moves.', 'There is no moment where one side has paid and the other has not, and no middleman holding either side in between.'],
    f: [['settle', '18,913 compute units'], ['Token programs', 'SPL Token and Token 2022'], ['Signer', 'nobody needed']] },
  { id: 'wallet', k: 'Custody', h: 'Your tokens never leave your wallet early.', d: 'wallet',
    p: ['Listing is one approval. The listing gets permission to move exactly the amount you chose, of that one coin, and nothing more. The tokens stay in your wallet and in your balance until the sale completes.', 'Change your mind and cancel any time before the countdown ends, or while there is no bid. After the end, moving the tokens still stops the sale: the listing turns Gone and the top bidder is refunded in full.'],
    f: [['Approval', 'one amount, one coin'], ['create_listing', '35,599 compute units'], ['Cancel', 'before the end, or while there is no bid']] },
  { id: 'clock', k: 'Live auction', h: 'A real auction with a fair ending.', d: 'clock',
    p: ['Bids land live against a countdown, 5 minutes by default. A bid in the last 15 seconds adds 15 seconds, so nobody wins by sniping the final block, and the extra time stops at 5 minutes so every auction ends.', 'Each raise must beat the top bid by 2% or 0.001 SOL, whichever is larger. The bidder you outbid is repaid inside the same transaction as your bid.'],
    f: [['Extra time', '15 seconds a late bid'], ['Cap', '5 minutes past the original end'], ['Minimum raise', '2% or 0.001 SOL']] },
  { id: 'post', k: 'List from X', h: 'List by posting on X.', d: 'post',
    p: [`Link your wallet once, then post the amount, the CA and your settings to ${xName(B)}. The amount is a number, a percent like 50%, or all. If the linked wallet holds those tokens on chain, the card goes live with no signature and we reply with its link.`, 'When the countdown ends you get a second reply. You have 10 minutes to accept the top bid by signing once, and the swap happens in that signature. No accept means Seller ghosted and a full refund.'],
    f: [['Accept window', '10 minutes'], ['Wallet change', 'waits 48 hours'], ['A post alone', 'can never move tokens']] },
  { id: 'pass', k: 'Fair drops', h: 'One deal per X account, enforced on chain.', d: 'pass',
    p: ['Fixed price drops can be limited to one per X account. Our server signs a pass naming the listing, your wallet, a hash of your X id and an expiry. Your transaction carries that signature through Solana’s ed25519 program, and the contract reads it before the buy.', 'The buy creates a claim account from the campaign and your X id hash. A second claim from the same X account fails on chain, from any wallet. You stay the only signer.'],
    f: [['Pass check', 'ed25519 program'], ['buy_fixed_with_pass', '35,356 compute units'], ['Claim', 'permanent, never closed']] },
  { id: 'bot', k: 'Sale bot', h: 'The sale settles itself at the end time.', d: 'bot',
    p: ['Our sale bot calls settle within a few seconds of a countdown ending. Settle needs nobody’s signature, so if the bot is ever slow, anyone can press one button and settle it.', 'If the seller moved the tokens, settle cannot complete, and the bot calls refund instead. The bidder gets every lamport back and the card shows Gone.'],
    f: [['Settle', 'within seconds of the end'], ['refund', '13,213 compute units'], ['Stuck bid', 'refundable 24 hours after the end']] },
  { id: 'cost', k: 'The math', h: 'What selling on the chart would cost.', d: 'cost',
    p: [`Selling a big amount into a pool walks the price down with every token. Tokens worth ${sol(EXAMPLE.chart)} SOL at chart price, sold into a ${EXAMPLE.pool} SOL pool, returns about ${sol(chartMath(EXAMPLE.chart, EXAMPLE.pool).get)} SOL and drops the price around ${Math.round(chartMath(EXAMPLE.chart, EXAMPLE.pool).drop)}%.`, 'Here the same tokens sell for the top bid, and no trade touches the pool. When the chart price is known, every listing shows this estimate next to the top bid.'],
    f: [['Estimate', 'constant product pool'], ['Pool trades', 'none'], ['Fee to sell', 'none']] },
]
/** Test counts come from the runtime config, so a reader who runs the suites sees the same numbers. Missing means not shown. */
export const PROOF = (F) => [
  F?.contractTests ? { n: String(F.contractTests), k: 'contract tests', p: 'Every instruction, every refusal, both token programs.' } : null,
  F?.serverTests ? { n: String(F.serverTests), k: 'server tests', p: 'The sale bot, X listing, passes and the reward split.' } : null,
].filter(Boolean)

export const steps = (items) => `<ol class="d-steps">${items.map(([h, p]) => `<li><b>${h}</b><p>${p}</p></li>`).join('')}</ol>`
export const addr = (label, v, none = 'Published at launch') => v ? `<div class="d-addr"><span>${label}</span><button class="num" data-act="copy" data-copy="${v}"><span class="addr-full">${v}</span>${icon('copy')}</button></div>` : `<div class="d-addr"><span>${label}</span><button class="num" disabled><span class="addr-full">${none}</span></button></div>`
/** Who holds the upgrade key: the chain's answer once the program is on chain; before the deploy, the key named in UPGRADE_AUTHORITY, if any. */
export const upKey = (T, K) => { const u = T?.upgrade; return u?.state === 'revoked' ? null : u?.state === 'squads' || u?.state === 'key' ? u.authority ?? null : u?.authority ?? K?.upgradeAuthority ?? null }
const facts = (rows) => `<dl class="d-facts">${rows.map(([a, b]) => `<div><dt>${a}</dt><dd>${b}</dd></div>`).join('')}</dl>`
const IX = [
  ['create_listing', 'seller', 'Opens a bidding or fixed listing and approves the listing for exactly that amount.', '35,599'],
  ['create_accept_listing', 'server listing key', 'Opens a card listed by X post. No seller signature, no approval.', '30,961'],
  ['place_bid', 'bidder', 'Takes the new top bid into the vault and repays the last bidder in the same transaction.', '16,141'],
  ['settle', 'nobody needed', 'After the end: tokens to the winner, SOL to the seller, one transaction.', '18,913'],
  ['accept', 'seller', 'Accept window: tokens to the winner, SOL to the seller.', '20,526'],
  ['refund', 'nobody needed', 'Bidder gets all SOL back. Listing becomes Gone or Seller ghosted.', '13,213'],
  ['cancel', 'seller', 'Before the end: repays the bidder, removes the approval, closes the listing.', '16,453'],
  ['buy_fixed', 'buyer', 'First buyer takes a fixed listing: SOL to seller, tokens to buyer.', '17,377'],
  ['buy_fixed_with_pass', 'buyer', 'Same, with a server pass. Creates the claim that blocks a second use.', '35,356'],
  ['close_listing', 'nobody needed', 'Closes a finished listing. Rent goes back to whoever paid it.', '9,480'],
  ['claim_credit', 'credit owner', 'Pays out SOL that could not be paid to an account directly.', '11,035'],
]
const hrs = (s) => (s >= 3600 ? (s % 3600 ? (s / 3600).toFixed(1) : s / 3600) + ' hours' : Math.max(1, Math.round(s / 60)) + ' minutes')
/** The upgrade sentence for the state read from chain, and only that state. */
export function upgradeLine(T) {
  const u = T?.upgrade
  if (u?.state === 'undeployed') return 'Program deploys at launch. Who can upgrade it is read from chain from then.'
  if (!u || u.state === 'unknown') return 'The contract can be changed by the team’s upgrade key. Its upgrade authority is shown on the explorer.'
  if (u.state === 'revoked') return 'The upgrade authority is revoked. The contract can no longer be upgraded.'
  if (u.state === 'squads') {
    const who = `The contract can be changed by the team’s multisig${u.threshold && u.members ? `, ${u.threshold} of ${u.members} approvals` : ''}.`
    // A settings key on the multisig can change the members and the lock at once, so the lock promises nothing
    if (u.autonomous !== true) return `${who} ${u.lockSecs > 0 ? `It has a ${lockText(u)} lock, but its` : 'Its'} settings key can change the members and the lock at once, so a change does not have to wait.`
    return u.lockSecs > 0 ? `${who} Every change waits ${hrs(u.lockSecs)} in public first.` : `${who} A change does not have to wait.`
  }
  return 'The contract can be changed by the team’s upgrade key.'
}
/** The lock as an adjective: "48 hour". */
export const lockText = (u) => (u?.lockSecs > 0 ? hrs(u.lockSecs).replace(/s$/, '') : null)

export const DOCS = (C, T) => {
  const B = C.brand, K = C.keys, xn = xName(B), xt = '@' + (B.xHandle || 'sidebidsol'), gh = B.github, F = C.facts ?? {}, U = upgradeLine(T)
  return [
    ['Start', [
      ['what', `What ${esc(B.name)} is`, `<p class="lead">${esc(B.name)} is a live auction house for Solana tokens. A holder lists any amount of a coin, the full balance by default. Buyers bid in SOL against a countdown, and the best bid takes every token listed in one transaction.</p>
        <p>The sale never touches a pool, so it does not move the chart. The seller gets a price set by real bidders, buyers get size without paying slippage, and every step is a public transaction anyone can check.</p>
        <p>Browsing needs nothing. To bid, all you need is a wallet. To list, connect a wallet too. Signing in with X is optional: it shows your handle and picture on your cards and lets you list by posting on X.</p>`],
      ['sell3', 'Sell in three steps', steps([
        ['Pick the coin and amount', 'Connect and pick a coin from your wallet. The full balance is filled in. Tap 25%, 50% or 75%, or type an exact amount. The form always shows the exact count, like Selling 150,000,000 of 300,000,000.'],
        ['Set your terms', 'Live auction with an optional minimum and a length the site offers from 2 minutes to 1 hour, 5 minutes by default. Or Fixed price, where the first buyer takes it.'],
        ['Sign once', 'You approve one amount of one coin. Your tokens stay in your wallet. The card goes live and you get a post ready to share. You can cancel before the countdown ends, or any time while there is no bid.'],
      ])],
      ['bid3', 'Bid in three steps', steps([
        ['Open a card', 'Check the seller, the amount, and the coin checks on the card.'],
        ['Place a bid', 'Enter an amount in SOL and sign. Your SOL moves into the contract. If someone outbids you, it comes back in that same transaction.'],
        ['Win or get refunded', 'If yours is the top bid when the countdown ends, the tokens land in your wallet and your SOL goes to the seller, together.'],
      ])],
    ]],
    ['Rules', [
      ['ends', 'How an auction ends', `<p>The highest bid when the countdown ends wins. After the end time anyone can trigger the sale, and our sale bot does it within a few seconds. Tokens go to the winner and SOL goes to the seller in one transaction, or nothing happens.</p>
        <p>If the sale cannot complete because the seller moved the tokens or removed permission, the card is marked Gone and the top bidder gets all their SOL back.</p><p>There is no limit on bids per account. Bots can bid, and bots can win.</p>`],
      ['extra', 'Late bids and raises', steps([
        ['Late bids add time', 'A bid in the last 15 seconds adds 15 seconds to the countdown.'],
        ['Extra time has a ceiling', 'A listing can run at most 5 minutes past its original end. After that the countdown always finishes.'],
        ['Every raise has a minimum', 'A new bid must beat the top bid by at least 2% or 0.001 SOL, whichever is larger. The lowest bid anywhere is 0.001 SOL.'],
      ])],
      ['fixed', 'Fixed price', `<p>The seller names one price. The first buyer to sign takes every token listed at that price, no less and no more. The buyer signs alone, and SOL and tokens swap in that one transaction.</p><p>A fixed listing runs up to 30 days or has no expiry.</p>`],
      ['oneper', 'One per X account', `<p>Some fixed price drops allow one purchase per X account. Our server gives you a short lived pass tied to your wallet and a hash of your X id. The contract checks the pass and records a claim. A second claim from the same X account fails on chain, whatever wallet it comes from.</p><p>The X id is hashed with a secret key kept on our server before it goes into the pass, so the claim on chain does not spell out your X id. It is built to be fair first.</p>`],
      ['post', 'Listing by posting on X', steps([
        ['Link once', 'Sign in with X here and link a wallet. Changing a linked wallet later waits 48 hours.'],
        [`Post to ${xn}`, `Include the amount, the CA and your settings. The amount is an exact number like 1m, a percent like 50%, or all for the full balance. A percent is worked out from your linked wallet when we read the post, and the card and our reply show the exact token count. Examples: <code>${xt} sell 50% CA min 1 sol 10m</code>, <code>${xt} sell 2.5m CA</code>, <code>${xt} sell all CA 1h</code>. If your linked wallet holds those tokens on chain, the card goes live and we reply with its link. If not, nothing happens. Posts we cannot read, and accounts under the minimum age, are ignored.`],
        ['Accept within 10 minutes', `When the countdown ends, ${xn} replies again. Sign once to accept the top bid and the swap happens in that signature. If you don’t, the card shows Seller ghosted and the bid is refunded. Cards listed by post cannot be cancelled.`],
      ])],
    ]],
    ['Fees and rewards', [
      ['fee', 'What it costs', `<p>${esc(B.name)} takes no fee on sales. Sellers receive the full winning bid. You pay normal Solana network fees, and each listing locks 0.0031 SOL of rent that comes back when it closes. A one per X account claim costs the buyer about 0.00095 SOL of rent, kept for good.</p>`],
      ['rewards', 'Hourly seller rewards', `<p>Every hour the creator fees from $${esc(B.ticker)} trading are claimed. 90% goes to the top 3 sellers of that hour, ranked by SOL received from completed sales, split 50, 30 and 20. The other 10% goes to the team.</p>
        ${facts([['First place', '50% of the seller pot'], ['Second place', '30% of the seller pot'], ['Third place', '20% of the seller pot'], ['When', 'on the hour, every hour']])}
        <p>The claim and all three payouts are public transactions, linked on the Rewards page. Selling to your own second wallet counts today. Limits may be added later if the split is being gamed.</p>`],
    ]],
    ['Technology', [
      ['contract', 'The contract', `<p>The contract is an Anchor program on Solana. It holds every rule above: listings, bids, settlement, refunds, passes and claims. No instruction takes a fee or pauses anything, and there is no config account. ${U}</p>
        <p>Each listing is its own account. Bid SOL sits in a vault address owned by that listing, and only the top bid is held. The seller’s tokens stay in the seller’s wallet under an approval for exactly the listed amount.</p>
        <p>SPL Token and Token 2022 both work through transfer_checked. Token 2022 coins are limited to the metadata and group extensions; transfer fees, hooks, permanent delegates and the rest are refused at listing.</p>`],
      ['ix', 'Instructions', `<div class="d-tablewrap scrollx"><table class="d-table"><thead><tr><th>Instruction</th><th>Who signs</th><th>What it does</th><th class="r">Compute</th></tr></thead><tbody>${IX.map(([a, b, c, d]) => `<tr><td class="num">${a}</td><td>${b}</td><td>${c}</td><td class="r num">${d}</td></tr>`).join('')}</tbody></table></div><p class="d-note">Highest compute seen over 15 measured runs. The site sets each transaction’s compute limit from a simulation run just before you sign.</p>`],
      ['bot', 'The sale bot', `<p>The server watches every listing. Within a few seconds of a countdown ending it sends settle. If settle cannot complete because the seller moved the tokens, it sends refund. On a card listed by post it waits out the 10 minute accept window, then refunds.</p><p>Settle and refund need nobody’s signature, so the bot is a convenience, not a gatekeeper. Anyone can settle with one tap on the card, and any bid can be refunded by anyone 24 hours after the end.</p>`],
      ['credits', 'Credits', `<p>If an account cannot be paid directly, its SOL is parked at a credit address only it can claim, so nobody can freeze an auction by breaking their own account. The site lists your credits under your account and on the card, and claims them with one tap.</p>`],
      ['tests', 'Tests', `${facts([...(F.contractTests ? [['Contract tests', String(F.contractTests)]] : []), ...(F.serverTests ? [['Server tests', String(F.serverTests)]] : [])])}<p>The contract and the server each have their own test suite in the repository. Run them yourself. Read the Safety section before you list or bid anything you cannot afford to lose.</p>`],
      ['verify', 'Check the build', `<p>A commit link shows the source, not what is deployed. To check that the deployed program was built from it, build the program from the commit under Source with the Solana verify tool and compare its hash with the hash of the deployed program. Both come from public data, so anyone can run it.</p><p>OtterSec runs the same check in public. When it passes, the Build item on this site reads Verified and links to the result.</p>`],
      ['source', 'Open source', `<p>The contract, the server and this site are open source. Read the code, run both test suites and build the program yourself to check it matches what is deployed.</p><p>${gh ? `<a class="d-link" href="${gh}" target="_blank" rel="noopener">${icon('gh')}GitHub repository</a>` : `<span class="d-link">${icon('gh')}GitHub repository, published at launch</span>`}</p>`],
    ]],
    ['Safety', [
      ['upgrade', 'Who can upgrade it', `<p>${U}</p>${T?.upgrade?.state === 'squads' ? `<p>Any upgrade must be proposed and approved in the multisig first. While an upgrade or a settings change waits, a red banner shows on every page of this site with the time it can run, and the change log lists it.${T.upgrade.autonomous !== true ? ' A change made with the settings key needs no proposal, so no banner warns of it.' : ''}</p>${addr('Multisig', T.upgrade.multisig)}${T.upgrade.configAuthority ? addr('Multisig settings key', T.upgrade.configAuthority) : ''}` : ''}${T?.upgrade?.state === 'revoked' ? '' : addr('Upgrade authority', upKey(T, K), 'Set when the program deploys')}`],
      ['bids', 'Bids cannot be withdrawn', `<p>Once you place a bid, it stays in the contract until you are outbid, the sale completes, or the bid is refunded. You cannot pull it back yourself. If nobody settles, an auction bid can wait until 24 hours after the end, and a bid on a card listed by post waits until the accept window closes.</p>`],
      ['backout', 'A seller can back out', `<p>A seller can back out before the sale completes. Before the countdown ends they can cancel. After it ends they cannot cancel, but moving the tokens or removing the approval still stops the sale, in the moment between the end and settlement. When that happens the top bidder is refunded in full and the card shows Gone. Bidders never lose SOL to a seller backing out, but they can lose the deal.</p>`],
      ['ghost', 'Seller ghosted', `<p>Cards listed by posting on X cannot be cancelled, and need the seller to accept after the countdown. If they do not accept within 10 minutes, or no longer hold the tokens, anyone can trigger a full refund and the card shows Seller ghosted.</p>`],
      ['other', 'Other things to know', steps([
        ['Prices are set by bidders', 'A listing can sell under the chart. Where a chart price is shown, it is an estimate from the pool size, and real pools vary.'],
        ['Check the coin', 'A listing proves the seller holds the tokens. It says nothing about whether the coin is any good. Cards flag coins that still have a freeze or mint authority, read from chain.'],
        ['Leftover approvals', 'If a listing ends while your approval is still set, the site shows a button to remove it. Only you can remove it.'],
      ])],
    ]],
    ['Reference', [
      ['program', 'Addresses', addr('Program', C.chain.programId) + (T?.upgrade?.state === 'revoked' ? '<div class="d-addr"><span>Upgrade key</span><button class="num" disabled><span class="addr-full">Revoked</span></button></div>' : addr('Upgrade key', upKey(T, K), 'Set when the program deploys')) + addr('Pass signer', K.passSigner) + addr('Creator fee wallet', K.devWallet) + addr(`$${esc(B.ticker)} CA`, B.ca)],
      ['numbers', 'Every number in one place', facts([['Default length', '5 minutes'], ['Length', 'the site offers 2 minutes to 1 hour; the contract allows 10 seconds to 1 hour'], ['Late bid window', 'last 15 seconds'], ['Extra time per late bid', '15 seconds'], ['Most extra time', '5 minutes'], ['Minimum raise', '2% or 0.001 SOL'], ['Lowest bid or price', '0.001 SOL'], ['Accept window', '10 minutes'], ['Fixed listing', 'up to 30 days, or no expiry'], ['Refund deadline', '24 hours after the end'], ['Listing rent', '0.0031 SOL, returned'], ['X account', 'any account, no age or follower minimum'], ['Seller rewards', '90% of creator fees, split 50, 30 and 20 every hour']])],
      ['chart', 'What a chart sale costs', `<p>Estimated from a constant product pool. Price drop is how far the chart falls after the sale.</p><div class="d-tablewrap scrollx"><table class="d-table"><thead><tr><th>Amount, share of supply</th><th class="r">Pool</th><th class="r">Chart value</th><th class="r">You get on the chart</th><th class="r">Price drop</th></tr></thead><tbody>${[[1, 20, 5], [2.5, 25, 12], [4, 30, 21.4], [6, 34, 27.9]].map(([p, r, v]) => { const c = chartMath(v, r); return `<tr><td>${p}%</td><td class="r num">${r} SOL</td><td class="r num">${sol(v)} SOL</td><td class="r num">${sol(c.get)} SOL</td><td class="r num">${Math.round(c.drop)}%</td></tr>` }).join('')}</tbody></table></div>`],
    ]],
  ]
}
export { short }
