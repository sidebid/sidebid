// The Solana mark beside every SOL on the site. One sprite holds the official gradient mark; every "SOL" in page text gets
// a small copy of it in front, sized to the text and sitting on its baseline. Done on the DOM as views are drawn, so no
// view can forget it. Text inside drawings, post previews, inputs and the like is left as it is.

/** The official mark: three bars, #00FFA3 to #DC1FFF. Put in the page once. */
export const SOL_SPRITE = '<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs><linearGradient id="solg" x1="360.9" y1="351.5" x2="141.2" y2="-69.3" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#00FFA3"/><stop offset="1" stop-color="#DC1FFF"/></linearGradient></defs><symbol id="solmark" viewBox="0 0 397.7 311.7"><g fill="url(#solg)"><path d="M64.6 237.9c2.4-2.4 5.7-3.8 9.2-3.8h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1l62.7-62.7z"/><path d="M64.6 3.8C67.1 1.4 70.4 0 73.8 0h317.4c5.8 0 8.7 7 4.6 11.1l-62.7 62.7c-2.4 2.4-5.7 3.8-9.2 3.8H6.5c-5.8 0-8.7-7-4.6-11.1L64.6 3.8z"/><path d="M333.1 120.1c-2.4-2.4-5.7-3.8-9.2-3.8H6.5c-5.8 0-8.7 7-4.6 11.1l62.7 62.7c2.4 2.4 5.7 3.8 9.2 3.8h317.4c5.8 0 8.7-7 4.6-11.1l-62.7-62.7z"/></g></symbol></svg>'
export const SOL_ICON = '<svg class="solm" viewBox="0 0 397.7 311.7" aria-hidden="true" focusable="false"><use href="#solmark"/></svg>'

/** A text cut at each SOL: odd parts are the word itself. "SOLD" and "Solana" are not SOL. */
export const solParts = (text) => String(text).split(/\b(SOL)\b/)
/** Where SOL stays plain: drawings, post previews (what gets posted has no logo), form fields and anything marked so. */
const SKIP = 'svg,script,style,textarea,title,option,input,blockquote.post-text,[data-nosol],.solu'

function markText(node) {
  const t = node.nodeValue
  if (!t || t.indexOf('SOL') < 0) return
  const parent = node.parentElement
  if (!parent || parent.closest(SKIP)) return
  const parts = solParts(t)
  if (parts.length < 3) return
  const frag = document.createDocumentFragment()
  parts.forEach((p, i) => {
    if (i % 2 === 0) { if (p) frag.append(p); return }
    const s = document.createElement('span'); s.className = 'solu'; s.innerHTML = SOL_ICON + 'SOL'; frag.append(s)
  })
  node.replaceWith(frag)
}
/** Marks every SOL under a node. */
export function markSol(root) {
  if (root.nodeType === 3) return markText(root)
  if (root.nodeType !== 1 || root.closest?.(SKIP)) return
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), list = []
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes('SOL')) list.push(n)
  list.forEach(markText)
}
/** Keeps marking as views draw: runs before the browser paints, so a SOL never shows without its mark. */
export function watchSol(root = document.body) {
  if (!document.getElementById('solmark')) document.body.insertAdjacentHTML('afterbegin', SOL_SPRITE)
  markSol(root)
  new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') markText(m.target); else m.addedNodes.forEach(markSol) } }).observe(root, { childList: true, subtree: true, characterData: true })
}
