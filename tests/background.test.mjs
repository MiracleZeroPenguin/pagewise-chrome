import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {build} from 'esbuild';
const source = (await build({entryPoints:['src/background.js'],bundle:true,write:false,format:'iife'})).outputFiles[0].text;
function harness() {
  const stored = {}, sent = [], requests = []; let listener;
  const settings = {apiKey:'test-only-key',model:'test-model',endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions'};
  const chrome = {
    runtime: {id:'reader',getURL:p=>`chrome-extension://reader/${p}`,onMessage:{addListener:fn=>listener=fn},sendMessage:async m=>sent.push(m)},
    storage: {local:{setAccessLevel:async()=>{},get:async()=>({settings})},session:{setAccessLevel:async()=>{},get:async key=>({[key]:stored[key]}),set:async values=>Object.assign(stored,values),remove:async keys=>{for(const key of [keys].flat())delete stored[key];}}},
    tabs:{sendMessage:async (tabId,message,options)=>{sent.push({tabId,message,options});return {ok:true};},onRemoved:{addListener(){}}},
    action:{onClicked:{addListener(){}},setBadgeText:async()=>{},setTitle:async()=>{}},
    sidePanel:{open:()=>Promise.reject(new Error('Native panel must not be used'))}
  };
  vm.runInNewContext(source,{chrome,crypto,URL,console,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>({choices:[{message:{content:'中文译文'}}]})};}});
  const send=(message,sender)=>new Promise(resolve=>{const keep=listener(message,sender,resolve);if(!keep)resolve(undefined);});
  const page={id:'reader',tab:{id:12,windowId:3,url:'https://article.test/'},frameId:0,url:'https://article.test/'};
  const frame={...page,frameId:7,url:'chrome-extension://reader/panel.html?token=panel-token'};
  return {send,page,frame,stored,sent,requests};
}
test('opening registers a per-tab embedded panel without calling native sidePanel',async()=>{
 const h=harness();const result=await h.send({type:'PW_OPEN',frameToken:'panel-token',intent:'summary',documentId:'doc-a'},h.page);
 assert.equal(result.ok,true);
 const context=await h.send({type:'PW_PANEL_CONTEXT'},h.frame);
 assert.equal(context.tabId,12);assert.equal(context.windowId,3);
 const pending=await h.send({type:'PW_GET_INTENT'},h.frame);
 assert.equal(pending.intent.documentId,'doc-a');assert.equal(pending.intent.tabId,12);
 assert.ok(!JSON.stringify(h.sent).includes('apiKey'));
});
test('page frames and unregistered panel frames cannot obtain context or close another panel',async()=>{
 const h=harness();await h.send({type:'PW_OPEN',frameToken:'panel-token',intent:'summary'},h.page);
 for(const sender of [h.page,{...h.frame,url:'https://article.test/panel.html?token=panel-token'},{...h.frame,url:'chrome-extension://reader/panel.html?token=wrong'},{...h.frame,tab:{id:99,windowId:3}}]){
  const context=await h.send({type:'PW_PANEL_CONTEXT'},sender);assert.notEqual(context?.ok,true);
  const close=await h.send({type:'PW_CLOSE_PANEL'},sender);assert.notEqual(close?.ok,true);
 }
 assert.equal(h.sent.filter(m=>m.message?.type==='PW_HIDE_PANEL').length,0);
});
test('closing preserves the owning frame context; resuming sends no new model intent',async()=>{
 const h=harness();await h.send({type:'PW_OPEN',frameToken:'panel-token',intent:'summary'},h.page);
 const result=await h.send({type:'PW_CLOSE_PANEL'},h.frame);assert.equal(result.ok,true);
 const close=h.sent.find(m=>m.message?.type==='PW_HIDE_PANEL');assert.equal(close.tabId,12);assert.equal(close.options.frameId,0);
 assert.equal((await h.send({type:'PW_PANEL_CONTEXT'},h.frame))?.ok,true);
 const count=h.sent.filter(m=>m.type==='PW_INTENT').length;
 await h.send({type:'PW_OPEN',frameToken:'panel-token',resume:true},h.page);
 assert.equal(h.sent.filter(m=>m.type==='PW_INTENT').length,count);
 await h.send({type:'PW_OPEN',frameToken:'new-panel-token',resume:true},h.page);
 assert.equal(h.sent.filter(m=>m.type==='PW_INTENT').length,count+1,'new document/frame creates a fresh intent');
 assert.notEqual((await h.send({type:'PW_PANEL_CONTEXT'},h.frame))?.ok,true,'replaced frames lose authorization');
});

test('inline translation uses trusted settings and returns only translated text to the source page',async()=>{
 const h=harness();const response=await h.send({type:'PW_TRANSLATE_INLINE',selection:'Selected words'},h.page);
 assert.equal(response?.ok,true);assert.equal(response.text,'中文译文');
 assert.equal(h.requests.length,1);assert.equal(h.requests[0].headers.Authorization,'Bearer test-only-key');
 assert.equal(JSON.parse(JSON.parse(h.requests[0].body).messages.at(-1).content).quotedSelection,'Selected words');
 assert.ok(!JSON.stringify(response).includes('test-only-key'));assert.equal(h.sent.length,0);
});
test('inline translation rejects subframes, extension frames and invalid selection without a provider call',async()=>{
 const h=harness();
 for(const [sender,selection] of [[h.frame,'words'],[{...h.page,frameId:2},'words'],[h.page,''],[h.page,'x'.repeat(6001)]]){
  const response=await h.send({type:'PW_TRANSLATE_INLINE',selection},sender);assert.equal(response?.ok,false);
 }
 assert.equal(h.requests.length,0);
});
