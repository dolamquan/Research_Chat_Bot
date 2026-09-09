import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile,writeFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const output=resolve('../benchmarks/results/library-'+(process.argv[2] || 'verified'));
const {results}=JSON.parse(await readFile(output+'/audit.json','utf8'));
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
await writeFile(output+'/index.html',`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scene library previews</title><style>body{margin:24px;background:#0b0b0b;color:#eee;font:14px system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}figure{margin:0;border:1px solid #333;padding:10px}img{width:100%}figcaption{margin-bottom:8px}a{color:#a9c5df}nav{display:flex;gap:16px;margin:12px 0}</style><h1>Scene library previews</h1><p>${results.length/2} saved programs. Open an image at full size to inspect its labels. Phone scenes include a second view after scrolling.</p><main>${results.filter(r=>r.width===900).map(r=>`<figure><figcaption>${escape(r.title)}</figcaption><a href="${r.id}-900.png"><img src="${r.id}-900.png" alt="${escape(r.title)} desktop preview"></a><nav><a href="${r.id}-900.png">Desktop</a><a href="${r.id}-390.png">Phone</a><a href="${r.id}-390-scrolled.png">Phone, scrolled</a></nav></figure>`).join('')}</main></html>`);
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage({viewport:{width:1800,height:1050}});
  await page.goto(pathToFileURL(output+'/index.html').href);
  await page.addStyleTag({content:'main{grid-template-columns:repeat(3,1fr)}figure{height:470px}img{height:420px;object-fit:contain}'});
  const count=await page.locator('figure').count();
  for(let i=0;i<Math.ceil(count/9);i++) {
    await page.evaluate(i=>{for(const [n,f] of [...document.querySelectorAll('figure')].entries()) f.style.display=Math.floor(n/9)===i?'block':'none';},i);
    await page.screenshot({path:output+'/gallery-'+i+'.png',fullPage:true});
  }
} finally {await browser.close();}
