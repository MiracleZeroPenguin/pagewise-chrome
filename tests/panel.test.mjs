import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const html = await readFile(new URL("../static/panel.html", import.meta.url), "utf8");
const bundled = (await build({ entryPoints: ["src/panel.js"], bundle: true, write: false, format: "iife", loader:{'.svg':'text'}, target: "chrome116" })).outputFiles[0].text;
const settings = { endpoint: "https://example.com/chat", model: "test-model", apiKey: "test-key" };
const article = (id, paragraphs = [{ id: "p1", text: `Article ${id}` }]) => ({ title: `Title ${id}`, url: `https://example.com/${id}`, documentId: `doc-${id}`, fingerprint: `fingerprint-${id}`, paragraphs, characterCount: paragraphs.length * 10, notice: "", truncated: false });
function event() {
  const listeners = [];
  return { addListener(fn) {
    listeners.push(fn);
  }, emit(...args) {
    for (const fn of listeners) fn(...args);
  } };
}
async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for panel state");
}
async function settle() {
  for (let n = 0; n < 10; n++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function harness(first = article(1), contextOK = true) {
  const dom = new JSDOM(html, { url: "https://extension.test/panel.html", runScripts: "outside-only" });
  const state = { active: 1, documents: /* @__PURE__ */ new Map([[1, first], [2, article(2)]]), fetches: [], pendingRead: null, onRead: null, getSettings: async () => ({ settings }), ready: false, settingsReads: 0, sent: [] };
  const changed = event(), messages = event(), activated = event(), updated = event();
  const chrome = {
    storage: { local: { setAccessLevel: async () => {
    }, get: () => { state.settingsReads++; return state.getSettings(); } }, onChanged: changed },
    windows: { getCurrent: async () => ({ id: 7 }) },
    tabs: { query: async () => [{ id: state.active, url: `https://example.com/${state.active}`, windowId: 7 }], sendMessage: async (id, message) => {
      if (message.type === "PW_EXTRACT") {
        const result = { ok: true, article: state.documents.get(id) };
        state.onRead?.(id);
        return result;
      }
      return { ok: true };
    }, onActivated: activated, onUpdated: updated },
    runtime: { onMessage: messages, openOptionsPage: async () => {
    }, sendMessage: async (message) => {
      state.sent.push(message);
      if (message.type === "PW_PANEL_CONTEXT") return contextOK ? {ok:true,tabId:1,windowId:7} : {ok:false,error:"未授权的面板"};
      if (message.type === "PW_GET_INTENT") state.ready = true;
      return { ok: true, intent: null };
    } }
  };
  dom.window.chrome = chrome;
  dom.window.scrollTo = () => {
  };
  dom.window.HTMLElement.prototype.scrollIntoView = () => {
  };
  dom.window.AbortController = AbortController;
  dom.window.fetch = async (url, init) => {
    state.fetches.push({ url, init, body: JSON.parse(init.body) });
    const content = JSON.parse(init.body).messages[0].content.includes("忠实翻译") ? "这是翻译结果。" : JSON.stringify({ overview: "摘要结果", points: [{ text: "观点", sourceIds: ["p1"] }] });
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  dom.window.eval(bundled);
  await until(() => state.ready || dom.window.document.getElementById("status").textContent.includes("未授权"));
  return { dom, state, changed, messages, activated, click: () => dom.window.document.getElementById("summarize").click(), intent: (intent = "summary") => messages.emit({ type: "PW_INTENT", intent: { tabId: 1, windowId: 7, documentId: "doc-1", requestId: crypto.randomUUID(), intent, selection: "Hello world" } }, {}) };
}
for (const change of [{ apiKey: "" }, { endpoint: "https://new.example.com/chat" }, { model: "new-model" }]) test(`changing ${Object.keys(change)[0]} while settings read is pending prevents any provider request`, async () => {
  const h = await harness();
  try {
    let resolveRead;
    h.state.getSettings = () => new Promise((resolve) => {
      resolveRead = resolve;
    });
    h.click();
    await until(() => resolveRead);
    h.changed.emit({ settings: { oldValue: settings, newValue: { ...settings, ...change } } }, "local");
    resolveRead({ settings });
    await settle();
    assert.equal(h.state.fetches.length, 0, "an invalidated key snapshot must never be sent");
    assert.match(h.dom.window.document.getElementById("status").textContent, /设置已更新/);
  } finally {
    h.dom.window.close();
  }
});
for (const mode of ["summary", "translation"]) test(`a ${mode} float intent never uploads a different tab when activation events lag`, async () => {
  const h = await harness();
  try {
    h.state.onRead = (id) => {
      if (id === 1) h.state.active = 2;
    };
    h.intent(mode);
    await settle();
    assert.equal(h.state.fetches.length, 0, "the explicit tab-1 action must not upload tab 2");
  } finally {
    h.dom.window.close();
  }
});
test("selected text translates on an extractable document with no article paragraphs", async () => {
  const h = await harness(article(1, []));
  try {
    h.intent("translation");
    await settle();
    assert.equal(h.state.fetches.length, 1, "translation requires selection and document identity, not article paragraphs");
    assert.match(h.state.fetches[0].body.messages[1].content, /Hello world/);
    assert.doesNotMatch(h.state.fetches[0].body.messages[1].content, /paragraphs/);
    assert.match(h.dom.window.document.getElementById("translation").textContent, /这是翻译结果/);
  } finally {
    h.dom.window.close();
  }
});
test("panel summary action cannot follow an unnoticed active-tab switch", async () => {
  const h = await harness();
  try {
    h.state.onRead = (id) => {
      if (id === 1) h.state.active = 2;
    };
    h.click();
    await settle();
    assert.equal(h.state.fetches.length, 0);
  } finally {
    h.dom.window.close();
  }
});
test("a newer intent invalidates an older pending settings read before upload", async () => {
  const h = await harness();
  try {
    let resolveRead;
    h.state.getSettings = () => new Promise((resolve) => {
      resolveRead = resolve;
    });
    h.click();
    await until(() => resolveRead);
    h.intent("translation");
    h.state.getSettings = async () => ({ settings });
    resolveRead({ settings });
    await settle();
    assert.equal(h.state.fetches.length, 1);
    assert.match(h.state.fetches[0].body.messages[1].content, /quotedSelection/);
  } finally {
    h.dom.window.close();
  }
});
test("a document replaced during settings preparation prevents selection upload", async () => {
  const h = await harness();
  try {
    let resolveRead;
    h.state.getSettings = () => new Promise((resolve) => {
      resolveRead = resolve;
    });
    h.intent("translation");
    await until(() => resolveRead);
    h.state.documents.set(1, { ...article(1), documentId: "new-document" });
    resolveRead({ settings });
    await settle();
    assert.equal(h.state.fetches.length, 0);
  } finally {
    h.dom.window.close();
  }
});
test("empty article disables summary and Q&A while retaining page identity", async () => {
  const h = await harness(article(1, []));
  try {
    assert.equal(h.dom.window.document.getElementById("article-title").textContent, "Title 1");
    assert.equal(h.dom.window.document.getElementById("summarize").disabled, true);
    assert.equal(h.dom.window.document.getElementById("ask").disabled, true);
    assert.equal(h.state.fetches.length, 0);
  } finally {
    h.dom.window.close();
  }
});

test('settings invalidation during intent extraction cancels that action before preparation', async () => {
  const h = await harness();
  try {
    h.state.onRead = () => {
      h.state.onRead = null;
      h.changed.emit({ settings: { oldValue: settings, newValue: { ...settings, endpoint: 'https://changed.example.com' } } }, 'local');
    };
    h.intent();
    await settle();
    assert.equal(h.state.fetches.length, 0);
  } finally {
    h.dom.window.close();
  }
});


test('embedded panel never displays or reads a different host tab', async () => {
  const h = await harness();
  try {
    const read = []; h.state.onRead = id => read.push(id);
    h.state.active = 2; h.activated.emit({tabId:2,windowId:7}); await settle();
    assert.ok(!read.includes(2));
    assert.notEqual(h.dom.window.document.getElementById('article-title').textContent,'Title 2');
  } finally { h.dom.window.close(); }
});
test('unregistered iframe cannot initialize article or credential access', async () => {
  const h = await harness(article(1), false);
  try {
    assert.match(h.dom.window.document.getElementById('status').textContent,/未授权/);
    assert.equal(h.state.settingsReads,0);
    assert.equal(h.state.sent.filter(m=>m.type==='PW_GET_INTENT').length,0);
  } finally { h.dom.window.close(); }
});

test('typography follows only its host page without regenerating or clearing summary', async () => {
  const h = await harness({...article(1), readingFontSize:18});
  try {
    const doc = h.dom.window.document;
    assert.equal(doc.body.style.getPropertyValue('--reading-font-size'), '18px');
    h.click(); await settle();
    const summary = doc.getElementById('summary').textContent;
    h.messages.emit({type:'PW_TYPOGRAPHY_CHANGED',fontSize:20},{tab:{id:2},frameId:0});
    assert.equal(doc.body.style.getPropertyValue('--reading-font-size'), '18px');
    h.messages.emit({type:'PW_TYPOGRAPHY_CHANGED',fontSize:20},{tab:{id:1},frameId:0});
    assert.equal(doc.body.style.getPropertyValue('--reading-font-size'), '20px');
    assert.equal(doc.getElementById('summary').textContent, summary);
    assert.equal(h.state.fetches.length, 1);
  } finally { h.dom.window.close(); }
});

test('summary and question tabs preserve draft and summary without another request', async () => {
  const h = await harness();
  try {
    const doc=h.dom.window.document, questionTab=doc.getElementById('tab-question');
    assert.ok(questionTab, 'question has its own tab');
    assert.equal(doc.getElementById('question-view').hidden,true);
    h.click(); await settle();
    const summary=doc.getElementById('summary').textContent;
    questionTab.click();
    assert.equal(doc.getElementById('summary-view').hidden,true);
    assert.equal(doc.getElementById('question-view').hidden,false);
    doc.getElementById('question').value='尚未发送的问题';
    doc.getElementById('tab-summary').click(); questionTab.click();
    assert.equal(doc.getElementById('question').value,'尚未发送的问题');
    assert.equal(doc.getElementById('summary').textContent,summary);
    assert.equal(h.state.fetches.length,1);
    questionTab.dispatchEvent(new h.dom.window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
    assert.equal(doc.activeElement.id,'tab-summary');
    assert.equal(doc.getElementById('summary-view').hidden,false);
  } finally { h.dom.window.close(); }
});

test('question tab works before summary and a background answer preserves the newer draft', async () => {
  const h = await harness();
  try {
    const doc=h.dom.window.document;
    assert.ok(doc.getElementById('tab-question'));
    doc.getElementById('tab-question').click();
    let resolveAnswer, submitted;
    h.dom.window.fetch=async (url,init)=>{
      submitted=JSON.parse(init.body);
      await new Promise(resolve=>resolveAnswer=resolve);
      return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({answer:'仅依据原文的答案',sourceIds:['p1']})}}]})};
    };
    doc.getElementById('question').value='文章主张是什么？';
    doc.getElementById('question-form').dispatchEvent(new h.dom.window.Event('submit',{cancelable:true}));
    await until(()=>resolveAnswer);
    assert.equal(JSON.parse(submitted.messages.at(-1).content).question,'文章主张是什么？');
    doc.getElementById('question').value='接下来想问的问题';
    doc.getElementById('tab-summary').click();
    resolveAnswer(); await settle();
    assert.equal(doc.getElementById('summary-view').hidden,false);
    assert.equal(doc.getElementById('question').value,'接下来想问的问题');
    doc.getElementById('tab-question').click();
    assert.match(doc.getElementById('chat').textContent,/仅依据原文的答案/);
    assert.equal(doc.getElementById('summary').dataset.ready,undefined);
  } finally { h.dom.window.close(); }
});
