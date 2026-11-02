import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {extractArticle,findSourceNode} from '../src/extract.js';
const paragraph='城市里的小型花园可以改善居民的生活。植物为昆虫提供食物，也让夏天的街道更加凉爽。';
const make=(body)=>new JSDOM(`<title>城市花园</title>${body}`,{url:'https://example.com/article'}).window.document;
test('extracts article in order with stable ids while excluding navigation and private controls',()=>{
 const d=make(`<nav><p>导航菜单</p></nav><article><h1>城市花园</h1><p>${paragraph}</p><section><p>${paragraph}第二段。</p></section><textarea>秘密</textarea><div contenteditable="true">不应读取</div><p hidden>隐藏的内容</p></article>`);
 const before=d.documentElement.outerHTML;const a=extractArticle(d);const b=extractArticle(d);
 assert.equal(d.documentElement.outerHTML,before);assert.deepEqual(a.paragraphs,b.paragraphs);
 assert.ok(a.paragraphs.some(p=>p.text===paragraph));assert.deepEqual(a.paragraphs.map(p=>p.id),a.paragraphs.map((_,i)=>`p${i+1}`));
 assert.doesNotMatch(a.paragraphs.map(p=>p.text).join(''),/导航菜单|秘密|不应读取|隐藏的内容/);
 assert.ok(findSourceNode(d,a.paragraphs.find(p=>p.text===paragraph).id));
});
test('nested list and block paragraphs are never duplicated',()=>{
 const a=extractArticle(make(`<main><h1>例子</h1><ul><li><p>${paragraph}</p><ul><li>内层列表包含清晰的独立观点。</li></ul></li></ul><p>${paragraph}结束。</p></main>`));
 const text=a.paragraphs.map(x=>x.text).join('');assert.equal(text.split(paragraph).length-1,2);assert.equal(text.split('内层列表').length-1,1);
});
test('clips input with explicit notice and source mapping remains valid',()=>{
 const d=make(`<article><p>${paragraph.repeat(4)}</p><p>${paragraph.repeat(4)}</p></article>`);
 const a=extractArticle(d,{maxChars:120});assert.ok(a.truncated);assert.match(a.notice,/部分/);assert.ok(a.paragraphs.reduce((n,p)=>n+p.text.length,0)<=120);assert.ok(findSourceNode(d,'p1'));
});
test('document identity and fingerprint reflect content changes',()=>{
 const d=make(`<article><p>${paragraph}</p></article>`);const a=extractArticle(d);d.querySelector('p').textContent+='更新内容';const b=extractArticle(d);assert.equal(a.documentId,b.documentId);assert.notEqual(a.fingerprint,b.fingerprint);
});
test('block containers preserve direct text around nested paragraphs',()=>{
 const d=make(`<article><blockquote>独立的引言文字<p>${paragraph}</p></blockquote><p>${paragraph}另一个观点。</p></article>`);
 const a=extractArticle(d);assert.ok(a.paragraphs.some(p=>p.text==='独立的引言文字'));assert.equal(a.paragraphs.map(p=>p.text).join('').split(paragraph).length-1,2);
});
test('clipping notice states the configured extraction bound',()=>{
 const a=extractArticle(make(`<main><p>${paragraph.repeat(20)}</p></main>`),{maxChars:120});assert.match(a.notice,/120/);
});
test('plain text article containers extract with source mapping',()=>{
 const d=make(`<article>${paragraph.repeat(4)}</article>`);const a=extractArticle(d);assert.equal(a.paragraphs.length,1);assert.equal(a.paragraphs[0].text,paragraph.repeat(4));assert.ok(findSourceNode(d,'p1'));
});
