const EXCLUDED = '#pagewise-root,[data-pagewise-translation],script,style,noscript,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[hidden]';
const BLOCK = 'p,li,pre,blockquote,h1,h2,h3,h4,h5,h6,td,th,div,section,article,body';
const paragraphFor = node => node.parentElement?.closest(BLOCK) || node.parentElement;

export function translationTargets(selectedRange, visibleSelection) {
  const doc = selectedRange.startContainer.ownerDocument;
  if (selectedRange.collapsed || !String(visibleSelection || '').trim()) return [];
  const visibility = new WeakMap();
  function visible(element) {
    if (!element) return true;
    if (visibility.has(element)) return visibility.get(element);
    const css = doc.defaultView.getComputedStyle(element);
    const value = !element.matches(EXCLUDED) && css.display !== 'none' && !['hidden','collapse'].includes(css.visibility) && visible(element.parentElement);
    visibility.set(element, value); return value;
  }
  let unsafeSelection = false;
  function textRanges(root, selection) {
    const walker = doc.createTreeWalker(root, 4), parts = [];
    for (let node = root.nodeType === 3 ? root : walker.nextNode(); node; node = walker.nextNode()) {
      if (selection && !selection.intersectsNode(node)) continue;
      const range = doc.createRange(); range.selectNodeContents(node);
      if (selection) {
        if (selection.compareBoundaryPoints(0, range) > 0) range.setStart(selection.startContainer, selection.startOffset);
        if (selection.compareBoundaryPoints(2, range) < 0) range.setEnd(selection.endContainer, selection.endOffset);
      }
      if (selection && range.toString().trim() && node.parentElement.closest('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])')) unsafeSelection = true;
      if (visible(node.parentElement) && range.toString()) parts.push(range);
    }
    return parts;
  }
  const selected = textRanges(selectedRange.commonAncestorContainer, selectedRange).filter(r => r.toString().trim());
  if (unsafeSelection) return [];
  const anchors = [...new Set(selected.map(r => paragraphFor(r.startContainer)))].filter(Boolean);
  if (!anchors.length) return [];
  const selection = String(visibleSelection).trim();
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(selection);
  const words = selection.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) || [];
  const short = anchors.length === 1 && !/[\r\n]/.test(selection) && (cjk ? [...selection].length <= 12 : words.length <= 8 && selection.length <= 80);
  if (short) {
    const anchor = anchors[0], entries = [];
    let context = '';
    const walker = doc.createTreeWalker(anchor, 5);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        if (node.matches('br,input,textarea,select,button,[contenteditable]:not([contenteditable="false"])') || node.matches(BLOCK)) context += '\n';
      } else if (visible(node.parentElement) && paragraphFor(node) === anchor) {
        entries.push({node, start:context.length, end:context.length + node.length});
        context += node.data;
      }
    }
    const first = selected[0], last = selected.at(-1);
    const firstEntry = entries.find(entry => entry.node === first.startContainer);
    const lastEntry = entries.find(entry => entry.node === last.endContainer);
    if (!firstEntry || !lastEntry) return [{mode:'word',anchor,text:selection,ranges:selected}];
    const originalStart = firstEntry.start + first.startOffset, originalEnd = lastEntry.start + last.endOffset;
    let start = originalStart, end = originalEnd;
    // Segment the visible paragraph, then map completed word boundaries back to text nodes.
    const segments = [];
    for (const part of new Intl.Segmenter(undefined, {granularity:'word'}).segment(context)) {
      if (!part.isWordLike) continue;
      const previous = segments.at(-1);
      if (previous && /^['’\-‐‑]$/.test(context.slice(previous.end, part.index))) previous.end = part.index + part.segment.length;
      else segments.push({start:part.index, end:part.index + part.segment.length});
    }
    for (const word of segments) {
      if (word.start < originalStart && originalStart < word.end) start = word.start;
      if (word.start < originalEnd && originalEnd < word.end) end = word.end;
    }
    if (start === originalStart && end === originalEnd) return [{mode:'word',anchor,text:selection,ranges:selected}];
    const ranges = entries.filter(entry => entry.start < end && entry.end > start).map(entry => {
      const range = doc.createRange();
      range.setStart(entry.node, Math.max(0, start - entry.start));
      range.setEnd(entry.node, Math.min(entry.node.length, end - entry.start));
      return range;
    });
    return [{mode:'word',anchor,text:context.slice(start,end).replace(/[\t ]+/g,' ').trim(),ranges}];
  }
  return anchors.map(anchor => {
    // Only this paragraph's visible text; nested independent paragraphs are handled separately.
    const ranges = textRanges(anchor).filter(r => paragraphFor(r.startContainer) === anchor);
    const nodes = new Map(ranges.map(r => [r.startContainer, r.toString()]));
    const walker = doc.createTreeWalker(anchor, 5), pieces = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (nodes.has(node)) pieces.push(nodes.get(node));
      else if (node.nodeName === 'BR' && visible(node) && paragraphFor(node) === anchor) pieces.push('\n');
    }
    const text = pieces.join('').replace(/[\t\r ]+/g, ' ').trim();
    return {mode:'paragraph',anchor,text,ranges};
  }).filter(target => target.text);
}
