import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
const bundle=(await build({entryPoints:['src/content.js'],bundle:true,write:false,format:'iife',loader:{'.svg':'text'}})).outputFiles[0].text;
async function harness(insecure = false){
 const dom=new JSDOM('<!doctype html><article><p>A readable page with enough source text to summarize and translate.</p></article>',{url:'https://article.test/',runScripts:'outside-only'});
 let listener;const sent=[];
 if(insecure)Object.defineProperty(dom.window.crypto,'randomUUID',{value:undefined});
 dom.window.chrome={runtime:{id:'reader',getURL:p=>`chrome-extension://reader/${p}`,onMessage:{addListener:fn=>listener=fn},sendMessage:async message=>{sent.push(message);return {ok:true};}}};
 dom.window.HTMLElement.prototype.showPopover=function(){this.dataset.open='true';};
 dom.window.HTMLElement.prototype.hidePopover=function(){delete this.dataset.open;};
 dom.window.eval(bundle);
 const shadow=dom.window.document.getElementById('pagewise-root').shadowRoot;
 const send=message=>new Promise(resolve=>{const keep=listener(message,{id:'reader'},resolve);if(!keep)resolve();});
 return {dom,shadow,sent,send};
}
test('closing hides the same iframe; reopening resumes without replacing its state',async()=>{
 const h=await harness();try{
  await h.send({type:'PW_SHOW_PANEL'});
  const frame=h.shadow.querySelector('iframe');assert.ok(frame,'custom panel iframe is mounted');assert.match(frame.src,/chrome-extension:\/\/reader\/panel.html\?token=/);assert.ok(frame.title);
  await h.send({type:'PW_SHOW_PANEL'});assert.equal(h.shadow.querySelectorAll('iframe').length,1);
  const frameToken=new URL(frame.src).searchParams.get('token');await h.send({type:'PW_HIDE_PANEL',frameToken});
  assert.equal(h.shadow.querySelector('iframe'),frame);assert.equal(h.shadow.activeElement.id,'open-panel');
  assert.equal(h.shadow.getElementById('panel-shell').dataset.open,undefined);
  h.dom.window.dispatchEvent(new h.dom.window.Event('resize'));
  assert.equal(h.dom.window.document.documentElement.style.paddingRight,'','hidden frame must not reserve page space');
  await h.send({type:'PW_SHOW_PANEL'});
  assert.equal(h.shadow.querySelector('iframe'),frame);
  assert.equal(h.sent.filter(m=>m.type==='PW_OPEN').at(-1).resume,true);
 }finally{h.dom.window.close();}
});
test('synthetic website clicks cannot launch a model action',async()=>{
 const h=await harness();try{h.shadow.getElementById('open-panel').click();await new Promise(r=>setTimeout(r,0));assert.equal(h.sent.length,0);}finally{h.dom.window.close();}
});
test('desktop panel reserves reading space and restores original root styles on close',async()=>{
 const h=await harness();try{
  const root=h.dom.window.document.documentElement;
  root.style.setProperty('padding-right','12px','important');root.style.width='90%';
  await h.send({type:'PW_SHOW_PANEL'});
  assert.notEqual(root.style.paddingRight,'12px');
  assert.equal(root.style.width,'100%');
  const token=new URL(h.shadow.querySelector('iframe').src).searchParams.get('token');
  await h.send({type:'PW_HIDE_PANEL',frameToken:token});
  assert.equal(root.style.paddingRight,'12px');assert.equal(root.style.getPropertyPriority('padding-right'),'important');assert.equal(root.style.width,'90%');
 }finally{h.dom.window.close();}
});

test('HTTP pages without randomUUID can still open the panel with a strong token',async()=>{
 const h=await harness(true);try{
  const result=await h.send({type:'PW_SHOW_PANEL'});assert.equal(result.ok,true);
  const token=new URL(h.shadow.querySelector('iframe').src).searchParams.get('token');
  assert.match(token,/^[a-f0-9]{32}$/);
 }finally{h.dom.window.close();}
});

test('invalidated runtime shows a refresh action and releases the old panel layout',async()=>{
 const h=await harness();try{
  await h.send({type:'PW_SHOW_PANEL'});
  h.dom.window.chrome.runtime.sendMessage=()=>{throw new Error('Extension context invalidated.');};
  const result=await h.send({type:'PW_SHOW_PANEL'});
  assert.equal(result.ok,false);
  assert.match(h.shadow.getElementById('toast').textContent,/扩展已更新/);
  assert.equal(h.shadow.getElementById('reload-page').hidden,false);
  assert.equal(h.shadow.querySelector('iframe'),null);
  assert.equal(h.dom.window.document.documentElement.style.paddingRight,'');
 }finally{h.dom.window.close();}
});

test('invalidated background notifications stop instead of repeatedly calling the dead runtime',async()=>{
 const h=await harness();try{
  let attempts=0;
  h.dom.window.chrome.runtime.sendMessage=()=>{attempts++;throw new Error('Extension context invalidated.');};
  h.dom.window.document.querySelector('p').textContent='An updated article.';
  await new Promise(r=>setTimeout(r,800));
  assert.match(h.shadow.getElementById('toast').textContent,/扩展已更新/);
  h.dom.window.document.querySelector('p').textContent='Another article update.';
  await new Promise(r=>setTimeout(r,800));
  assert.equal(attempts,1);
 }finally{h.dom.window.close();}
});
