import {build} from 'esbuild';
import {mkdir,copyFile,rm,cp} from 'node:fs/promises';
await rm('dist',{recursive:true,force:true});await mkdir('dist',{recursive:true});
await build({entryPoints:['src/content.js','src/background.js','src/panel.js','src/options.js'],bundle:true,outdir:'dist',format:'iife',loader:{'.svg':'text'},target:'chrome116',logLevel:'info'});
for(const file of ['panel.html','options.html','styles.css'])await copyFile(`static/${file}`,`dist/${file}`);
await copyFile('manifest.json','dist/manifest.json');

await copyFile('icon.svg','dist/icon.svg');
await copyFile('init_icon.svg','dist/init_icon.svg');
await cp('static/icons','dist/icons',{recursive:true});
await mkdir('dist/licenses',{recursive:true});
await copyFile('node_modules/@mozilla/readability/LICENSE.md','dist/licenses/readability-Apache-2.0.txt');
await copyFile('THIRD_PARTY_NOTICES.md','dist/THIRD_PARTY_NOTICES.md');
