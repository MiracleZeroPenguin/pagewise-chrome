import readerIcon from '../icon.svg';
import { extractArticle, findSourceNode } from './extract.js';
import { MAX_SELECTION } from './core.js';
import { showInlineTranslation } from './inline-translation.js';
import { readingFontSize, watchTypography } from './typography.js';

if (!document.getElementById('pagewise-root')) {
  const iconMarkup = readerIcon.replace(/<\?xml[^?]*\?>\s*/, '').replace('<svg ', '<svg aria-hidden="true" focusable="false" ');
  const host = document.createElement('div');
  host.id = 'pagewise-root';
  const shadow = host.attachShadow({ mode: 'open', delegatesFocus: true });
  shadow.innerHTML = `<style>
    :host{all:initial;position:fixed;right:24px;bottom:24px;z-index:2147483647;pointer-events:none;font-family:system-ui,-apple-system,sans-serif;color:#163e39;color-scheme:light}
    :host([data-panel-open]){right:calc(min(420px,100vw) + 16px)}
    button{font:inherit;cursor:pointer;pointer-events:auto;border:1px solid #c4d8cf;box-shadow:0 5px 24px #163e3924;color:#214f48}
    button:focus-visible{outline:3px solid #c3a257;outline-offset:4px}
    #open-panel{box-sizing:border-box;display:flex;align-items:center;min-width:44px;height:44px;background:#fcfbf4;border-radius:30px;padding:0 11px;font-size:14px;font-weight:650}
    .mark{display:block;flex:none;width:20px;height:26px;pointer-events:none}
    .mark svg{display:block;width:100%;height:100%}
    .launcher-label{max-width:0;opacity:0;overflow:hidden;white-space:nowrap;margin-inline-start:0;transition:max-width .18s ease,opacity .18s ease,margin-inline-start .18s ease}
    #open-panel:is(:hover,:focus-visible) .launcher-label{max-width:3em;opacity:1;margin-inline-start:8px}
    @media(prefers-reduced-motion:reduce){.launcher-label{transition:none}}
    #translate-selection{display:none;position:fixed;padding:10px 15px;background:#236b5e;color:white;border-radius:20px;font-size:13px;white-space:nowrap}
    #toast{display:none;max-width:270px;font-size:13px;line-height:1.6;background:#fff9ee;border:1px solid #dac6a4;border-radius:12px;padding:12px;margin-bottom:12px;box-shadow:0 5px 20px #0001}
    #reload-page{margin-top:10px;padding:6px 12px;border-radius:8px;background:#fcfbf4}
    #panel-shell{position:fixed;inset:0 0 0 auto;margin:0;padding:0;border:0;border-left:1px solid #dce2d5;width:min(420px,100vw);height:100vh;height:100dvh;max-height:none;max-width:none;background:#faf9f3;box-shadow:-8px 0 32px #183d3720;pointer-events:auto;overflow:hidden;color-scheme:light}
    #panel-shell::backdrop{background:transparent;pointer-events:none}
    #panel-shell:popover-open{animation:pagewise-panel-enter .26s cubic-bezier(.22,1,.36,1)}
    @keyframes pagewise-panel-enter{from{transform:translateX(100%);opacity:.6}to{transform:translateX(0);opacity:1}}
    @media(prefers-reduced-motion:reduce){#panel-shell:popover-open{animation:none}}
    #pagewise-frame{display:block;width:100%;height:100%;border:0;background:#faf9f3}
    @media(max-width:600px){:host([data-panel-open]) #open-panel{visibility:hidden}}
  </style>
  <div id="toast"><span id="toast-message" role="status"></span><button id="reload-page" type="button" hidden>刷新网页</button></div>
  <button id="translate-selection" type="button" title="短词翻译选文，长选文翻译完整段落；内容将发送给你配置的模型">翻译选文 ↗</button>
  <button id="open-panel" type="button" aria-label="佩知：摘要当前网页" aria-expanded="false" aria-controls="panel-shell" title="摘要当前网页 · 内容将发送给你配置的模型"><span class="mark" aria-hidden="true">${iconMarkup}</span><span class="launcher-label" aria-hidden="true">佩知</span></button>
  <aside id="panel-shell" popover="manual" aria-label="佩知阅读助手"></aside>`;
  (document.body || document.documentElement).append(host);
  const launcher = shadow.getElementById('open-panel');
  const button = shadow.getElementById('translate-selection');
  const shell = shadow.getElementById('panel-shell');
  let selected = '', selectedRange = null, toastTimer, frame = null, frameToken = null, layout = null, contextExpired = false;
  let stopTypography;
  let panelOpen = false;
  const reloadButton = shadow.getElementById('reload-page');
  reloadButton.addEventListener('click', event => { if (event.isTrusted) window.location.reload(); });

  function toast(text) {
    const el = shadow.getElementById('toast');
    shadow.getElementById('toast-message').textContent = text;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    if (!contextExpired) toastTimer = setTimeout(() => { el.style.display = 'none'; }, 6000);
  }
  function handleExpiredContext(error) {
    if (!contextExpired && chrome.runtime?.id && !/Extension context invalidated/i.test(error?.message || '')) return false;
    contextExpired = true;
    clearTimeout(debounce);
    observer.disconnect();
    document.removeEventListener('mouseup', selectionChanged);
    document.removeEventListener('keyup', selectionChanged);
    if (frame) hidePanel(frameToken, true);
    button.style.display = 'none';
    reloadButton.hidden = false;
    toast('扩展已更新，当前网页需要刷新后才能继续使用佩知。');
    return true;
  }
  function restoreLayout() {
    if (!layout) return;
    const style = document.documentElement.style;
    for (const [property, saved] of Object.entries(layout.properties)) {
      // Do not undo a website's own changes made while the panel was open.
      if (style.getPropertyValue(property) !== saved.applied || style.getPropertyPriority(property) !== 'important') continue;
      if (saved.value) style.setProperty(property, saved.value, saved.priority);
      else style.removeProperty(property);
    }
    layout = null;
  }
  function reserveSpace() {
    if (!frame || !panelOpen || window.innerWidth < 900) { restoreLayout(); return; }
    if (layout) return;
    const root = document.documentElement;
    const padding = Number.parseFloat(getComputedStyle(root).paddingRight) || 0;
    layout = { properties: {} };
    for (const [property, value] of Object.entries({width:'100%', 'box-sizing':'border-box', 'padding-right':`${padding + 420}px`})) {
      layout.properties[property] = {value:root.style.getPropertyValue(property),priority:root.style.getPropertyPriority(property),applied:value};
      root.style.setProperty(property, value, 'important');
    }
  }
  window.addEventListener('resize', reserveSpace);
  function showPanel() {
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'pagewise-frame';
      frame.title = '佩知：摘要、翻译与文章问答';
      frame.src = chrome.runtime.getURL(`panel.html?token=${encodeURIComponent(frameToken)}`);
      shell.append(frame);
    }
    panelOpen = true;
    reserveSpace();
    shell.showPopover();
    host.setAttribute('data-panel-open', '');
    launcher.setAttribute('aria-expanded', 'true');
    stopTypography ||= watchTypography(document, () => readingFontSize(document), async fontSize => {
      try { await chrome.runtime.sendMessage({type:'PW_TYPOGRAPHY_CHANGED',fontSize}); }
      catch (error) { handleExpiredContext(error); }
    });
  }
  function hidePanel(token = frameToken, dispose = false) {
    if (token !== frameToken) return;
    stopTypography?.(); stopTypography = null;
    shell.hidePopover();
    panelOpen = false;
    // Keep the iframe connected so its document, draft and scroll positions live
    // through ordinary close/reopen. Only an invalidated extension discards it.
    if (dispose) {
      frame?.remove();
      frame = null;
      frameToken = null;
    }
    restoreLayout();
    host.removeAttribute('data-panel-open');
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }
  async function launch(intent) {
    try {
      if (handleExpiredContext()) return { ok: false, error: '请刷新网页后再使用佩知。' };
      const article = extractArticle(document);
      frameToken ||= crypto.randomUUID?.() || Array.from(
        crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')
      ).join('');
      const result = await chrome.runtime.sendMessage({
        type: 'PW_OPEN', frameToken, intent, documentId: article.documentId, resume: !!frame && !panelOpen,
        selection: intent === 'translation' ? selected : ''
      });
      if (!result?.ok) throw new Error(result?.error || '无法打开面板。');
      showPanel();
      return { ok: true };
    } catch (error) {
      if (!handleExpiredContext(error)) toast(error.message || '无法打开面板，请重试。');
      return { ok: false, error: error.message };
    } finally { button.style.display = 'none'; }
  }
  launcher.addEventListener('click', async event => { if (event.isTrusted) await launch('summary'); });
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    if (!event.isTrusted || !selectedRange || handleExpiredContext()) return;
    button.style.display = 'none';
    const translation = showInlineTranslation(selectedRange, async selection => {
      try { return await chrome.runtime.sendMessage({type:'PW_TRANSLATE_INLINE', selection}); }
      catch (error) {
        if (handleExpiredContext(error)) return {ok:false,error:'扩展已更新，请刷新网页后再翻译。'};
        return {ok:false,error:'翻译连接中断，请重试。'};
      }
    }, async () => {
      try { await chrome.runtime.sendMessage({type:'PW_OPEN_SETTINGS'}); }
      catch (error) { if (!handleExpiredContext(error)) toast('无法打开设置，请通过扩展菜单打开。'); }
    }, selected);
    if (!translation) toast('请只选择网页正文；跨过输入框或编辑区的选文无法翻译。');
    else window.getSelection()?.removeAllRanges();
    selectedRange = null;
    selected = '';
  });
  function selectionChanged(event) {
    if (event?.composedPath().some(node => node === host || node.matches?.('[data-pagewise-translation]'))) return;
    const selection = window.getSelection();
    const anchor = selection?.anchorNode?.parentElement;
    if (!selection || selection.isCollapsed || anchor?.closest('input,textarea,[contenteditable]:not([contenteditable="false"])')) {
      selectedRange = null; button.style.display = 'none'; return;
    }
    selected = selection.toString().trim().slice(0, MAX_SELECTION);
    if (!selected) { button.style.display = 'none'; return; }
    selectedRange = selection.getRangeAt(0).cloneRange();
    const rect = selectedRange.getBoundingClientRect();
    button.style.display = 'block';
    button.style.left = `${Math.min(Math.max(rect.left, 12), window.innerWidth - 150)}px`;
    button.style.top = `${Math.min(Math.max(rect.bottom + 8, 12), window.innerHeight - 60)}px`;
  }
  document.addEventListener('mouseup', selectionChanged);
  document.addEventListener('keyup', selectionChanged);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !panelOpen || !event.isTrusted) return;
    event.preventDefault();
    const token = frameToken;
    hidePanel(token);
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'PW_SHOW_PANEL') {
      (async () => { respond(await launch('summary')); })();
      return true;
    }
    if (message?.type === 'PW_HIDE_PANEL') { hidePanel(message.frameToken); respond({ ok: true }); return; }
    if (message?.type === 'PW_EXTRACT') {
      try { respond({ ok: true, article: extractArticle(document) }); }
      catch { respond({ ok: false, error: '暂时无法提取此网页正文。' }); }
      return;
    }
    if (message?.type === 'PW_SCROLL') {
      const current = extractArticle(document);
      if (current.documentId !== message.documentId || current.fingerprint !== message.fingerprint) {
        respond({ ok: false, error: '页面内容已经变化，请重新生成摘要后查看来源。' }); return;
      }
      const node = findSourceNode(document, message.sourceId);
      if (!node) { respond({ ok: false, error: '未找到原文段落，请刷新摘要。' }); return; }
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.animate([{ backgroundColor: '#f4dc8999', outline: '2px solid #c4a454', outlineOffset: '6px' }, { backgroundColor: 'transparent', outline: '2px solid transparent', outlineOffset: '6px' }], { duration: 2800 });
      respond({ ok: true });
    }
  });
  let debounce;
  const observer = new MutationObserver(records => {
    const own = node => node === host || node.nodeType === 1 && node.matches('[data-pagewise-translation],[data-pagewise-owned]');
    if (records.every(record => host.contains(record.target) || record.target.closest?.('[data-pagewise-translation]') ||
      record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(own))) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      try {
        if (handleExpiredContext()) return;
        await chrome.runtime.sendMessage({ type: 'PW_DOCUMENT_CHANGED' });
      } catch (error) { handleExpiredContext(error); }
    }, 700);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
}
