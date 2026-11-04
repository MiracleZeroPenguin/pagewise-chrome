import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';

const html=await readFile(new URL('../static/options.html',import.meta.url),'utf8');
const script=(await build({entryPoints:['src/options.js'],bundle:true,write:false,format:'iife',loader:{'.svg':'text'},target:'chrome116'})).outputFiles[0].text;
async function until(check){
 for(let n=0;n<100;n++){if(check())return;await new Promise(r=>setTimeout(r,5));}
 throw Error('Settings did not settle');
}
test('settings test uses the entered key, displays redacted provider errors as text, and recovers',async t=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html',runScripts:'outside-only'});
 t.after(()=>dom.window.close());
 const saved={endpoint:'https://open.bigmodel.cn/api/paas/v4/chat/completions',model:'glm-5.3-flash',apiKey:'fake-saved-key'};
 const calls=[];
 dom.window.chrome={storage:{local:{setAccessLevel:async()=>{},get:async()=>({settings:{...saved}})}},permissions:{contains:async()=>true}};
 dom.window.AbortController=AbortController;
 dom.window.fetch=async(url,init)=>{
  calls.push({url,init});
  return calls.length===1
   ?new Response(JSON.stringify({error:{code:'account_test',message:'Denied fake-entered-key <b>literal text</b>'}}),{status:404})
   :new Response(JSON.stringify({choices:[{message:{content:'连接成功'}}]}));
 };
 dom.window.eval(script);
 const $=id=>dom.window.document.getElementById(id);
 await until(()=>$('key-status').textContent.includes('已保存'));
 $('api-key').value='fake-entered-key';$('test-connection').click();
 await until(()=>!$('test-connection').disabled);
 assert.equal(calls[0].init.headers.Authorization,'Bearer fake-entered-key');
 assert.equal(JSON.parse(calls[0].init.body).thinking.type,'enabled');
 assert.equal(JSON.parse(calls[0].init.body).reasoning_effort,'low');
 assert.match($('feedback').textContent,/HTTP 404.*account_test.*Denied/);
 assert.doesNotMatch($('feedback').textContent,/fake-entered-key|fake-saved-key/);
 assert.equal($('feedback').querySelector('b'),null);
 assert.equal($('feedback').classList.contains('error'),true);
 $('api-key').value='';$('test-connection').click();
 await until(()=>!$('test-connection').disabled);
 assert.match($('feedback').textContent,/连接成功/);
 assert.equal(calls[1].init.headers.Authorization,'Bearer fake-saved-key');
 assert.equal(calls[0].url,calls[1].url);
 assert.equal(calls[0].init.body,calls[1].init.body);
});
