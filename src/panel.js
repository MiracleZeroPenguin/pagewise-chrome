import { DEFAULT_SETTINGS, buildMessages, requestModel, parseSummary, parseAnswer, articleKey } from "./core.js";
import { normalizeFontSize } from './typography.js';
import { renderLoading } from './loading.js';
async function main() {
  const $ = (id) => document.getElementById(id);
  renderLoading($("status"), "正在读取文章…");
  const context = await chrome.runtime.sendMessage({ type: "PW_PANEL_CONTEXT" });
  if (!context?.ok) throw new Error(context?.error || "请通过网页右下角的佩知打开面板。");
  const { windowId, tabId: hostTabId } = context;
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  let article = null, tabId = null, epoch = 0, refreshSequence = 0, controller = null, busy = false, launching = false, history = [], lastTask = { kind: "summary" }, view = "summary";
  const cache = /* @__PURE__ */ new Map(), handled = /* @__PURE__ */ new Set();
  let activeRun = null, intentSequence = 0, settingsVersion = 0;
  function run(kind, options = {}) {
    if (launching || busy) return activeRun || Promise.resolve();
    // Bind the action before any asynchronous tab query can select a new page.
    const source = options.source || { tabId, documentId: article?.documentId };
    activeRun = runTask(kind, { ...options, source }).finally(() => {
      activeRun = null;
    });
    return activeRun;
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function status(text, error = false, loading = false) {
    if (loading) renderLoading($("status"), text);
    else $("status").textContent = text;
    $("status").hidden = !text;
    $("status").classList.toggle("error", error);
  }
  function setBusy(value) {
    busy = value;
    $("summarize").disabled = value || !article?.paragraphs.length;
    $("ask").disabled = value || !article?.paragraphs.length;
    $("retry").disabled = value;
    $("summarize").textContent = $("summary").dataset.ready ? "重新生成摘要 ↻" : "生成中文摘要 ↗";
    $("question-form").classList.toggle("busy", value);
  }
  function switchView(next) {
    view = next;
    for (const name of ["summary", "question", "translation"]) {
      $(`${name}-view`).hidden = name !== next;
      $(`tab-${name}`).classList.toggle("active", name === next);
      $(`tab-${name}`).setAttribute("aria-selected", String(name === next));
      $(`tab-${name}`).tabIndex = name === next ? 0 : -1;
    }
  }
  function empty(target, title, text) {
    target.replaceChildren();
    const wrapper = el("div", "empty-state");
    wrapper.append(el("span", "empty-symbol", "✦"), el("h2", "", title), el("p", "", text));
    target.append(wrapper);
  }
  function reset() {
    delete $("summary").dataset.ready;
    epoch++;
    controller?.abort();
    controller = null;
    history = [];
    setBusy(false);
    $("chat").replaceChildren();
    $("question").value = "";
    $("retry").hidden = true;
    empty($("summary"), "先看全貌，再读细节", "提炼关键观点，随时回到原文。");
    empty($("translation"), "让语言不再打断阅读", "在网页中选中文字，然后点击「翻译选文」。");
  }
  function showArticle() {
    document.body.style.setProperty('--reading-font-size', `${normalizeFontSize(article?.readingFontSize)}px`);
    $("article-title").textContent = article?.title || "这一页，暂时读不到。";
    $("notice").hidden = !article?.notice;
    $("notice").textContent = article?.notice || "";
    setBusy(busy);
  }
  async function activeTab() {
    const tab = (await chrome.tabs.query({ active: true, windowId }))[0];
    return tab?.id === hostTabId ? tab : undefined;
  }
  async function readTab(id) {
    try {
      const result = await chrome.tabs.sendMessage(id, { type: "PW_EXTRACT" }, { frameId: 0 });
      if (result?.ok && result.article?.documentId && Array.isArray(result.article.paragraphs)) return result.article;
      throw new Error(result?.error || "这页没有可提取的正文，试试一篇文章。");
    } catch (error) {
      if (error.message.includes("正文")) throw error;
      throw new Error("暂不支持此页面。请打开普通网页；内部页面、Chrome 商店、PDF 或未刷新的旧标签页无法读取。");
    }
  }
  async function refresh(source = null) {
    const sequence = ++refreshSequence;
    const tab = await activeTab();
    if (sequence !== refreshSequence) return null;
    if (source && tab?.id !== source.tabId) return null;
    if (!tab || !/^https?:\/\//.test(tab.url || "")) {
      if (article || tabId !== tab?.id) {
        reset();
        article = null;
        tabId = tab?.id;
      }
      showArticle();
      status("请打开普通网页文章。浏览器内部页面、Chrome 商店及 PDF 暂不支持。");
      return null;
    }
    if (tabId !== tab.id) {
      reset();
      article = null;
      tabId = tab.id;
      showArticle();
    }
    try {
      const next = await readTab(tab.id);
      if (sequence !== refreshSequence || tabId !== tab.id) return null;
      if (source?.documentId && next.documentId !== source.documentId) return null;
      if (!article || article.documentId !== next.documentId || article.fingerprint !== next.fingerprint) {
        reset();
        article = next;
        status(next.paragraphs.length ? "" : "这页没有可提取的正文；仍可选中文字进行翻译。");
      } else article = next;
      showArticle();
      return article;
    } catch (error) {
      if (sequence !== refreshSequence) return null;
      reset();
      article = null;
      showArticle();
      status(error.message, true);
      return null;
    }
  }
  function citations(ids, snapshot) {
    const group = el("div", "citations");
    for (const id of ids) {
      const button = el("button", "citation", `原文 ${id.slice(1)} ↗`);
      button.dataset.sourceId = id;
      button.addEventListener("click", async () => {
        try {
          const result = await chrome.tabs.sendMessage(snapshot.tabId, { type: "PW_SCROLL", documentId: snapshot.article.documentId, fingerprint: snapshot.article.fingerprint, sourceId: id }, { frameId: 0 });
          if (!result?.ok) throw new Error(result?.error || "未找到来源。");
        } catch (error) {
          status(error.message || "原页面已关闭，请重新打开文章。", true);
        }
      });
      group.append(button);
    }
    return group;
  }
  function renderSummary(value, snapshot) {
    $("summary").dataset.ready = "true";
    $("summary").replaceChildren();
    const overview = el("div", "overview");
    overview.append(el("p", "", value.overview));
    $("summary").append(overview);
    const list = el("ol", "points");
    value.points.forEach((point, index) => {
      const item = el("li", "point");
      item.append(el("span", "point-number", String(index + 1).padStart(2, "0")));
      const body = el("div", "point-body");
      body.append(el("p", "", point.text), citations(point.sourceIds, snapshot));
      item.append(body);
      list.append(item);
    });
    $("summary").append(list);
    $("summarize").textContent = "重新生成摘要 ↻";
  }
  async function runTask(kind, { selection = "", question = "", force = false, source } = {}) {
    if (launching || busy) return;
    launching = true;
    lastTask = { kind, selection, question, force: true, source };
    const initialSettingsVersion = settingsVersion;
    const initialIntentSequence = intentSequence;
    $("retry").hidden = true;
    let token = null;
    try {
      const current = await refresh(source);
      if (!current || initialSettingsVersion !== settingsVersion || initialIntentSequence !== intentSequence) return;
      if (kind !== "translation" && !current.paragraphs.length) {
        status("这页没有可提取的正文；仍可选中文字进行翻译。");
        return;
      }
      if (kind === "translation" && !selection.trim()) return;
      // Capture invalidation before waiting for credentials, not after the wait.
      token = epoch;
      const snapshot = { tabId, article: current };
      const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings };
      if (token !== epoch || initialSettingsVersion !== settingsVersion || initialIntentSequence !== intentSequence) return;
      if (tabId !== snapshot.tabId || article?.documentId !== current.documentId || article?.fingerprint !== current.fingerprint) return;
      const preparedDocument = await readTab(source.tabId);
      if (preparedDocument.documentId !== current.documentId || preparedDocument.fingerprint !== current.fingerprint) return;
      const preparedTab = await activeTab();
      if (preparedTab?.id !== source.tabId || token !== epoch || initialSettingsVersion !== settingsVersion || initialIntentSequence !== intentSequence) return;
      if (!settings.apiKey) {
        status("还差一步：点击右上角设置，填写你的 API Key。", true);
        return;
      }
      const key = articleKey(current, settings.endpoint + "|" + settings.model);
      if (kind === "summary" && !force && cache.has(key)) {
        renderSummary(cache.get(key), snapshot);
        status("已载入本次阅读的摘要。");
        return;
      }
      controller = new AbortController();
      setBusy(true);
      status(kind === "translation" ? "正在翻译…" : kind === "answer" ? "正在寻找答案…" : "正在生成摘要…", false, true);
      const raw = await requestModel(settings, buildMessages(kind, current, { selection, question, history }), { signal: controller.signal, json: kind !== "translation" });
      if (token !== epoch) return;
      const selectedTab = await activeTab();
      if (selectedTab?.id !== snapshot.tabId || token !== epoch) return;
      const latest = await readTab(snapshot.tabId);
      if (token !== epoch) return;
      if (latest.documentId !== current.documentId || latest.fingerprint !== current.fingerprint) {
        await refresh();
        status("文章内容已经变化，请重新生成。", true);
        return;
      }
      const ids = new Set(current.paragraphs.map((p) => p.id));
      if (kind === "summary") {
        const value = parseSummary(raw, ids);
        cache.set(key, value);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
        renderSummary(value, snapshot);
      } else if (kind === "translation") {
        $("translation").replaceChildren();
        const quote = el("div", "selection-quote");
        quote.append(el("div", "card-kicker", "原文"), el("p", "", selection));
        const result = el("div", "translation-result");
        result.append(el("div", "card-kicker", "中文译文"), el("p", "", raw));
        $("translation").append(quote, result);
      } else {
        const value = parseAnswer(raw, ids);
        const user = el("div", "chat-question", question);
        const answer = el("div", "chat-answer");
        answer.append(el("p", "", value.answer), citations(value.sourceIds, snapshot));
        $("chat").append(user, answer);
        history.push({ question, answer: value.answer });
        if ($("question").value.trim() === question) $("question").value = "";
        if (view === "question") $("chat").scrollTo?.({top: $("chat").scrollHeight, behavior: "smooth"});
      }
      status("");
    } catch (error) {
      if (token !== null && token !== epoch) return;
      if (!/已取消/.test(error.message)) {
        status(error.message, true);
        $("retry").hidden = false;
      }
    } finally {
      launching = false;
      setBusy(false);
    }
  }
  async function acceptIntent(intent) {
    if (!intent || intent.tabId !== hostTabId || intent.windowId !== windowId || handled.has(intent.requestId)) return;
    handled.add(intent.requestId);
    chrome.runtime.sendMessage({ type: "PW_ACK_INTENT", windowId, requestId: intent.requestId }).catch(() => {
    });
    const intentToken = ++intentSequence;
    const intentSettingsVersion = settingsVersion;
    if (activeRun) {
      epoch++;
      controller?.abort();
      await activeRun;
    }
    if (intentToken !== intentSequence || intentSettingsVersion !== settingsVersion) return;
    const tab = await activeTab();
    if (tab?.id !== intent.tabId || intentToken !== intentSequence || intentSettingsVersion !== settingsVersion) return;
    const source = { tabId: intent.tabId, documentId: intent.documentId };
    const intendedDocument = await refresh(source);
    if (!intendedDocument || intentToken !== intentSequence || intentSettingsVersion !== settingsVersion) return;
    source.documentId ||= intendedDocument.documentId;
    if (intent.documentId && article?.documentId !== intent.documentId) {
      status("原网页已经更新，请重新选择内容。", true);
      return;
    }
    switchView(intent.intent === "translation" ? "translation" : "summary");
    await run(intent.intent === "translation" ? "translation" : "summary", { selection: intent.selection || "", source });
  }
  async function closePanel() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "PW_CLOSE_PANEL" });
      if (!result?.ok) status(result?.error || "无法关闭面板，请在网页中按 Esc。", true);
    } catch (error) { status(error.message || "无法关闭面板，请在网页中按 Esc。", true); }
  }
  $("close-panel").addEventListener("click", closePanel);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closePanel(); }
  });
  window.addEventListener("pagehide", () => { epoch++; controller?.abort(); });
  $("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("summarize").addEventListener("click", () => run("summary", { force: true }));
  $("retry").addEventListener("click", () => run(lastTask.kind, lastTask));
  for (const name of ["summary", "question", "translation"]) {
    const tab = $(`tab-${name}`);
    tab.addEventListener("click", () => switchView(name));
    tab.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll('[role="tab"]')].filter(node => !node.hidden);
      const index = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      switchView(tabs[next].id.slice(4));
    });
  }
  $("question-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const question = $("question").value.trim();
    if (question) run("answer", { question });
  });
  $("question").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("question-form").requestSubmit();
    }
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (info.windowId === windowId) refresh();
  });
  chrome.tabs.onUpdated.addListener((id, change) => {
    if (id !== tabId) return;
    if (change.status === "loading" || change.url) {
      refreshSequence++;
      reset();
      article = null;
      showArticle();
      status("页面正在更新…", false, true);
    }
    if (change.status === "complete") refresh();
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.type === 'PW_TYPOGRAPHY_CHANGED' && sender.tab?.id === hostTabId && sender.frameId === 0 && article) {
      article.readingFontSize = normalizeFontSize(message.fontSize);
      document.body.style.setProperty('--reading-font-size', `${article.readingFontSize}px`);
    }
    if (message.type === "PW_INTENT") acceptIntent(message.intent);
    if (message.type === "PW_DOCUMENT_CHANGED" && sender.tab?.id === tabId) refresh();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) {
      settingsVersion++;
      cache.clear();
      reset();
      status("设置已更新。点击摘要或发送问题继续阅读。");
    }
  });
  await refresh();
  const pending = await chrome.runtime.sendMessage({ type: "PW_GET_INTENT", windowId });
  await acceptIntent(pending?.intent);
}
main().catch(error => {
  const status = document.getElementById("status");
  status.hidden = false;
  status.textContent = error.message || "面板初始化失败，请关闭后重新打开。";
});
