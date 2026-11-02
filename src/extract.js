import { Readability } from "@mozilla/readability";
import { readingFontSize } from './typography.js';
const states = /* @__PURE__ */ new WeakMap();
const SKIP = 'nav,header,footer,aside,form,input,textarea,select,button,script,style,noscript,iframe,svg,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[role="navigation"],[role="dialog"],#pagewise-root';
const BLOCK = "h1,h2,h3,h4,p,li,blockquote,pre,td";
const normalize = (text) => text.replace(/\s+/g, " ").trim();
function hash(value) {
  let n = 2166136261;
  for (let i = 0; i < value.length; i++) {
    n ^= value.charCodeAt(i);
    n = Math.imul(n, 16777619);
  }
  return (n >>> 0).toString(36);
}
function extractArticle(document, { maxChars = 24e3 } = {}) {
  let state = states.get(document);
  if (!state) {
    state = { documentId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`, sources: /* @__PURE__ */ new Map() };
    states.set(document, state);
  }
  const clone = document.cloneNode(true);
  const original = [...document.querySelectorAll("*")];
  const copied = [...clone.querySelectorAll("*")];
  const originals = /* @__PURE__ */ new Map();
  copied.forEach((node, index) => {
    node.setAttribute("data-pw-source", String(index));
    originals.set(String(index), original[index]);
  });
  copied.forEach((node, index) => {
    const element = original[index];
    if (!node.isConnected) return;
    const css = document.defaultView?.getComputedStyle(element);
    if (element.matches(SKIP) || css?.display === "none" || css?.visibility === "hidden" || css?.visibility === "collapse") node.remove();
  });
  let readable;
  try {
    readable = new Readability(clone.cloneNode(true), { charThreshold: 100, keepClasses: false }).parse();
  } catch {
  }
  const container = clone.createElement("div");
  if (readable?.content) container.innerHTML = readable.content;
  function collect(root) {
    const nodes = [...root.querySelectorAll(BLOCK)];
    if (root.matches?.("article,main,div") && !root.querySelector(BLOCK) && normalize(root.textContent).length > 30) nodes.push(root);
    for (const div of root.querySelectorAll("div")) if (!div.querySelector(`${BLOCK},div`) && normalize(div.textContent).length > 30) nodes.push(div);
    nodes.sort((a, b) => a.compareDocumentPosition(b) & 4 ? -1 : 1);
    return nodes.map((node) => {
      const own = node.cloneNode(true);
      own.querySelectorAll(BLOCK).forEach((n) => n.remove());
      const text = normalize(own.textContent);
      let source = originals.get(node.getAttribute("data-pw-source"));
      if (!source) source = original.find((n) => n.matches?.(BLOCK) && normalize(n.textContent) === text);
      return { text, source };
    }).filter((p) => p.text.length >= 2 && p.source?.isConnected);
  }
  let candidates = collect(container);
  if (candidates.reduce((n, p) => n + p.text.length, 0) < 80) candidates = collect(clone.querySelector('article,main,[role="main"]') || clone.body || clone);
  state.sources = /* @__PURE__ */ new Map();
  let length = 0;
  let truncated = false;
  const paragraphs = [];
  for (const item of candidates) {
    if (length >= maxChars) {
      truncated = true;
      break;
    }
    const text = item.text.slice(0, maxChars - length);
    if (text.length < item.text.length) truncated = true;
    const id = `p${paragraphs.length + 1}`;
    paragraphs.push({ id, text });
    state.sources.set(id, item.source);
    length += text.length;
  }
  const title = normalize(readable?.title || document.querySelector("h1")?.textContent || document.title || "未命名网页");
  const url = document.location?.href || "";
  const fingerprint = hash(JSON.stringify([url, title, paragraphs]));
  state.fingerprint = fingerprint;
  return { title, url, documentId: state.documentId, fingerprint, paragraphs, truncated, readingFontSize: readingFontSize(document), characterCount: length, notice: truncated ? `文章较长，目前仅处理部分正文（前 ${maxChars.toLocaleString()} 字符）。` : "" };
}
function findSourceNode(document, id) {
  return states.get(document)?.sources.get(id) || null;
}
export {
  extractArticle,
  findSourceNode
};
