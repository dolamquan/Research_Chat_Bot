// Set PLAYWRIGHT_MODULE to an installed playwright-core package if it is not
// resolvable locally. All runtime imports are intercepted with local Three.js.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
import {compileRuntime} from './runtime-builder.mjs';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const oldSource=execFileSync('git',['show','HEAD:frontend/src/app/components/visualization/sceneRuntime.ts'],{encoding:'utf8'});
const newSource=await readFile('src/app/components/visualization/sceneRuntime.ts','utf8');
const backup=JSON.parse(await readFile('../backend/app/data/scene-repair-backups/layer_norm-2026-09-07.json','utf8'));
const broken=JSON.parse(backup.scene_json).code;
const scopeFixed=broken.replace('const state = {};','const state = {rightX:6};').replaceAll('const startX = rightX +','const startX = state.rightX +').replaceAll('const endX = rightX +','const endX = state.rightX +');
const revised=await readFile('../backend/tests/fixtures/layer_normalization.js','utf8');
const output='../benchmarks/results';
await mkdir(output,{recursive:true});
async function builder(source){
  source=source.replace('return sprite;', 'sprite.userData.benchmarkLabel = {text:String(text),fontPixels:48,textureHeight:sprite.material.map.image.height}; return sprite;');
  return (await compileRuntime(source)).buildSceneSrcDoc;
}
const builders={original:await builder(oldSource),revised:await builder(newSource)};
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
try {
 for(const [variant,code,runtime] of [['original_broken',broken,'original'],['original_scope_fixed',scopeFixed,'original'],['revised',revised,'revised']]){
  for(const width of variant==='original_broken'?[1132]:[1132,600,390]){
   const page=await browser.newPage({viewport:{width,height:700}});
   await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**',async route=>{
     const rel=new URL(route.request().url()).pathname.split('three@0.170.0/')[1].replace('three.module.min.js','three.module.js');
     await route.fulfill({body:await readFile('node_modules/three/'+rel),contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
   });
   let doc=builders[runtime](code);
   doc=doc.replace('renderer.setAnimationLoop(() => {',`
   const bench={frames:[],costs:[],last:performance.now()};
   window.benchmark=()=>{
     scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
     const labels=[];
     scene.traverse(object=>{
       if(!object.userData.benchmarkLabel || !object.visible) return;
       const label=object.userData.benchmarkLabel;
       const p=object.getWorldPosition(new THREE.Vector3());
       const depth=-p.clone().applyMatrix4(camera.matrixWorldInverse).z;
       const ndc=p.clone().project(camera);
       const scale=object.getWorldScale(new THREE.Vector3());
       labels.push({text:label.text,pixels:label.fontPixels/label.textureHeight*scale.y*renderer.domElement.clientHeight/(2*Math.tan(camera.fov*Math.PI/360)*depth),clipped:Math.abs(ndc.x)>1||Math.abs(ndc.y)>1});
     });
     return {elapsed,playing,canvas_height:renderer.domElement.clientHeight,frames:bench.frames,costs:bench.costs,draw_calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,memory:renderer.info.memory,labels,error:errorEl.textContent,errorVisible:errorEl.style.display==='grid'};
   };
   window.exercise=()=>{
     for(const t of [0,1,3,5,7,9,11,12,24]) {if(typeof restoreLabels === "function") restoreLabels(); module_.update(makeContext(),t);}
   };
   renderer.setAnimationLoop(() => {
     const frameStart=performance.now(); bench.frames.push(frameStart-bench.last);bench.last=frameStart;
   `);
   doc=doc.replace('  if (!announced &&', '  bench.costs.push(performance.now()-frameStart);\n  if (!announced &&');
   await page.setContent('<body style="margin:0"><iframe sandbox="allow-scripts" style="border:0;width:100vw;height:100vh"></iframe></body>');
   const start=performance.now();
   await page.evaluate(doc=>{window.messages=[];window.addEventListener('message',e=>window.messages.push(e.data));document.querySelector('iframe').srcdoc=doc;},doc);
   await page.waitForFunction(()=>window.messages.some(m=>m.type==='scene-ready'||m.type==='scene-error'));
   const readyMs=performance.now()-start;
   const frame=page.frames()[1];
   let exerciseError=null;
   try{await frame.evaluate(()=>window.exercise());}catch(error){exerciseError=error.message.split('\n')[0];}
   await page.waitForTimeout(2200);
   const initial=await frame.evaluate(()=>window.benchmark());
   await page.screenshot({path:`${output}/${variant}-${width}.png`});
   let scrollable=false;
   if(initial.canvas_height>700){
     scrollable=await frame.evaluate(()=>{window.scrollTo(0,10000);return window.scrollY>0;});
     await page.screenshot({path:`${output}/${variant}-${width}-bottom.png`});
     await frame.evaluate(()=>window.scrollTo(0,0));
   }
   await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'scene-control',action:'pause'},'*'));
   await page.waitForTimeout(80);
   const pausedAt=await frame.evaluate(()=>window.benchmark().elapsed);
   await page.waitForTimeout(120);
   const pausePassed=Math.abs(await frame.evaluate(()=>window.benchmark().elapsed)-pausedAt)<.001;
   await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'scene-control',action:'play'},'*'));
   await page.waitForTimeout(120);
   const resumePassed=await frame.evaluate(()=>window.benchmark().elapsed)>pausedAt;
   for(let i=0;i<5;i++){
     await page.evaluate(()=>document.querySelector('iframe').contentWindow.postMessage({type:'scene-control',action:'restart'},'*'));
     await page.waitForTimeout(100);
   }
   const restarted=await frame.evaluate(()=>window.benchmark());
   const percentile=(a,p)=>[...a].sort((x,y)=>x-y)[Math.floor((a.length-1)*p)]??null;
   const intervals=initial.frames.slice(5);
   const result={variant,width,ready_ms:readyMs,exercise_error:exerciseError,runtime_error:initial.errorVisible,frame_interval_median_ms:percentile(intervals,.5),frame_interval_p95_ms:percentile(intervals,.95),frame_cpu_median_ms:percentile(initial.costs.slice(5),.5),frame_cpu_p95_ms:percentile(initial.costs.slice(5),.95),draw_calls:initial.draw_calls,triangles:initial.triangles,memory:initial.memory,memory_after_5_restarts:restarted.memory,label_count:initial.labels.length,labels_below_12px:initial.labels.filter(l=>l.pixels<12).length,clipped_labels:initial.labels.filter(l=>l.clipped).length,smallest_label_px:Math.min(...initial.labels.map(l=>l.pixels)),messages:await page.evaluate(()=>window.messages)};
   Object.assign(result,{scrollable,canvas_height:initial.canvas_height,pause_passed:pausePassed,resume_passed:resumePassed});
   results.push(result);
   await writeFile(`${output}/browser.json`,JSON.stringify({environment:'Headless Chromium with software WebGL (SwiftShader), local Three.js modules; not representative mobile GPU performance',results},null,2));
   console.log(JSON.stringify(result));
   await page.close();
  }
 }
}finally{await browser.close();}
