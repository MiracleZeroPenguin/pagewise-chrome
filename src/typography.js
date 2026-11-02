const OWN = '#pagewise-root,[data-pagewise-translation],[data-pagewise-owned]';
const SKIP = `${OWN},nav,header,footer,aside,form,button,[hidden],[aria-hidden="true"],[role="navigation"]`;
export const normalizeFontSize = value => Math.min(22, Math.max(14, Number(value) || 16));

export function sourceFontSize(element) {
  const win = element?.ownerDocument.defaultView;
  for (let node = element; node && win; node = node.parentElement) {
    const size = parseFloat(win.getComputedStyle(node).fontSize);
    if (size > 0) return normalizeFontSize(size);
  }
  return 16;
}

export function readingFontSize(doc) {
  const root = doc.querySelector('article,main,[role="main"]') || doc.body;
  if (!root) return 16;
  const samples = [], visibility = new Map();
  function visible(node) {
    if (!node) return true;
    if (visibility.has(node)) return visibility.get(node);
    const css = doc.defaultView.getComputedStyle(node);
    const result = css.display !== 'none' && !['hidden','collapse'].includes(css.visibility) && visible(node.parentElement);
    visibility.set(node, result);
    return result;
  }
  for (const node of root.querySelectorAll('p,li,blockquote,td,pre')) {
    if (node.closest(SKIP) || !visible(node)) continue;
    const length = node.textContent.trim().length;
    if (length < 20 || node.querySelector('p,li,blockquote,td,pre')) continue;
    samples.push({size:sourceFontSize(node), weight:Math.min(length, 500)});
    if (samples.length >= 60) break;
  }
  if (!samples.length) return sourceFontSize(root);
  samples.sort((a,b) => a.size - b.size);
  const half = samples.reduce((sum, sample) => sum + sample.weight, 0) / 2;
  let weight = 0;
  for (const sample of samples) { weight += sample.weight; if (weight >= half) return sample.size; }
}

export function watchTypography(doc, measure, onChange) {
  const win = doc.defaultView;
  let previous, pending, disposed = false;
  function update() {
    pending = null;
    if (disposed) return;
    const size = measure();
    if (size !== previous) { previous = size; onChange(size); }
  }
  function schedule() {
    if (!pending && !disposed) pending = win.setTimeout(update, 40);
  }
  const owned = node => (node.nodeType === 1 ? node : node.parentElement)?.closest(OWN);
  const observer = new win.MutationObserver(records => {
    if (records.some(record => !owned(record.target) && !(record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(owned)))) schedule();
  });
  observer.observe(doc.documentElement, {subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden']});
  win.addEventListener('resize', schedule);
  win.visualViewport?.addEventListener('resize', schedule);
  doc.addEventListener('load', schedule, true);
  update();
  return () => {
    disposed = true; observer.disconnect(); win.clearTimeout(pending);
    win.removeEventListener('resize', schedule);
    win.visualViewport?.removeEventListener('resize', schedule);
    doc.removeEventListener('load', schedule, true);
  };
}
