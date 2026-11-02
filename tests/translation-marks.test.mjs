import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {annotateTranslation} from '../src/translation-marks.js';
test('underline registration preserves website highlights and cleans up when the translation is removed',async()=>{
 const dom=new JSDOM('<p>Selected original words.</p>',{url:'https://article.test/'});try{
  const doc=dom.window.document,range=doc.createRange();range.selectNodeContents(doc.querySelector('p').firstChild);
  dom.window.CSS={highlights:new Map([['website-search',{}]])};dom.window.Highlight=Set;
  const card=doc.createElement('div');card.setAttribute('data-pagewise-translation','');card.attachShadow({mode:'open'}).innerHTML='<section class="card"></section>';doc.body.append(card);
  annotateTranslation({mode:'paragraph',anchor:doc.querySelector('p'),ranges:[range],text:range.toString()},card);
  assert.ok(dom.window.CSS.highlights.has('pagewise-translated'));
  assert.ok(doc.querySelector('style').textContent.includes('underline'));
  assert.equal(doc.querySelector('p').innerHTML,'Selected original words.');
  card.remove();await new Promise(r=>setTimeout(r,0));
  assert.equal(dom.window.CSS.highlights.has('pagewise-translated'),false);
  assert.equal(dom.window.CSS.highlights.has('website-search'),true);
 }finally{dom.window.close();}
});

test('hover highlights only the translated word and clears on Escape, leave and removal',async()=>{
 const dom=new JSDOM('<p><a href="#">Selected</a> original words.</p>',{url:'https://article.test/'});try{
  const win=dom.window,doc=win.document,source=doc.querySelector('p'),before=source.innerHTML;
  const range=doc.createRange();range.selectNodeContents(doc.querySelector('a'));
  range.getClientRects=()=>[{left:10,right:110,top:10,bottom:30,width:100,height:20}];
  win.CSS={highlights:new Map([['website-search',{}]])};win.Highlight=Set;
  const card=doc.createElement('div');card.setAttribute('data-pagewise-translation','');card.attachShadow({mode:'open'}).innerHTML='<section class="card"></section>';doc.body.append(card);
  const cleanup=annotateTranslation({mode:'word',anchor:source,ranges:[range],text:range.toString()},card);
  const move=(x,y)=>doc.dispatchEvent(new win.MouseEvent('pointermove',{clientX:x,clientY:y}));
  move(20,20);
  assert.ok(win.CSS.highlights.get('pagewise-hover')?.has(range),'hovered word is highlighted');
  assert.equal(source.innerHTML,before,'links and original HTML are untouched');
  doc.dispatchEvent(new win.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  assert.equal(win.CSS.highlights.get('pagewise-hover')?.size || 0,0);
  move(200,200);move(20,20);
  assert.equal(win.CSS.highlights.get('pagewise-hover')?.size,1);
  move(200,200);await new Promise(resolve=>setTimeout(resolve,220));
  assert.equal(win.CSS.highlights.get('pagewise-hover')?.size || 0,0);
  move(20,20);cleanup();card.remove();
  assert.equal(win.CSS.highlights.has('pagewise-hover'),false);
  assert.equal(win.CSS.highlights.has('website-search'),true);
 }finally{dom.window.close();}
});
