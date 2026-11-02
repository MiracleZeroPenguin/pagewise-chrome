import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';
const root = new URL('../', import.meta.url);
const svg = await readFile(new URL('icon.svg', root), 'utf8');
const browser = await chromium.launch({channel:'chromium',headless:true});
try {
  const page = await browser.newPage();
  const images = await page.evaluate(async source => {
    const doc = new DOMParser().parseFromString(source,'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('Invalid source SVG');
    const svg = doc.documentElement, view = svg.viewBox.baseVal;
    const width = view.width, height = view.height;
    if (!(width > 0 && height > 0)) throw new Error('SVG requires a valid viewBox');
    svg.setAttribute('width',width); svg.setAttribute('height',height);
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
    try {
      const image = new Image(); image.src = url; await image.decode();
      return [16,32,48,128].map(size => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const context = canvas.getContext('2d');
        const inset = size / 16, scale = (size - inset * 2) / Math.max(width,height);
        context.drawImage(image,(size-width*scale)/2,(size-height*scale)/2,width*scale,height*scale);
        return {size,png:canvas.toDataURL('image/png').split(',')[1]};
      });
    } finally { URL.revokeObjectURL(url); }
  },svg);
  await mkdir(new URL('static/icons/',root),{recursive:true});
  for (const {size,png} of images) {
    await writeFile(new URL(`static/icons/icon-${size}.png`,root),Buffer.from(png,'base64'));
    console.log(`Generated ${size}×${size} icon`);
  }
} finally { await browser.close(); }
