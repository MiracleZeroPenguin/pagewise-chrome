import { MAX_SELECTION } from './core.js';
import { renderLoading } from './loading.js';

import { translationTargets } from './translation-target.js';
import { annotateTranslation } from './translation-marks.js';

const cards = new WeakMap();
export function showInlineTranslation(selectedRange, translate, openSettings = () => {}, visibleSelection) {
  let last = null;
  for (const target of translationTargets(selectedRange, visibleSelection)) last = createTranslation(target, translate, openSettings);
  return last;
}
function createTranslation(target, translate, openSettings) {
  const {anchor, text:selection, ranges, mode} = target;
  const doc = anchor.ownerDocument;
  const snapshots = ranges.map(range => range.toString());
  const records = cards.get(anchor) || new Set();
  cards.set(anchor, records);
  for (const record of records) {
    if (!record.card.isConnected || mode === 'paragraph' || record.mode === mode && record.selection === selection) {
      record.remove(); records.delete(record);
    }
  }
  const card = doc.createElement('div');
  card.setAttribute('data-pagewise-translation', '');
  card.dataset.mode = mode;
  if (mode === 'paragraph') card.style.setProperty('display', 'block', 'important');
  const shadow = card.attachShadow({mode:'open'});
  shadow.innerHTML = `<style>
    :host{all:initial;display:block;margin:8px 0 12px;clear:both;color-scheme:light;text-align:left;direction:ltr}
    .card{position:relative;box-sizing:border-box;max-width:100%;background:#eef4ef;border:1px solid #d7e3d9;border-left:3px solid #40816b;border-radius:8px;padding:8px 34px 8px 10px;color:#24483e;font:clamp(13px,calc(var(--pw-source-font-size,16px) * .9),18px)/1.55 system-ui,-apple-system,sans-serif;letter-spacing:normal}
    .text{white-space:pre-wrap;overflow-wrap:anywhere}
    button{font:inherit;color:inherit;cursor:pointer;border:1px solid #c1d4c7;border-radius:6px;background:#f9fcf9;padding:3px 9px}
    button:focus-visible{outline:2px solid #24796c;outline-offset:2px}
    .close{position:absolute;top:6px;right:6px;font-size:18px;line-height:1;border:0;background:transparent;padding:4px 6px;color:#5c796b}
    .actions{display:flex;gap:8px;margin-top:10px;font-size:.875em}.actions[hidden],button[hidden]{display:none}
    .error{color:#934b35}
    :host([data-mode=word]){display:contents;margin:0}
    :host([data-mode=word]) .card{padding:8px 10px}
    .card[popover]{position:fixed;inset:auto;margin:0;width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;box-shadow:0 8px 32px #193a3329;z-index:2147483647}
    .word-trigger{position:fixed;left:12px;bottom:12px;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
    .word-trigger:focus{width:auto;height:auto;clip-path:none;z-index:2147483647;background:#eef4ef;padding:8px}

  </style><section class="card" aria-label="选文中文翻译" lang="zh-CN">
    <button class="close" type="button" aria-label="关闭译文">×</button>
    <div class="text" role="status" aria-live="polite"></div>
    <div class="actions" hidden><button class="retry" type="button">重试</button><button class="settings" type="button">模型设置</button></div>
  </section>`;
  if (mode === 'word') shadow.querySelector('.close').remove();
  // Keep list/table markup valid; plain inline text stays in its existing container.
  if (mode === 'word') (doc.body || doc.documentElement).append(card);
  else if (anchor.matches('li,td,th,body,html')) anchor.append(card);
  else anchor.after(card);
  const cleanup = annotateTranslation(target, card);
  const remove = () => { cleanup(); card.remove(); records.delete(record); };
  const record = {card,mode,selection,remove}; records.add(record);
  const text = shadow.querySelector('.text'), actions = shadow.querySelector('.actions');
  const retry = shadow.querySelector('.retry');
  const originalURL = doc.location.href;
  const current = () => anchor.isConnected && doc.location.href === originalURL && ranges.every((range,i) => range.startContainer.isConnected && range.toString() === snapshots[i]);
  let busy = false;
  async function run() {
    if (busy || !card.isConnected) return;
    if (selection.length > MAX_SELECTION) { text.textContent = '完整段落超过 6,000 字符，暂时无法翻译。可以选择少量词语查看词义。'; text.classList.add('error'); return; }
    if (!current()) { text.textContent = '原文已变化，请重新选择文字翻译。'; actions.hidden = true; return; }
    busy = true;
    renderLoading(text, '正在翻译…'); text.classList.remove('error'); actions.hidden = true;
    shadow.querySelector('.card').setAttribute('aria-busy', 'true');
    try {
      const result = await translate(selection);
      if (!card.isConnected) return;
      if (!current()) { text.textContent = '原文已变化，请重新选择文字翻译。'; return; }
      if (!result?.ok) throw new Error(result?.error || '翻译失败，请重试。');
      text.textContent = result.text;
    } catch (error) {
      if (!card.isConnected) return;
      text.textContent = error.message || '翻译失败，请重试。';
      text.classList.add('error'); actions.hidden = false;
    } finally {
      busy = false;
      shadow.querySelector('.card').removeAttribute('aria-busy');
    }
  }
  shadow.querySelector('.close')?.addEventListener('click', remove);
  retry.addEventListener('click', event => { if (event.isTrusted) run(); });
  shadow.querySelector('.settings').addEventListener('click', event => { if (event.isTrusted) openSettings(); });
  run();
  return card;
}
