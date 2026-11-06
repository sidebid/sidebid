// Go-live switches read on every use, so they change in seconds with no redeploy, and survive restarts.
// Everything starts off. A kill switch beats its go-live flag.
const KNOWN = ['signinLive', 'readerLive', 'tagListingLive', 'repliesLive', 'keeperLive', 'passLive', 'rewardsLive', 'killReader', 'killKeeper', 'killRewards', 'dropsPaused']
const KEY = 'flags'

export class Flags {
  constructor(db) { this.db = db }
  read() { try { return JSON.parse(this.db.meta(KEY) ?? '{}') } catch { return {} } }
  raw(k) { return this.read()[k] === true }
  get readerOn() { return this.raw('readerLive') && !this.raw('killReader') }
  get taggingOn() { return this.readerOn && this.raw('tagListingLive') }
  get keeperOn() { return this.raw('keeperLive') && !this.raw('killKeeper') }
  get rewardsOn() { return this.raw('rewardsLive') && !this.raw('killRewards') }
  get repliesOn() { return this.raw('repliesLive') }
  get signinOn() { return this.raw('signinLive') }
  get passOn() { return this.raw('passLive') }
  /** The dev drops run once started by the admin call; dropsPaused stops every new listing and post at once. */
  get dropsOn() { return !this.raw('dropsPaused') }
  all() { return Object.fromEntries(KNOWN.map((k) => [k, this.raw(k)])) }
  /** Known switches only, true or false. null clears one back to off. Returns null for anything else. */
  set(next) {
    const cur = this.read()
    for (const [k, v] of Object.entries(next ?? {})) {
      if (!KNOWN.includes(k) || !(v === true || v === false || v === null)) return null
    }
    for (const [k, v] of Object.entries(next ?? {})) { if (v === null) delete cur[k]; else cur[k] = v }
    this.db.setMeta(KEY, JSON.stringify(cur))
    return this.all()
  }
}
