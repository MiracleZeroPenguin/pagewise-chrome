import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {readingFontSize,sourceFontSize,watchTypography} from '../src/typography.js';
test('article text drives typography, ignoring large headings, navigation and hidden text',()=>{
 const dom=new JSDOM(`<body style="font-size:12px"><nav><p style="font-size:30px">${'menu '.repeat(100)}</p></nav><article><h1 style="font-size:48px">Title</h1><p style="font-size:18px">${'Reading paragraph. '.repeat(10)}</p><p hidden style="font-size:40px">${'hidden '.repeat(100)}</p><p style="font-size:10px">note</p></article></body>`);try{
  assert.equal(readingFontSize(dom.window.document),18);
  assert.equal(sourceFontSize(dom.window.document.querySelector('h1')),22);
 }finally{dom.window.close();}
});
test('source font follows computed sizes with readable lower and upper bounds',()=>{
 const dom=new JSDOM('<p style="font-size:9px">Text</p>');try{
  const p=dom.window.document.querySelector('p');assert.equal(sourceFontSize(p),14);
  p.style.fontSize='20px';assert.equal(sourceFontSize(p),20);
  p.style.fontSize='42px';assert.equal(sourceFontSize(p),22);
 }finally{dom.window.close();}
});
test('typography watcher reacts to style changes and stops on cleanup',async()=>{
 const dom=new JSDOM('<article><p style="font-size:16px">A readable paragraph.</p></article>',{pretendToBeVisual:true});try{
  const doc=dom.window.document,values=[];
  const stop=watchTypography(doc,()=>readingFontSize(doc),size=>values.push(size));
  doc.querySelector('p').style.fontSize='20px';await new Promise(r=>setTimeout(r,60));
  assert.deepEqual(values,[16,20]);stop();
  doc.querySelector('p').style.fontSize='18px';await new Promise(r=>setTimeout(r,60));assert.deepEqual(values,[16,20]);
 }finally{dom.window.close();}
});
