// Compare the same saved dense scene with only the candidate-search algorithm changed.
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
import {compileRuntime} from './runtime-builder.mjs';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const code=execFileSync('python',['-X','utf8','-c',`import sqlite3,json
c=sqlite3.connect('file:../backend/app/data/researchmind.sqlite3?mode=ro',uri=True)
print(json.loads(c.execute("select scene_json from stage_scenes where node_id='feed_forward_network'").fetchone()[0])['code'])`],{encoding:'utf8'});
const source=await readFile('src/app/components/visualization/sceneRuntime.ts','utf8');
const {buildSceneSrcDoc}=await compileRuntime(source);
const optimized=`candidates.sort((a,b) => (a.x-original.x)**2+(a.y-original.y)**2 - (b.x-original.x)**2-(b.y-original.y)**2);
      const clear = candidates.find(candidate => !obstacles.some(other => overlap(candidate,other)));
      if (clear) rect = clear;`;
const original=`const clear = candidates.filter(candidate => !obstacles.some(other => overlap(candidate,other)));
      clear.sort((a,b) => (a.x-original.x)**2+(a.y-original.y)**2 - (b.x-original.x)**2-(b.y-original.y)**2);
      if (clear.length) rect = clear[0];`;
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try {
 for(const round of [0,1,2]) for(const variant of round%2?['optimized','original']:['original','optimized']) {
  const page=await browser.newPage({viewport:{width:900,height:650}});
  await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**',async route=>{
   const rel=new URL(route.request().url()).pathname.split('three@0.170.0/')[1].replace('three.module.min.js','three.module.js');
   await route.fulfill({body:await readFile('node_modules/three/'+rel),contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
  });
  let doc=buildSceneSrcDoc(code,'Feed-Forward Network').replaceAll('\r\n','\n');
  assert(doc.includes(optimized),'Candidate search changed; update the comparison explicitly');
  if(variant==='original') doc=doc.replace(optimized,original);
  doc=doc.replace('let playing = true;',`window.measureLayout=()=>{
   const samples=[];
   for(let i=0;i<120;i++) {restoreLabels(); module_.update(context,8); controls.update();const start=performance.now(); layoutLabels(); if(i>=20)samples.push(performance.now()-start);}
   const positions=[];scene.traverseVisible(o=>{if(labelMetadata.has(o)) positions.push([labelMetadata.get(o).text,...o.position.toArray(),...o.scale.toArray()]);});
   return {samples,positions};
  }; let playing = false;`);
  await page.setContent('<iframe sandbox="allow-scripts" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
  await page.evaluate(doc=>{window.messages=[];addEventListener('message',e=>window.messages.push(e.data));document.querySelector('iframe').srcdoc=doc;},doc);
  await page.waitForFunction(()=>window.messages.some(m=>m.type==='scene-ready'||m.type==='scene-error'));
  const measurement=await page.frames()[1].evaluate(()=>window.measureLayout());
  assert(!(await page.evaluate(()=>window.messages)).some(m=>m.type==='scene-error'));
  results.push({round,variant,...measurement});await page.close();
 }
 for(const result of results) assert.deepEqual(result.positions,results[0].positions,'Placement must stay identical');
 const summary={};
 for(const variant of ['original','optimized']) {
  const samples=results.filter(r=>r.variant===variant).flatMap(r=>r.samples).sort((a,b)=>a-b);
  summary[variant]={samples:samples.length,medianMs:samples[Math.floor(samples.length/2)],p95Ms:samples[Math.floor(samples.length*0.95)]};
 }
 summary.speedup=summary.original.medianMs/summary.optimized.medianMs;
 await writeFile('../benchmarks/results/label-layout-benchmark.json',JSON.stringify({summary,results},null,2));
 console.log(JSON.stringify(summary));
} finally {await browser.close();}
