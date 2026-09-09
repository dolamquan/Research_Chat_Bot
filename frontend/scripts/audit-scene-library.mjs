// Runs every saved scene program, using read-only SQLite and local Three assets.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
import {compileRuntime} from './runtime-builder.mjs';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const records=process.env.SCENE_FIXTURE ? [{scene_id:'scientific-demo',scene_json:JSON.stringify({title:'A vector through a learned transformation',code:await readFile(process.env.SCENE_FIXTURE,'utf8')})}] : JSON.parse(execFileSync('python',['-c',`import sqlite3,json
c=sqlite3.connect('file:../backend/app/data/researchmind.sqlite3?mode=ro',uri=True);c.row_factory=sqlite3.Row
print(json.dumps([{**dict(r),'table':t} for t in ['stage_scenes','algorithm_scenes'] for r in c.execute('select * from '+t)]))`],{encoding:'utf8',maxBuffer:16*1024*1024}));
const source=await readFile('src/app/components/visualization/sceneRuntime.ts','utf8');
const helpers=await readFile('src/app/components/visualization/scientificHelpers.ts','utf8');
const {buildSceneSrcDoc}=await compileRuntime(source);
const run=process.argv[2] || 'current';
const output=`../benchmarks/results/library-${run}`;await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[],unsupported=[];
try {
 for(const record of records.filter(r=>!process.env.SCENE_NODE || r.node_id===process.env.SCENE_NODE)) {
  const sceneDoc=JSON.parse(record.scene_json);
  if(typeof sceneDoc.code!=='string') {unsupported.push({id:record.scene_id,title:sceneDoc.title,format:sceneDoc.schema_version});continue;}
  const id=record.stage_scene_id || record.scene_id;
  for(const width of [900,390]) {
   const page=await browser.newPage({viewport:{width,height:650}});
   const errors=[]; page.on('pageerror',error=>errors.push(error.message));
   await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**',async route=>{
    const rel=new URL(route.request().url()).pathname.split('three@0.170.0/')[1].replace('three.module.min.js','three.module.js');
    await route.fulfill({body:await readFile('node_modules/three/'+rel),contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
   });
   let doc=buildSceneSrcDoc(sceneDoc.code,sceneDoc.title);
   doc=doc.replace('let playing = true;',`function authoredMaterials() {
 const rows=[];scene.traverse(o=>{for(const m of (Array.isArray(o.material)?o.material:o.material?[o.material]:[]))rows.push([m.uuid,m.color?.toArray(),m.emissive?.toArray(),m.roughness,m.metalness,m.emissiveIntensity,m.opacity]);});return JSON.stringify(rows);
}
const auditRender=renderer.render.bind(renderer);
renderer.render=(s,c)=>{
 if(s!==scene) return auditRender(s,c);
 const failures=[];let unmanagedLabels=0;
 s.traverseVisible(o=>{
  if(o.isSprite&&!labelMetadata.has(o)) unmanagedLabels++;
  for(const m of (Array.isArray(o.material)?o.material:o.material?[o.material]:[])) {
   if(m.color?.getHSL({h:0,s:0,l:0},THREE.SRGBColorSpace).s>0.351) failures.push('saturated material');
   if(typeof m.roughness==='number'&&m.roughness<0.849)failures.push('glossy material');
   if(typeof m.metalness==='number'&&m.metalness>0.051)failures.push('metallic material');
  }
 });window.auditStyle={failures,unmanagedLabels,background:s.background?.getHexString?.()};return auditRender(s,c);
};
window.auditFrame=(t)=>{
    const start=performance.now();
    restoreLabels(); module_.update(context,t); controls.update(); layoutLabels(); const authored=authoredMaterials(); renderScene(); const restored=authored===authoredMaterials();
    const cpuMs=performance.now()-start;
    scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    const labels=[];
    scene.traverseVisible(object=>{
     const meta=labelMetadata.get(object); if(!meta || meta.suppressed || !meta.text.trim() || object.material.opacity<0.1 || Math.abs(object.material.rotation)>0.01) return;
     if(Array.from(meta.text.trim()).every(char=>{const n=char.charCodeAt(0);return (n>=0x2190&&n<=0x21ff)||(n>=0x27f0&&n<=0x27ff);})) return;
     const world=object.getWorldPosition(new THREE.Vector3());
     const depth=-world.clone().applyMatrix4(camera.matrixWorldInverse).z;
     const scale=object.getWorldScale(new THREE.Vector3());
     if(depth<=0 || Math.abs(scale.y)<0.01) return;
     const factor=renderer.domElement.clientHeight/(2*Math.tan(camera.fov*Math.PI/360)*depth);
     const tex=object.material.map.image, font=scale.y*factor*48/tex.height;
     world.project(camera);
     const padding=font*0.65;
     labels.push({text:meta.text,x:(world.x+1)*renderer.domElement.clientWidth/2,y:(1-world.y)*renderer.domElement.clientHeight/2,
      w:scale.x*factor-padding,h:scale.y*factor-padding,font,color:meta.opts.color || '#f5f5f5'});
    });
    const overlaps=[];
    for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){
     const a=labels[i],b=labels[j]; if(Math.abs(a.x-b.x)<(a.w+b.w)/2-1 && Math.abs(a.y-b.y)<(a.h+b.h)/2-1) overlaps.push([a.text,b.text]);
    }
    return {cpuMs,restored,style:window.auditStyle,labels:labels.length,overlaps,small:labels.filter(l=>l.font<11.9).length,smallDetails:labels.filter(l=>l.font<11.9),
     clipped:labels.filter(l=>l.x-l.w/2 < -1 || l.x+l.w/2 > renderer.domElement.clientWidth+1 || l.y-l.h/2 < -1 || l.y+l.h/2 > renderer.domElement.clientHeight+1).map(l=>l.text),
     background:scene.background?.getHexString?.(),drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles};
   };
   window.auditRestart=()=>{
    // Compare the same phase and warm-up path; phases reveal different textures.
    restart(); window.auditFrame(8); const before={...renderer.info.memory};
    for(let i=0;i<3;i++) {restart(); window.auditFrame(8);}
    return {before,after:{...renderer.info.memory}};
   };
   let playing = false;`);
   await page.setContent('<iframe sandbox="allow-scripts" style="position:fixed;inset:0;border:0;width:100%;height:100%"></iframe>');
   await page.evaluate(doc=>{window.messages=[];addEventListener('message',e=>window.messages.push(e.data));document.querySelector('iframe').srcdoc=doc;},doc);
   await page.waitForFunction(()=>window.messages.some(m=>m.type==='scene-ready'||m.type==='scene-error'),{},{timeout:15000});
   const frames=[];
   for(const t of Array.from({length:33},(_,i)=>i)) {
    try {frames.push({t,...await page.frames()[1].evaluate(t=>window.auditFrame(t),t)});}
    catch(error) {errors.push(error.message.split('\n')[0]);break;}
    if(t===8) await page.screenshot({path:`${output}/${id}-${width}.png`});
   }
   let navigation,resources;
   try {
    resources=await page.frames()[1].evaluate(()=>window.auditRestart());
    await page.frames()[1].evaluate(()=>scrollTo(10000,10000));
    await page.waitForTimeout(50);
    navigation=await page.frames()[1].evaluate(()=>({x:scrollX,y:scrollY,maxX:document.documentElement.scrollWidth-innerWidth,maxY:document.documentElement.scrollHeight-innerHeight,header:document.querySelector('#scene-header').getBoundingClientRect().top}));
    if(width===390) await page.screenshot({path:`${output}/${id}-${width}-scrolled.png`});
   } catch(error) {errors.push(error.message);}
   const messages=await page.evaluate(()=>window.messages.filter(m=>m.type==='scene-error'));
   results.push({id,node:record.node_id,title:sceneDoc.title,width,codeHash:createHash('sha256').update(sceneDoc.code).digest('hex'),errors:[...new Set([...errors,...messages.map(m=>m.message)])],navigation,resources,frames});
   await page.close();
   console.log(JSON.stringify({title:sceneDoc.title,width,errors:results.at(-1).errors.length,overlaps:Math.max(0,...frames.map(f=>f.overlaps.length)),clipped:Math.max(0,...frames.map(f=>f.clipped.length))}));
  }
 }
} finally {
 await writeFile(output+'/audit.json',JSON.stringify({runtimeHash:createHash('sha256').update(source).digest('hex'),helpersHash:createHash('sha256').update(helpers).digest('hex'),unsupported,results},null,2));
 const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
 await writeFile(output+'/index.html',`<!doctype html><meta charset="utf-8"><style>body{margin:24px;background:#0b0b0b;color:#eee;font:14px system-ui}main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}figure{margin:0;border:1px solid #333;padding:10px}img{width:100%}figcaption{margin-bottom:8px}</style><h1>Saved scene library · ${escape(run)}</h1><main>${results.filter(r=>r.width===900).map(r=>`<figure><figcaption>${escape(r.title)}</figcaption><img src="${r.id}-900.png"></figure>`).join('')}</main>`);
 await browser.close();
}
for(const result of results) {
 assert.deepEqual(result.errors,[],result.title+' errors');
 assert.equal(result.frames.length,33,result.title+' sampled timeline');
 for(const frame of result.frames) {
  assert(frame.restored,result.title+' authored materials changed');
  assert.deepEqual(frame.style.failures,[],result.title+' theme');
  assert.equal(frame.style.background,'000000');
  assert.equal(frame.small,0,result.title+' small labels');
  assert.deepEqual(frame.overlaps,[],result.title+' overlapping labels');
  assert.deepEqual(frame.clipped,[],result.title+' clipped labels');
 }
 assert.equal(result.navigation.x,result.navigation.maxX,result.title+' horizontal scrolling');
 assert.equal(result.navigation.y,result.navigation.maxY,result.title+' vertical scrolling');
 assert.equal(result.navigation.header,0,result.title+' fixed header');
 assert.deepEqual(result.resources.after,result.resources.before,result.title+' restart resources');
}
console.log(`Passed ${results.length} viewport runs across ${results.length/2} saved programs.`);
