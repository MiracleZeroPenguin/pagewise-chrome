import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {translationTargets} from '../src/translation-target.js';
function setup(html) {const dom=new JSDOM(`<article>${html}</article>`,{url:'https://article.test/'});const doc=dom.window.document;return {dom,doc,range:doc.createRange()};}
test('a few words complete a cut-off final word and underline the completed phrase',()=>{
 const {dom,doc,range}=setup('<p>Read a few selected words in this long article paragraph.</p>');try{
  const node=doc.querySelector('p').firstChild;range.setStart(node,7);range.setEnd(node,24);
  const [target]=translationTargets(range,'few selected word');
  assert.equal(target.mode,'word');assert.equal(target.text,'few selected words');
  assert.equal(target.ranges.map(r=>r.toString()).join(''),'few selected words');
 }finally{dom.window.close();}
});
test('long partial selection expands to the whole paragraph and excludes hidden or editable content',()=>{
 const {dom,doc,range}=setup('<p>Start of the paragraph. Here are more than eight words which were selected but the end was missed. <strong>Keep this ending.</strong><span hidden>PRIVATE</span><input value="SECRET"><span contenteditable="true">DRAFT</span></p>');try{
  const p=doc.querySelector('p');range.setStart(p.firstChild,24);range.setEnd(p.firstChild,95);
  const [target]=translationTargets(range,range.toString());
  assert.equal(target.mode,'paragraph');assert.equal(target.anchor,p);
  assert.equal(target.text,'Start of the paragraph. Here are more than eight words which were selected but the end was missed. Keep this ending.');
  assert.equal(target.ranges.map(r=>r.toString()).join('').trim(),target.text);
 }finally{dom.window.close();}
});
test('cross-paragraph selections produce complete separate paragraphs in document order',()=>{
 const {dom,doc,range}=setup('<p>First complete paragraph.</p><p>Second complete paragraph.</p>');try{
  const ps=doc.querySelectorAll('p');range.setStart(ps[0].firstChild,6);range.setEnd(ps[1].firstChild,6);
  const targets=translationTargets(range,'complete paragraph. Second');
  assert.equal(targets.length,2);assert.ok(targets.every(t=>t.mode==='paragraph'));
  assert.deepEqual(targets.map(t=>t.text),['First complete paragraph.','Second complete paragraph.']);
 }finally{dom.window.close();}
});
test('short CJK phrases use hover; longer CJK passages expand to the paragraph',()=>{
 const {dom,doc,range}=setup('<p>这是一段用来测试中文选词与完整段落翻译行为的原文。</p>');try{
  const p=doc.querySelector('p');range.setStart(p.firstChild,0);range.setEnd(p.firstChild,4);
  assert.equal(translationTargets(range,range.toString())[0].mode,'word');
  range.setEnd(p.firstChild,18);const [target]=translationTargets(range,range.toString());
  assert.equal(target.mode,'paragraph');assert.equal(target.text,p.textContent);
 }finally{dom.window.close();}
});
test('oversized paragraphs remain complete so the UI can explain the limit instead of silently truncating',()=>{
 const {dom,doc,range}=setup(`<p>Nine chosen words should expand to this entire paragraph. ${'long '.repeat(1500)}</p>`);try{
  range.setStart(doc.querySelector('p').firstChild,0);range.setEnd(doc.querySelector('p').firstChild,54);
  assert.ok(translationTargets(range,range.toString())[0].text.length>6000);
 }finally{dom.window.close();}
});
test('crossing an editable island is rejected instead of sending its visible draft text',()=>{
 const {dom,doc,range}=setup('<p>Hello <span contenteditable="true">private draft</span> world</p>');try{
  range.selectNodeContents(doc.querySelector('p'));
  assert.deepEqual(translationTargets(range,'Hello private draft world'),[]);
 }finally{dom.window.close();}
});
test('whole-paragraph extraction preserves explicit line breaks between words',()=>{
 const {dom,doc,range}=setup('<p>First sentence starts here<br>Second sentence continues here with more words.</p>');try{
  range.selectNodeContents(doc.querySelector('p'));
  assert.equal(translationTargets(range,'First sentence starts here\nSecond sentence continues here with more words.')[0].text,'First sentence starts here\nSecond sentence continues here with more words.');
 }finally{dom.window.close();}
});

test('a selection inside a word expands both edges without neighboring punctuation',()=>{
 const {dom,doc,range}=setup('<p>Try (Serendipity), today.</p>');try{
  const node=doc.querySelector('p').firstChild;range.setStart(node,8);range.setEnd(node,12);
  const [target]=translationTargets(range,range.toString());
  assert.equal(target.mode,'word');assert.equal(target.text,'Serendipity');
  assert.equal(target.ranges.map(r=>r.toString()).join(''),'Serendipity');
 }finally{dom.window.close();}
});
test('word completion crosses inline formatting without changing original HTML',()=>{
 const {dom,doc,range}=setup('<p>Read trans<strong>lat</strong>ion carefully.</p>');try{
  const p=doc.querySelector('p'),before=p.innerHTML;range.selectNodeContents(p.querySelector('strong'));
  const [target]=translationTargets(range,'lat');
  assert.equal(target.text,'translation');assert.equal(target.ranges.map(r=>r.toString()).join(''),'translation');
  assert.equal(p.innerHTML,before);
 }finally{dom.window.close();}
});
test('apostrophes and hyphenated compounds remain complete words',()=>{
 for(const word of ["don't",'self-hosted','café']){
  const {dom,doc,range}=setup(`<p>Try ${word} today.</p>`);try{
   range.setStart(doc.querySelector('p').firstChild,5);range.setEnd(doc.querySelector('p').firstChild,7);
   assert.equal(translationTargets(range,range.toString())[0].text,word);
  }finally{dom.window.close();}
 }
});
test('word completion never crosses a line break or enters editable or hidden text',()=>{
 const {dom,doc,range}=setup('<p>hello<br>world <span>priv</span><span contenteditable="true">ate-secret</span><span hidden>hidden-secret</span></p>');try{
  const p=doc.querySelector('p');range.setStart(p.firstChild,2);range.setEnd(p.firstChild,5);
  assert.equal(translationTargets(range,'llo')[0].text,'hello');
  const node=p.querySelector('span').firstChild;range.setStart(node,1);range.setEnd(node,3);
  const [target]=translationTargets(range,'ri');assert.equal(target.text,'priv');
  assert.equal(target.ranges.map(r=>r.toString()).join(''),'priv');
 }finally{dom.window.close();}
});
test('word completion also crosses inline formatting on pages without paragraph wrappers',()=>{
 const dom=new JSDOM('<body><span>Ser<strong>endi</strong>pity</span></body>',{url:'https://article.test/'});try{
  const doc=dom.window.document,range=doc.createRange(),node=doc.querySelector('strong').firstChild;
  range.setStart(node,1);range.setEnd(node,3);
  const [target]=translationTargets(range,'nd');assert.equal(target.text,'Serendipity');
  assert.equal(target.ranges.map(r=>r.toString()).join(''),'Serendipity');
 }finally{dom.window.close();}
});
