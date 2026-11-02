import { DEFAULT_SETTINGS, validateSettings, requestModel } from "./core.js";
import { renderLoading } from './loading.js';
async function main() {
  const $ = (id) => document.getElementById(id);
  let saved = { ...DEFAULT_SETTINGS };
  let busy = false;
  renderLoading($("feedback"), "正在加载设置…");
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  saved = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get("settings")).settings };
  $("endpoint").value = saved.endpoint;
  $("model").value = saved.model;
  function keyStatus() {
    $("key-status").textContent = saved.apiKey ? "已保存密钥 · 留空会保留现有密钥" : "尚未保存密钥";
    $("api-key").placeholder = saved.apiKey ? "已保存 · 输入新密钥以替换" : "输入你的 API Key";
  }
  keyStatus();
  $("feedback").replaceChildren();
  $("feedback").hidden = true;
  function feedback(text, error = false) {
    $("feedback").hidden = false;
    $("feedback").textContent = text;
    $("feedback").classList.toggle("error", error);
  }
  function values() {
    return validateSettings({ endpoint: $("endpoint").value, model: $("model").value, apiKey: $("api-key").value }, saved.apiKey);
  }
  async function permission(settings) {
    const origin = new URL(settings.endpoint).origin + "/*";
    if (!await chrome.permissions.contains({ origins: [origin] })) {
      if (!await chrome.permissions.request({ origins: [origin] })) throw new Error("未获得接口域名的访问权限，设置尚未保存。");
    }
  }
  function disable(value) {
    busy = value;
    for (const id of ["save", "test-connection", "delete-key"]) $(id).disabled = value;
  }
  function loading(text) {
    $("feedback").classList.remove("error");
    renderLoading($("feedback"), text);
  }
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    disable(true);
    loading("正在保存设置…");
    try {
      const next = values();
      await permission(next);
      await chrome.storage.local.set({ settings: next });
      saved = next;
      $("api-key").value = "";
      keyStatus();
      feedback("设置已保存，回到文章即可开始阅读。");
    } catch (error) {
      feedback(error.message, true);
    } finally {
      disable(false);
    }
  });
  $("test-connection").addEventListener("click", async () => {
    if (busy) return;
    disable(true);
    loading("正在连接模型…");
    try {
      const next = values();
      await permission(next);
      await requestModel(next, [{ role: "user", content: "请只回复：连接成功" }], { timeoutMs: 2e4 });
      feedback("连接成功，模型已响应。未保存的修改请点击「保存设置」。");
    } catch (error) {
      feedback(error.message, true);
    } finally {
      disable(false);
    }
  });
  $("delete-key").addEventListener("click", async () => {
    if (busy) return;
    disable(true);
    loading("正在删除密钥…");
    try {
      const next = { ...saved, apiKey: "" };
      await chrome.storage.local.set({ settings: next });
      saved = next;
      $("api-key").value = "";
      keyStatus();
      feedback("密钥已从本机扩展存储删除。");
    } catch (error) {
      feedback(error.message, true);
    } finally {
      disable(false);
    }
  });
}
main().catch(() => {
  document.getElementById("feedback").hidden = false;
  document.getElementById("feedback").textContent = "无法加载设置，请重新打开此页面。";
});
