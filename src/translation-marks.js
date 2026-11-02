import { sourceFontSize, watchTypography } from './typography.js';
const documents = new WeakMap();

export function annotateTranslation(target, card) {
  const doc = card.ownerDocument, win = doc.defaultView;
  let state = documents.get(doc);
  if (!state) {
    const style = doc.createElement('style');
    style.setAttribute('data-pagewise-owned', '');
    style.textContent = '::highlight(pagewise-translated){text-decoration:underline solid #40816b;text-decoration-thickness:1.5px;}::highlight(pagewise-hover){background-color:#dceee2;}';
    (doc.head || doc.documentElement).append(style);
    state = {style, highlight:win.Highlight ? new win.Highlight() : null, hover:win.Highlight ? new win.Highlight() : null, count:0};
    if (state.hover) state.hover.priority = 1;
    documents.set(doc, state);
  }
  state.count++;
  for (const range of target.ranges) state.highlight?.add(range);
  if (state.highlight) win.CSS?.highlights?.set('pagewise-translated', state.highlight);
  let disposed = false, timer, over = false, dismissed = false, focus = false, shown = false;
  const panel = card.shadowRoot.querySelector('.card');
  const start = target.ranges[0]?.startContainer;
  const source = target.mode === 'word' ? (start?.nodeType === 1 ? start : start?.parentElement) : target.anchor;
  // Sibling cards need the paragraph's own indentation. Cards inside a list
  // item or table cell already sit within that source's content box.
  const alignSibling = target.mode === 'paragraph' && card.parentElement === target.anchor.parentElement;
  function syncMargins() {
    if (!alignSibling || !card.isConnected || !source.isConnected) return;
    const css = win.getComputedStyle(source);
    let width = css.width;
    if (width.endsWith('px')) {
      let size = parseFloat(width);
      if (css.boxSizing !== 'border-box') {
        for (const property of ['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth']) size += parseFloat(css[property]) || 0;
      }
      width = `${size}px`;
    } else width = 'auto';
    const styles = {'margin-left':css.marginLeft || '0px','margin-right':css.marginRight || '0px',width,'box-sizing':'border-box',padding:'0px',border:'0px'};
    for (const [property, value] of Object.entries(styles)) {
      if (card.style.getPropertyValue(property) !== value) card.style.setProperty(property, value, 'important');
    }
  }
  const stopTypography = watchTypography(doc, () => {
    syncMargins();
    return sourceFontSize(source);
  }, size => panel.style.setProperty('--pw-source-font-size', `${size}px`));
  let layoutObserver;
  if (alignSibling && win.ResizeObserver) {
    layoutObserver = new win.ResizeObserver(syncMargins);
    layoutObserver.observe(source);
    if (source.parentElement) layoutObserver.observe(source.parentElement);
  }
  const snapshots = target.ranges.map(range => range.toString());
  const url = doc.location.href, paragraphSnapshot = target.anchor.textContent;
  const valid = () => doc.location.href === url && (target.mode !== 'paragraph' || target.anchor.textContent === paragraphSnapshot) && target.ranges.every((range,i) => range.startContainer.isConnected && range.toString() === snapshots[i]);
  const rects = () => target.ranges.flatMap(range => [...range.getClientRects()]).filter(rect => rect.width && rect.height);
  const hit = event => rects().some(r => event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom + 3);
  function position() {
    const r = rects()[0]; if (!r) return;
    const box = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(12, Math.min(r.left, win.innerWidth - box.width - 12))}px`;
    const below = r.bottom + 8;
    panel.style.top = `${Math.max(12, Math.min(below + box.height <= win.innerHeight - 12 ? below : r.top - box.height - 8, win.innerHeight - box.height - 12))}px`;
  }
  function show() {
    if (disposed || !card.isConnected || !valid()) return;
    clearTimeout(timer); timer = null;
    panel.showPopover?.(); shown = true; position();
    for (const range of target.ranges) state.hover?.add(range);
    if (state.hover) win.CSS?.highlights?.set('pagewise-hover', state.hover);
  }
  function hide() {
    clearTimeout(timer); timer = null; panel.hidePopover?.(); shown = false;
    for (const range of target.ranges) state.hover?.delete(range);
    if (!state.hover?.size && win.CSS?.highlights?.get('pagewise-hover') === state.hover) win.CSS.highlights.delete('pagewise-hover');
  }
  function move(event) {
    if (disposed) return;
    const within = event.composedPath().includes(card) || hit(event);
    over = within;
    if (within) { if (!dismissed) show(); }
    else {
      dismissed = false;
      if (!focus && !timer) timer = win.setTimeout(hide, 180);
    }
  }
  function escape(event) {
    if (event.key === 'Escape' && shown) {
      event.preventDefault(); event.stopPropagation(); dismissed = true; hide();
    }
  }
  function click(event) {
    if (event.composedPath().includes(card)) return;
    if (hit(event)) { dismissed = false; show(); }
    else { dismissed = true; hide(); }
  }
  function cleanup() {
    if (disposed) return;
    disposed = true; hide(); observer.disconnect(); resizeObserver?.disconnect(); layoutObserver?.disconnect(); stopTypography();
    doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerdown', click);
    doc.removeEventListener('keydown', escape, true); win.removeEventListener('scroll', hide, true); win.removeEventListener('resize', hide);
    win.removeEventListener('popstate', changed); win.removeEventListener('hashchange', changed);
    for (const range of target.ranges) state.highlight?.delete(range);
    if (--state.count === 0) {
      if (win.CSS?.highlights?.get('pagewise-translated') === state.highlight) win.CSS.highlights.delete('pagewise-translated');
      state.style.remove(); documents.delete(doc);
    }
  }
  function changed() {
    if (!card.isConnected || !valid()) { cleanup(); card.remove(); }
  }
  const observer = new win.MutationObserver(changed);
  observer.observe(doc.body || doc.documentElement, {childList:true,characterData:true,subtree:true});
  let resizeObserver;
  if (target.mode === 'word') {
    panel.setAttribute('popover', 'manual');
    panel.setAttribute('role', 'dialog');
    const trigger = doc.createElement('button');
    trigger.type = 'button'; trigger.className = 'word-trigger';
    trigger.textContent = `查看选词译文：${target.text}`; trigger.setAttribute('aria-haspopup','dialog');
    card.shadowRoot.append(trigger);
    trigger.addEventListener('focus', () => { focus = true; dismissed = false; target.anchor.scrollIntoView?.({block:'nearest'}); show(); });
    trigger.addEventListener('click', show);
    card.shadowRoot.addEventListener('focusin', () => { focus = true; });
    card.shadowRoot.addEventListener('focusout', event => { if (!card.shadowRoot.contains(event.relatedTarget)) { focus = false; if (!over) hide(); } });
    doc.addEventListener('pointermove', move); doc.addEventListener('pointerdown', click); doc.addEventListener('keydown', escape, true);
    win.addEventListener('scroll', hide, true); win.addEventListener('resize', hide);
    if (win.ResizeObserver) { resizeObserver = new win.ResizeObserver(position); resizeObserver.observe(panel); }
  }
  win.addEventListener('popstate', changed); win.addEventListener('hashchange', changed);
  return cleanup;
}
