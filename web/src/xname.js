// The site never says Twitter. Privy's sign in window names its X button "Twitter" (its own label, with no option to
// change it), so every text and label that reaches the page with that word reads X instead.
export const xLabel = (t) => String(t).replace(/\bTwitter\b/g, 'X')
const ATTRS = ['aria-label', 'alt', 'title', 'placeholder']
function fixNode(n) {
  if (n.nodeType === 3) { if (n.nodeValue.includes('Twitter') && !n.parentElement?.closest('script,style')) n.nodeValue = xLabel(n.nodeValue); return }
  if (n.nodeType !== 1) return
  const els = [n, ...n.querySelectorAll('*')]
  for (const e of els) for (const a of ATTRS) { const v = e.getAttribute(a); if (v && v.includes('Twitter')) e.setAttribute(a, xLabel(v)) }
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT)
  for (let t = w.nextNode(); t; t = w.nextNode()) if (t.nodeValue.includes('Twitter') && !t.parentElement?.closest('script,style')) t.nodeValue = xLabel(t.nodeValue)
}
export function watchX(root = document.body) {
  fixNode(root)
  new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') fixNode(m.target); else if (m.type === 'attributes') fixNode(m.target); else m.addedNodes.forEach(fixNode) } })
    .observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS })
}
