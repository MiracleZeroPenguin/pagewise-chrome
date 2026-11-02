import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {extractArticle} from '../src/extract.js';
import {build} from 'esbuild';
const bundled = (await build({entryPoints:['src/inline-translation.js'],bundle:true,write:false,format:'esm',loader:{'.svg':'text'}})).outputFiles[0].text;
const {showInlineTranslation} = await import(`data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`);
const render = (range, translate) => showInlineTranslation(range, translate, () => {}, range.toString());
function fixture() {
 const dom=new JSDOM('<article><p id="first">First paragraph with <strong>selected words</strong> and more readable source text.</p><p id="last">Last paragraph contains more readable source text to summarize.</p></article>',{url:'https://article.test/'});
 const doc=dom.window.document, range=doc.createRange();range.selectNodeContents(doc.getElementById('first'));
 return {dom,doc,range};
}
test('translation appears after the source paragraph without changing original text or extracted article',async()=>{
 const {dom,doc,range}=fixture();try{
  const before=extractArticle(doc);let finish,selection;
  const card=render(range,text=>{selection=text;return new Promise(r=>finish=r);});
  assert.equal(doc.getElementById('first').nextElementSibling,card);
  assert.match(card.shadowRoot.textContent,/正在翻译/);
  finish({ok:true,text:'译文 <img src=x onerror=alert(1)>'});await new Promise(r=>setTimeout(r,0));
  assert.equal(selection,'First paragraph with selected words and more readable source text.');
  assert.equal(card.shadowRoot.querySelector('.text').textContent,'译文 <img src=x onerror=alert(1)>');
  assert.equal(card.shadowRoot.querySelector('img'),null);
  assert.equal(extractArticle(doc).fingerprint,before.fingerprint);
  card.shadowRoot.querySelector('.close').click();assert.equal(card.isConnected,false);
  assert.equal(extractArticle(doc).fingerprint,before.fingerprint);
 }finally{dom.window.close();}
});
test('multi-paragraph selection inserts after its final paragraph',async()=>{
 const {dom,doc,range}=fixture();try{
  range.setEndAfter(doc.getElementById('last'));
  const card=render(range,async()=>({ok:true,text:'两段译文'}));
  assert.equal(doc.getElementById('last').nextElementSibling,card);
 }finally{dom.window.close();}
});
test('closed cards and changed source never display a delayed translation',async()=>{
 const {dom,doc,range}=fixture();try{
  let finish;
  const card=render(range,()=>new Promise(r=>finish=r));
  doc.getElementById('first').textContent='A different paragraph.';
  finish({ok:true,text:'过期译文'});await new Promise(r=>setTimeout(r,0));
  assert.doesNotMatch(card.shadowRoot.querySelector('.text').textContent,/过期译文/);
  assert.equal(card.isConnected,false,'changed source removes the stale annotation');
  range.selectNodeContents(doc.getElementById('last'));
  const closed=render(range,()=>new Promise(r=>finish=r));
  closed.shadowRoot.querySelector('.close').click();finish({ok:true,text:'不应重新出现'});
  await new Promise(r=>setTimeout(r,0));assert.equal(closed.isConnected,false);
 }finally{dom.window.close();}
});
test('provider error is shown inline with retry and settings controls',async()=>{
 const {dom,range}=fixture();try{
  const card=render(range,async()=>({ok:false,error:'请先在设置中填写 API Key。'}));
  await new Promise(r=>setTimeout(r,0));assert.match(card.shadowRoot.querySelector('.text').textContent,/API Key/);
  assert.equal(card.shadowRoot.querySelector('.retry').hidden,false);
  assert.ok(card.shadowRoot.querySelector('.settings'));
 }finally{dom.window.close();}
});

test('only captured visible selection is sent; hidden DOM text is excluded',async()=>{
 const {dom,doc,range}=fixture();try{
  doc.getElementById('first').innerHTML='Visible beginning <span hidden>PRIVATE VALUE</span><script type="application/json">{"internal":"metadata"}</script> visible ending.';
  range.selectNodeContents(doc.getElementById('first'));let sent;
  showInlineTranslation(range,async text=>{sent=text;return {ok:true,text:'可见文字译文'};},()=>{},'Visible beginning visible ending.');
  await new Promise(r=>setTimeout(r,0));
  assert.equal(sent,'Visible beginning visible ending.');
 }finally{dom.window.close();}
});

test('hidden ancestors do not move the translation below an invisible block',()=>{
 const {dom,doc,range}=fixture();try{
  const hidden=doc.createElement('div');hidden.style.display='none';hidden.innerHTML='<p><span>Hidden end</span></p>';doc.querySelector('article').append(hidden);
  range.selectNodeContents(doc.querySelector('article'));
  const card=showInlineTranslation(range,async()=>({ok:true,text:'译文'}),()=>{},'Visible text');
  assert.equal(doc.getElementById('last').nextElementSibling,card);
 }finally{dom.window.close();}
});

test('paragraph translation mirrors source side margins and border-box width after style changes',async()=>{
 const {dom,doc,range}=fixture();try{
  const source=doc.getElementById('first');
  source.style.cssText='margin-left:40px;margin-right:28px;width:400px;padding:0 12px;border:2px solid;box-sizing:content-box';
  const card=render(range,async()=>({ok:true,text:'译文'}));
  assert.equal(card.style.marginLeft,'40px');
  assert.equal(card.style.marginRight,'28px');
  assert.equal(card.style.width,'428px');
  source.style.marginLeft='24px'; source.style.width='320px';
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(card.style.marginLeft,'24px');
  assert.equal(card.style.width,'348px');
 }finally{dom.window.close();}
});

test('translation inserted inside a list item does not duplicate its outer margins',()=>{
 const dom=new JSDOM('<ul><li style="margin-left:40px;margin-right:20px">This complete list item contains enough words to request a full paragraph translation.</li></ul>',{url:'https://article.test/'});try{
  const doc=dom.window.document,source=doc.querySelector('li'),range=doc.createRange();range.selectNodeContents(source);
  const card=render(range,async()=>({ok:true,text:'列表译文'}));
  assert.equal(card.parentElement,source);
  assert.equal(card.style.marginLeft,'');
  assert.equal(card.style.width,'');
 }finally{dom.window.close();}
});
