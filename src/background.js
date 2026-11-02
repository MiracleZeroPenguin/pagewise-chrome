import { DEFAULT_SETTINGS, MAX_SELECTION, buildMessages, requestModel } from './core.js';
// Credentials stay in trusted extension contexts, never the webpage's content script.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const panelURL = chrome.runtime.getURL('panel.html');
const panelKey = tabId => `panel:${tabId}`;
const intentKey = (tabId, id) => `intent:${tabId}:${id}`;

async function panelContext(sender) {
  if (!sender.tab || !sender.frameId || !sender.url) return null;
  const url = new URL(sender.url);
  if (`${url.protocol}//${url.host}${url.pathname}` !== panelURL) return null;
  const key = panelKey(sender.tab.id);
  const context = (await chrome.storage.session.get(key))[key];
  return context?.frameToken === url.searchParams.get('token') ? context : null;
}

async function open(tab, message) {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(message.frameToken || '')) throw new Error('面板初始化失败，请刷新网页。');
  const requestId = crypto.randomUUID();
  const key = panelKey(tab.id);
  const previous = (await chrome.storage.session.get(key))[key];
  if (message.resume && previous?.frameToken === message.frameToken && previous.documentId === message.documentId) {
    return { ok: true };
  }
  const intent = {
    tabId: tab.id, windowId: tab.windowId, documentId: message.documentId,
    intent: message.intent === 'translation' ? 'translation' : 'summary',
    selection: String(message.selection || '').slice(0, 6000), requestId
  };
  await chrome.storage.session.set({
    [key]: { frameToken: message.frameToken, requestId, documentId: message.documentId },
    [intentKey(tab.id, requestId)]: intent
  });
  if (previous?.requestId) await chrome.storage.session.remove(intentKey(tab.id, previous.requestId));
  // Existing embedded panels receive it now; a new one retrieves it on startup.
  try { await chrome.runtime.sendMessage({ type: 'PW_INTENT', intent }); } catch {}
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const types = ['PW_OPEN', 'PW_PANEL_CONTEXT', 'PW_GET_INTENT', 'PW_ACK_INTENT', 'PW_CLOSE_PANEL', 'PW_TRANSLATE_INLINE', 'PW_OPEN_SETTINGS'];
  if (!types.includes(message?.type)) return;
  (async () => {
    try {
      if (message.type === 'PW_TRANSLATE_INLINE' || message.type === 'PW_OPEN_SETTINGS') {
        if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 || !/^https?:/.test(sender.url || '')) throw new Error('无效的页面来源。');
        if (message.type === 'PW_OPEN_SETTINGS') {
          await chrome.runtime.openOptionsPage(); respond({ ok: true }); return;
        }
        if (typeof message.selection !== 'string' || !message.selection.trim() || message.selection.length > MAX_SELECTION) throw new Error('请重新选择需要翻译的文字（最多 6,000 字符）。');
        const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
        const text = await requestModel(settings, buildMessages('translation', null, {selection:message.selection}), {timeoutMs:25000});
        const latest = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get('settings')).settings };
        if (['endpoint','model','apiKey'].some(key => latest[key] !== settings[key])) throw new Error('模型设置已更新，请重试翻译。');
        respond({ ok: true, text });
        return;
      }
      if (message.type === 'PW_OPEN') {
        if (!sender.tab || sender.frameId !== 0 || !/^https?:/.test(sender.url || '')) throw new Error('无效的页面来源。');
        respond(await open(sender.tab, message));
        return;
      }
      const context = await panelContext(sender);
      if (!context) throw new Error('请通过网页右下角的「佩知」打开面板。');
      const tabId = sender.tab.id;
      if (message.type === 'PW_PANEL_CONTEXT') {
        respond({ ok: true, tabId, windowId: sender.tab.windowId });
      } else if (message.type === 'PW_GET_INTENT') {
        const key = intentKey(tabId, context.requestId);
        respond({ ok: true, intent: (await chrome.storage.session.get(key))[key] || null });
      } else if (message.type === 'PW_ACK_INTENT') {
        await chrome.storage.session.remove(intentKey(tabId, message.requestId));
        respond({ ok: true });
      } else if (message.type === 'PW_CLOSE_PANEL') {
        await chrome.tabs.sendMessage(tabId, { type: 'PW_HIDE_PANEL', frameToken: context.frameToken }, { frameId: 0 });
        respond({ ok: true });
      }
    } catch (error) { respond({ ok: false, error: error.message }); }
  })();
  return true;
});

chrome.action.onClicked.addListener(async tab => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PW_SHOW_PANEL' }, { frameId: 0 });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '' });
  } catch {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    await chrome.action.setTitle({ tabId: tab.id, title: '请刷新普通网页后再打开佩知；此页面可能不支持扩展。' });
  }
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const key = panelKey(tabId);
  const context = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove([key, intentKey(tabId, context?.requestId)]);
});
