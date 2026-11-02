import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { poll } from './browser-helpers.mjs';

const root = path.resolve(import.meta.dirname, '..');
const extensionPath = process.env.PAGEWISE_EXTENSION_PATH || path.join(root, 'dist');
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(path.join(tmpdir(), 'pagewise-e2e-'));
const paragraphs = [
  'Reading with evidence helps people understand complex ideas. Every useful summary should let the reader return to the original source, verify a claim, and decide whether to read more. A reading assistant can preserve the relationship between a summary and the article.',
  'Translation is most helpful when it follows the reader’s attention. Instead of translating every sentence in advance, a tool can translate a selected paragraph on demand. The original language remains available for comparison and technical terms retain their meaning.',
  'Questions should be answered from the article itself. When the source does not contain enough information, the assistant should say so clearly. This prevents a fluent but unsupported answer from being mistaken for something the author actually wrote.',
  'Reliable interfaces keep each document separate. If a reader changes tabs while a summary is being generated, an earlier request must not overwrite the new article. References also need to be checked again when the source content changes.'
];
const server = createServer((req, res) => {
  if (req.url.startsWith('/selection-only')) {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    res.end('<!doctype html><title>Selection sandbox</title><body><span id="selection-only">Ser<strong>endi</strong>pity</span></body>');
    return;
  }
  const second = req.url.startsWith('/second');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...(req.url.startsWith('/strict') ? {'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'none'"} : {}) });
  res.end(`<!doctype html><html lang="en"><head><title>${second ? 'Second article' : 'Reading with evidence'}</title><style>body{margin:0;background:#faf9f5;color:#253c39;font:18px/1.9 Georgia,serif}nav{padding:18px 10%;border-bottom:1px solid #ddd;font:14px Arial}article{max-width:680px;margin:80px auto 260px}h1{font-size:46px;line-height:1.2}p{margin:30px 0}</style></head><body><nav>THE READING JOURNAL · IDEAS & TECHNOLOGY</nav><article><h1>${second ? 'Second article' : 'Reading with evidence'}</h1><p class="byline">November 2, 2026 · A five-minute read</p>${paragraphs.map((p,i)=>`<p id="source-${i}">${second ? `Another document: ${p}` : p}</p>`).join('')}</article></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: process.env.PAGEWISE_HEADED !== '1',
    args: [`--window-size=1440,${process.env.PAGEWISE_TEST_HEIGHT || 1000}`, `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    // Native viewport avoids clipping extension iframe input near the bottom in emulated viewports.
    viewport: null
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  console.log('Extension loaded:', extensionId);
  let requests = [], mode = 'summary', delayedResponse, nextResponseGate;
  function holdNextResponse() {
    let release;
    nextResponseGate = new Promise(resolve => { release = resolve; });
    return release;
  }
  async function checkLoading(container, filename) {
    const indicator = container.locator('.pw-loading');
    await indicator.waitFor({state:'visible'});
    assert.equal(await indicator.locator('svg').getAttribute('viewBox'),'-50 -40 355 410');
    assert.equal(await indicator.locator('.penguin').evaluate(el=>getComputedStyle(el).animationName),'penguin-search');
    assert.equal(await indicator.locator('progress').getAttribute('value'),null,'loading is indeterminate');
    await container.screenshot({path:path.join(artifacts,filename)});
  }
  await context.route('https://open.bigmodel.cn/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body);
    const requestMode = mode;
    const gate = nextResponseGate; nextResponseGate = null;
    if (gate) await gate;
    const payload = requestMode === 'connection' ? {} : JSON.parse(body.messages.at(-1).content);
    const ids = (payload.article?.paragraphs || []).filter(p => p.text.includes('Reading with evidence') || p.text.includes('Translation is most helpful') || p.text.includes('Questions should be answered')).map(p => p.id);
    if (mode === 'delayed') await new Promise(resolve => { delayedResponse = resolve; });
    const text = requestMode === 'connection' ? '连接成功' : requestMode === 'translation' ? (payload.quotedSelection === 'Serendipity' ? '意外发现的美好' : '有依据的阅读能帮助人们理解复杂观点。') : requestMode === 'question'
      ? JSON.stringify({answer:'本文强调摘要应当提供可核对的原文依据。',sourceIds:[ids[0] || 'p1']})
      : JSON.stringify({overview:'这篇文章介绍如何通过摘要、按需翻译和原文引用提升阅读效率。',points:[
        {text:'摘要应当关联原文，让读者核对结论。',sourceIds:[ids[0] || 'p1']},
        {text:'翻译跟随读者选择，保留原文与专业术语。',sourceIds:[ids[1] || 'p2']},
        {text:'追问仅依据本文，缺少信息时明确说明。',sourceIds:[ids[2] || 'p3']}
      ]});
    await route.fulfill({status:requestMode === 'error' ? 401 : 200,contentType:'application/json',body:JSON.stringify({choices:[{message:{content:text}}]})}).catch(error => {if(requestMode!=='delayed')throw error;});
  });
  async function embedded(page) {
    let frame;
    await poll(() => {frame=page.frames().find(f=>f.url().startsWith(`chrome-extension://${extensionId}/panel.html`));return frame;});
    return frame;
  }
  async function waitText(frame, selector, text) {
    try { await frame.locator(selector).filter({hasText:text}).waitFor({timeout:15000}); }
    catch (error) { console.log('Panel assertion failed:',selector,await frame.locator('body').innerText()); throw error; }
  }
  async function select(page, selector) {
    await page.locator(selector).evaluate(element => {
      const range=document.createRange();range.selectNodeContents(element);
      const selected=getSelection();selected.removeAllRanges();selected.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await page.locator('#translate-selection').click();
  }
  async function alignedTranslation(page, selector) {
    await poll(() => page.locator(selector).evaluate(source => {
      const translation = source.nextElementSibling;
      if (!translation?.matches('[data-pagewise-translation]')) return false;
      const original = source.getBoundingClientRect(), box = translation.shadowRoot.querySelector('.card').getBoundingClientRect();
      return Math.abs(original.left - box.left) < 1 && Math.abs(original.right - box.right) < 1;
    }));
  }
  const article = await context.newPage();
  await article.goto(base);
  const launcher=article.locator('#open-panel'), launcherLabel=launcher.locator('.launcher-label');
  await launcher.waitFor();
  assert.equal(await launcher.locator('svg').getAttribute('viewBox'),'0 0 254.46 329.32');
  assert.equal(await launcher.locator('svg .cls-1').first().evaluate(el=>getComputedStyle(el).fill),'rgb(247, 204, 50)','the supplied full-color SVG is rendered');
  assert.equal(await launcherLabel.evaluate(el=>el.getBoundingClientRect().width),0,'launcher starts as icon only');
  const compactWidth=(await launcher.boundingBox()).width;
  await launcher.screenshot({path:path.join(artifacts,'launcher-icon.png')});
  await launcher.hover();
  await poll(()=>launcherLabel.evaluate(el=>getComputedStyle(el).opacity==='1'));
  assert.ok((await launcher.boundingBox()).width>compactWidth+20,'hover reveals the product name');
  await launcher.screenshot({path:path.join(artifacts,'launcher-hover.png')});
  await article.mouse.move(0,0);
  await poll(()=>launcherLabel.evaluate(el=>el.getBoundingClientRect().width===0));
  await article.keyboard.press('Tab');
  await poll(()=>launcher.evaluate(el=>el.matches(':focus-visible')));
  await poll(()=>launcherLabel.evaluate(el=>getComputedStyle(el).opacity==='1'));
  await article.locator('#panel-shell').evaluate(el=>el.addEventListener('animationstart',()=>{
    const animation=el.getAnimations()[0];
    animation.pause();animation.currentTime=130;
  },{once:true}));
  await article.locator('#open-panel').click();
  let panel = await embedded(article);
  await poll(()=>article.locator('#panel-shell').evaluate(el=>el.getAnimations().some(a=>a.playState==='paused')));
  const motion=await article.locator('#panel-shell').evaluate(async el=>{
    const during=el.getBoundingClientRect().x;
    const animation=el.getAnimations()[0];
    animation.play();await animation.finished;
    return {during,end:el.getBoundingClientRect().x,right:innerWidth,transform:getComputedStyle(el).transform};
  });
  assert.ok(motion.during>motion.end && motion.during<motion.right,'panel moves in from the right');
  assert.equal(motion.transform,'none','finished animation leaves no transformed iframe');
  await waitText(panel,'#status','API Key');
  await poll(()=>panel.locator('#summary .empty-symbol').evaluate(el=>el.complete && el.naturalWidth>0));
  assert.equal(await panel.locator('#summary .empty-symbol').getAttribute('src'),'init_icon.svg');
  await panel.locator('#summary-view').screenshot({path:path.join(artifacts,'panel-initial-state.png')});
  await poll(()=>panel.locator('.brand-logo').evaluate(el=>el.complete && el.naturalWidth>0));
  assert.equal(await panel.locator('#close-panel').evaluate(el=>el.matches(':focus')) ,false,'opening does not focus the close button');
  assert.equal(await panel.locator('#close-panel').evaluate(el=>getComputedStyle(el).outlineStyle),'none');
  await panel.locator('#settings').focus();
  await panel.locator('#settings').press('Tab');
  assert.equal(await panel.locator('#close-panel').evaluate(el=>el.matches(':focus-visible')),true,'keyboard navigation retains the focus indicator');
  await panel.locator('#close-panel').press('Tab');
  assert.equal(requests.length,0);
  assert.equal(context.pages().some(p=>p.url().includes('/panel.html')),false,'no native browser side-panel page');
  const options=await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  await poll(()=>options.locator('.brand-icon').evaluate(el=>el.complete && el.naturalWidth>0));
  await options.locator('#api-key').fill('test-only-not-a-real-key');
  await options.locator('#save').click();
  await options.locator('#feedback').filter({hasText:'保存'}).waitFor();
  await options.close(); await article.bringToFront();
  let releaseLoading = holdNextResponse();
  await article.locator('#open-panel').click();
  await checkLoading(panel.locator('#summary-loading'),'loading-summary.png');
  assert.equal(await panel.locator('#status').isVisible(),false,'summary has no top loading banner');
  assert.equal(await panel.locator('#summary').isVisible(),false,'loading replaces the initial illustration and copy');
  assert.equal(await panel.locator('#summary-loading').innerText(),'正在生成摘要...');
  await panel.locator('#summary-view').screenshot({path:path.join(artifacts,'summary-generating.png')});
  releaseLoading();
  await waitText(panel,'#summary','摘要应当关联原文');
  assert.equal(await panel.locator('.pw-loading').count(),0,'summary replaces its loading indicator');
  assert.equal(requests.length,1);
  assert.equal(await panel.locator('.overview .card-kicker, footer').count(),0);
  const fontSize = locator => locator.evaluate(el=>getComputedStyle(el).fontSize);
  assert.equal(await fontSize(panel.locator('.overview p')),'14.4px');
  assert.equal(await fontSize(panel.locator('.point p').first()),'14.4px');
  await article.locator('body').evaluate(el=>el.style.fontSize='20px');
  await poll(async()=>await fontSize(panel.locator('.overview p'))==='16px');
  assert.equal(await fontSize(panel.locator('#question')),'16px');
  assert.equal(requests.length,1,'font changes never request another summary');
  await article.locator('body').evaluate(el=>el.style.fontSize='18px');
  await poll(async()=>await fontSize(panel.locator('.overview p'))==='14.4px');
  const pageBounds=await article.locator('article').boundingBox();
  const panelBounds=await article.locator('#pagewise-frame').boundingBox();
  assert.ok(pageBounds.x+pageBounds.width<=panelBounds.x,'desktop reading content is not hidden behind the panel');
  await article.screenshot({path:path.join(artifacts,'custom-panel.png')});
  await article.locator('#pagewise-frame').screenshot({path:path.join(artifacts,'panel-summary.png')});
  console.log('PASS: embedded panel with no native titlebar, settings save and summary.');
  await panel.locator('#summary .citation').first().click();
  await poll(()=>article.evaluate(()=>document.getAnimations().length>0));
  await article.locator('#open-panel').click();
  await waitText(panel,'#status','已载入');assert.equal(requests.length,1);
  await panel.locator('#tab-question').click();
  assert.equal(await panel.locator('#summary-view').isVisible(),false);
  const composerBefore=await panel.locator('#question-form').boundingBox();
  assert.ok(composerBefore.y+composerBefore.height>panelBounds.height-24,'composer is at the bottom');
  await panel.locator('#question').fill('先保留这条草稿');
  await panel.locator('#tab-summary').click();
  await panel.locator('#tab-summary').press('ArrowRight');
  assert.equal(await panel.locator('#question').inputValue(),'先保留这条草稿');
  assert.equal(requests.length,1,'switching tabs does not request the model');
  mode='question';await panel.locator('#question').fill('作者为什么强调原文依据？');
  await panel.locator('#question-form').evaluate(el=>el.scrollIntoView({block:'center'}));
  releaseLoading = holdNextResponse();
  await panel.locator('#ask').click();
  await checkLoading(panel.locator('#status'),'loading-question.png');
  const answerRequestCount = requests.length;
  await panel.locator('#close-panel').click();
  await article.locator('#pagewise-frame').waitFor({state:'hidden'});
  await article.locator('#open-panel').click();
  assert.equal(await embedded(article),panel,'reopening keeps the same live iframe');
  assert.equal(await panel.locator('#tab-question').getAttribute('aria-selected'),'true');
  assert.equal(await panel.locator('#question').inputValue(),'作者为什么强调原文依据？');
  assert.equal(await panel.locator('#status .pw-loading').count(),1,'in-flight answer is not cancelled');
  assert.equal(requests.length,answerRequestCount,'reopening does not start another request');
  releaseLoading();
  await waitText(panel,'#chat','本文强调摘要');
  assert.equal(await panel.evaluate(()=>scrollY),0,'only the main reading area scrolls');
  assert.equal((await panel.locator('.masthead').boundingBox()).y,0,'header remains at the top');
  assert.ok(requests.at(-1).messages.some(m=>m.content.includes('Reading with evidence')));
  assert.equal(await panel.locator('#chat .citation').count(),1);
  const composerAfter=await panel.locator('#question-form').boundingBox();
  assert.ok(Math.abs(composerBefore.y-composerAfter.y)<1,'answer does not move the composer');
  await article.locator('#pagewise-frame').screenshot({path:path.join(artifacts,'panel-question.png')});
  const answerText=await panel.locator('#chat .chat-answer p').innerText();
  await panel.locator('#chat .chat-answer p').evaluate(el=>el.textContent=el.textContent.repeat(100));
  await panel.locator('#chat').evaluate(el=>el.scrollTop=el.scrollHeight);
  assert.ok(await panel.locator('#chat').evaluate(el=>el.scrollHeight>el.clientHeight));
  assert.ok(Math.abs((await panel.locator('#question-form').boundingBox()).y-composerBefore.y)<1,'long conversations scroll above a stationary composer');
  await panel.locator('#question').fill('保留这条尚未发送的追问');
  const chatScroll = await panel.locator('#chat').evaluate(el=>el.scrollTop);
  const chatContent = await panel.locator('#chat').textContent();
  await panel.locator('#close-panel').click();
  await article.locator('#pagewise-frame').waitFor({state:'hidden'});
  await article.locator('#open-panel').click();
  assert.equal(await panel.locator('#tab-question').getAttribute('aria-selected'),'true');
  assert.equal(await panel.locator('#question').inputValue(),'保留这条尚未发送的追问');
  assert.equal(await panel.locator('#chat').textContent(),chatContent);
  assert.equal(await panel.locator('#chat').evaluate(el=>el.scrollTop),chatScroll);
  assert.equal(requests.length,answerRequestCount);
  // Cross-origin iframe clicks need the ancestor entrance transform to settle.
  await article.locator('#panel-shell').evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished));});
  await panel.locator('#chat .chat-answer p').evaluate((el,text)=>el.textContent=text,answerText);
  await panel.locator('#tab-summary').click();
  assert.equal(await panel.locator('#tab-summary').getAttribute('aria-selected'),'true');
  assert.equal(await panel.locator('#summary .point').count(),3,'summary survives tab switches');
  mode='translation';
  await article.locator('#source-0').evaluate(p=>{
    p.style.marginLeft='40px'; p.style.marginRight='28px';
    const range=document.createRange();range.setStart(p.firstChild,20);range.setEnd(p.firstChild,145);
    getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  releaseLoading = holdNextResponse();
  await article.locator('#translate-selection').click();
  await checkLoading(article.locator('[data-pagewise-translation] .card'),'loading-paragraph.png');
  releaseLoading();
  await article.locator('[data-pagewise-translation] .text').filter({hasText:'有依据的阅读能帮助'}).waitFor();
  assert.equal(await article.locator('[data-pagewise-translation] .pw-loading').count(),0);
  assert.equal(await panel.locator('#summary-view').isVisible(),true,'translation leaves the summary panel unchanged');
  assert.equal(await article.locator('#source-0 + [data-pagewise-translation]').count(),1);
  await alignedTranslation(article,'#source-0');
  await article.locator('#source-0').evaluate(p=>{p.style.width='70%';p.style.marginLeft='auto';p.style.marginRight='auto';});
  await alignedTranslation(article,'#source-0');
  await article.locator('article').evaluate(el=>el.style.width='540px');
  await alignedTranslation(article,'#source-0');
  await article.locator('article').evaluate(el=>el.style.removeProperty('width'));
  await article.locator('#source-0').evaluate(p=>{p.style.removeProperty('width');p.style.marginLeft='40px';p.style.marginRight='28px';});
  await alignedTranslation(article,'#source-0');
  const translationCard=article.locator('#source-0 + [data-pagewise-translation] .card');
  assert.equal(await fontSize(translationCard),'16.2px');
  await article.locator('#source-0').evaluate(el=>el.style.fontSize='20px');
  await poll(async()=>await fontSize(translationCard)==='18px');
  await article.locator('#source-0').evaluate(el=>el.style.fontSize='18px');
  await poll(async()=>await fontSize(translationCard)==='16.2px');
  await article.screenshot({path:path.join(artifacts,'inline-translation.png')});
  assert.equal(JSON.parse(requests.at(-1).messages.at(-1).content).quotedSelection,paragraphs[0],'partial long selection expands to the complete paragraph');
  assert.equal(await article.evaluate(()=>getSelection().toString()),'');
  console.log('PASS: page stays interactive for source highlighting, Q&A and selected-text translation.');

  const second=await context.newPage();await second.goto(base+'/second');await second.bringToFront();
  assert.equal(await second.locator('#pagewise-frame').count(),0);
  assert.equal(requests.length,3);
  mode='error';await second.locator('#open-panel').click();const secondPanel=await embedded(second);
  await waitText(secondPanel,'#status','API Key');
  mode='summary';await secondPanel.locator('#retry').click();await waitText(secondPanel,'#summary','摘要应当关联原文');
  mode='delayed';await secondPanel.locator('#summarize').click();await poll(()=>delayedResponse);
  await article.bringToFront();await waitText(panel,'#article-title','Reading with evidence');delayedResponse();
  assert.equal(requests.length,6);
  assert.equal((await panel.locator('#summary').textContent()).includes('摘要应当关联原文'),false);
  console.log('PASS: panels are bound to their own tabs, auth retry works, stale requests cannot cross pages.');

  mode='translation';await article.goto(base+'/selection-only');
  await article.locator('#selection-only strong').evaluate(el=>{
    const range=document.createRange();range.setStart(el.firstChild,1);range.setEnd(el.firstChild,3);
    getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  releaseLoading = holdNextResponse();
  await article.locator('#translate-selection').click();
  const wordPopup=article.locator('[data-pagewise-translation][data-mode=word] .card');
  assert.equal(await wordPopup.isVisible(),false,'word translation waits for hover');
  assert.equal(await wordPopup.locator('.close').count(),0,'hover translations have no close button');
  const hoveredOriginal=()=>article.evaluate(()=>[...(CSS.highlights.get('pagewise-hover') || [])].map(range=>range.toString()).join(''));
  await article.locator('#selection-only').hover({position:{x:2,y:8}});
  await checkLoading(wordPopup,'loading-word.png');
  await article.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await wordPopup.locator('.penguin').evaluate(el=>getComputedStyle(el).animationName),'none');
  await article.emulateMedia({reducedMotion:'no-preference'});
  releaseLoading();
  await wordPopup.locator('.text').filter({hasText:'意外发现的美好'}).waitFor();
  assert.equal(await hoveredOriginal(),'Serendipity','the complete source word receives the hover highlight');
  assert.equal(await fontSize(wordPopup),'14.4px');
  await article.locator('#selection-only').evaluate(el=>el.style.fontSize='20px');
  await poll(async()=>await fontSize(wordPopup)==='18px');
  await wordPopup.hover();
  await article.waitForTimeout(250);assert.equal(await wordPopup.isVisible(),true,'popup remains hoverable');
  await article.screenshot({path:path.join(artifacts,'word-hover-translation.png')});
  await article.keyboard.press('Escape');
  assert.equal(await wordPopup.isVisible(),false);
  assert.equal(await hoveredOriginal(),'');
  await article.mouse.move(400,400);await article.locator('#selection-only').hover({position:{x:2,y:8}});
  await wordPopup.waitFor({state:'visible'});
  await article.mouse.move(600,500);await wordPopup.waitFor({state:'hidden'});
  assert.equal(await hoveredOriginal(),'');
  await article.locator('.word-trigger').focus();await wordPopup.waitFor({state:'visible'});
  assert.equal(await article.locator('#pagewise-frame').count(),0,'translation never opens the side panel');
  assert.equal(JSON.parse(requests.at(-1).messages.at(-1).content).quotedSelection,'Serendipity');
  await article.keyboard.press('Escape');
  await wordPopup.waitFor({state:'hidden'});
  assert.equal(await hoveredOriginal(),'');
  assert.equal(await article.locator('#selection-only').textContent(),'Serendipity');
  console.log('PASS: completed word highlights on hover; the popup has no close button and dismisses without changing original text.');

  mode='summary';await article.goto(base+'/strict');await article.locator('#open-panel').click();panel=await embedded(article);
  await waitText(panel,'#summary','摘要应当关联原文');
  const before=requests.length;await panel.locator('#close-panel').focus();await article.keyboard.press('Escape');
  await article.locator('#pagewise-frame').waitFor({state:'hidden'});
  await article.emulateMedia({reducedMotion:'reduce'});
  await article.locator('#open-panel').click();panel=await embedded(article);await waitText(panel,'#summary','摘要应当关联原文');
  assert.equal(await article.locator('#panel-shell').evaluate(el=>getComputedStyle(el).animationName),'none','reduced motion opens immediately');
  await article.emulateMedia({reducedMotion:'no-preference'});
  await article.locator('#panel-shell').evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished));});
  assert.equal(requests.length,before,'reopening restores the existing summary without another request');
  // Escape in the webpage also hides without resetting, and a resize while
  // hidden must not restore the reserved sidebar gutter.
  await article.locator('article h1').click();
  await article.keyboard.press('Escape');
  await article.locator('#pagewise-frame').waitFor({state:'hidden'});
  await article.evaluate(()=>dispatchEvent(new Event('resize')));
  assert.equal(await article.evaluate(()=>document.documentElement.style.paddingRight),'');
  await article.locator('#open-panel').click();
  assert.equal(requests.length,before);
  await article.locator('#panel-shell').evaluate(async el=>{await Promise.all(el.getAnimations().map(a=>a.finished));});
  await article.setViewportSize({width:360,height:780});
  const bounds=await article.locator('#pagewise-frame').boundingBox();assert.ok(bounds.width<=360 && bounds.x>=0);
  await article.screenshot({path:path.join(artifacts,'custom-panel-narrow.png')});
  await panel.locator('#tab-question').click();
  const narrowComposer=await panel.locator('#question-form').boundingBox();
  assert.ok(narrowComposer.x>=0 && narrowComposer.x+narrowComposer.width<=360);
  assert.ok(narrowComposer.y+narrowComposer.height<=780 && narrowComposer.y+narrowComposer.height>=750);
  await article.locator('#pagewise-frame').screenshot({path:path.join(artifacts,'panel-question-narrow.png')});
  await panel.locator('#tab-summary').click();
  console.log('PASS: strict page CSP, Escape/reopen, and narrow viewport.');
  await context.route('http://insecure-article.test/**', route => route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><title>HTTP article</title><article>${paragraphs.map(p=>`<p>${p}</p>`).join('')}</article>`}));
  await article.goto('http://insecure-article.test/');
  assert.equal(await article.evaluate(()=>isSecureContext),false);
  await article.locator('#open-panel').click();panel=await embedded(article);
  await waitText(panel,'#summary','摘要应当关联原文');
  console.log('PASS: ordinary HTTP pages work without crypto.randomUUID.');
  await panel.locator('#close-panel').click();
  await article.locator('article p').first().evaluate(p=>{p.style.marginLeft='10px';p.style.marginRight='24px';const hidden=document.createElement('span');hidden.hidden=true;hidden.textContent='HIDDEN_PRIVATE_SENTINEL';p.append(hidden);});
  mode='error';await select(article,'article p:first-child');
  await article.locator('[data-pagewise-translation] .text').filter({hasText:'API Key'}).waitFor();
  mode='translation';await article.locator('[data-pagewise-translation] .retry').click();
  await article.locator('[data-pagewise-translation] .text').filter({hasText:'有依据的阅读能帮助'}).waitFor();
  assert.ok(!requests.at(-1).messages.at(-1).content.includes('HIDDEN_PRIVATE_SENTINEL'));
  assert.equal(await article.locator('#pagewise-frame').isVisible(),false);
  const inlineBounds=await article.locator('[data-pagewise-translation]').boundingBox();
  assert.ok(inlineBounds.width<=360);
  await alignedTranslation(article,'article p:first-child');
  await article.screenshot({path:path.join(artifacts,'inline-translation-narrow.png')});
  await article.locator('[data-pagewise-translation] .close').click();
  await article.locator('article').evaluate(el=>{
    const ps=el.querySelectorAll('p'),range=document.createRange();range.setStart(ps[0],0);range.setEndAfter(ps[1]);
    getSelection().removeAllRanges();getSelection().addRange(range);document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
  });
  await article.locator('#translate-selection').click();
  await article.locator('[data-pagewise-translation] .text').filter({hasText:'有依据的阅读能帮助'}).last().waitFor();
  assert.equal(await article.locator('article p:nth-of-type(2) + [data-pagewise-translation]').count(),1);
  assert.equal(await article.locator('[data-pagewise-translation][data-mode=paragraph]').count(),2,'each complete paragraph has its own translation');
  await alignedTranslation(article,'article p:first-child');
  await alignedTranslation(article,'article p:nth-of-type(2)');
  console.log('PASS: inline retry, hidden-text exclusion, narrow layout and multi-paragraph placement.');
  mode='summary';await article.locator('#open-panel').click();panel=await embedded(article);
  await waitText(panel,'#summary','摘要应当关联原文');
  // Keep the old content script alive across an actual extension reload.
  // A page refresh must be explicit, and must restore a usable launcher.
  await panel.locator('#close-panel').click();
  const manager = await context.newPage();
  await manager.goto('chrome://extensions/');
  await manager.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true}));
  await manager.evaluate(id => chrome.developerPrivate.reload(id), extensionId);
  await manager.close();
  await article.bringToFront();
  await poll(() => !context.serviceWorkers().includes(worker));
  await article.locator('#open-panel').click();
  await article.locator('#toast-message').filter({hasText:'扩展已更新'}).waitFor();
  assert.equal(await article.locator('#pagewise-frame').count(),0);
  assert.equal(article.url(),'http://insecure-article.test/','no automatic page reload or navigation');
  await article.locator('#reload-page').click();
  await article.waitForLoadState('domcontentloaded');
  await article.locator('#open-panel').click();panel=await embedded(article);
  await waitText(panel,'#summary','摘要应当关联原文');
  console.log('PASS: actual extension reload shows recovery; explicit refresh restores the panel and saved settings.');
  const connectionSettings = await context.newPage();
  await connectionSettings.goto(`chrome-extension://${extensionId}/options.html`);
  await connectionSettings.locator('#key-status').filter({hasText:'已保存'}).waitFor();
  mode='connection'; releaseLoading = holdNextResponse();
  await connectionSettings.locator('#test-connection').click();
  await checkLoading(connectionSettings.locator('#feedback'),'loading-settings.png');
  releaseLoading();
  await waitText(connectionSettings,'#feedback','连接成功');
  assert.equal(await connectionSettings.locator('.pw-loading').count(),0);
  console.log('PASS: shared penguin loading for summary, question, paragraph, word and settings; reduced motion and completion cleanup.');
} finally {
  await context?.close();
  await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true});
}
