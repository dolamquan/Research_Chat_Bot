// A real browser regression: stretched, overlapping, and dynamically updated labels.
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
import {compileRuntime} from './runtime-builder.mjs';
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const source=await readFile('src/app/components/visualization/sceneRuntime.ts','utf8');
const {buildSceneSrcDoc}=await compileRuntime(source);
const code=`const state={};
function init(ctx) {
  state.a=ctx.makeLabel('Score 0.00',{size:0.4});
  state.b=ctx.makeLabel('Waiting',{size:0.4,color:'#000000',background:'#ffffff'});
  state.b.material.rotation=Math.PI;
  state.c=ctx.makeLabel('Query token',{size:0.4});
  state.hidden=ctx.makeLabel('Hidden',{size:0.4}); state.hidden.scale.setScalar(0);
  ctx.scene.add(state.a,state.b,state.c,state.hidden);
  ctx.scene.background=new ctx.THREE.Color('#ff0000');
  state.mesh=new ctx.THREE.Mesh(new ctx.THREE.BoxGeometry(1,1,1),new ctx.THREE.MeshStandardMaterial({color:'#ff0000',roughness:0,metalness:1}));
  state.mesh.position.set(2,-2,0);ctx.scene.add(state.mesh);
  state.annotation=ctx.makeLabel('An explanatory annotation beside the structure',{size:0.4});
  state.annotation.position.copy(state.mesh.position);ctx.scene.add(state.annotation);
  ctx.camera.position.set(0,0,14); ctx.controls.target.set(0,0,0);
}
function update(ctx,t) {
  if(t>0&&!state.late) {state.late=state.mesh.clone();state.late.material=state.mesh.material.clone();state.late.position.x=-2;ctx.scene.add(state.late);}
  state.a.scale.setScalar(1);
  ctx.setLabelText(state.a,'Score 0.75');
  state.b.userData={text:'Updated query'};
}
function resize(ctx) { /* This fixture deliberately exercises viewport layout. */ }`;
let doc=buildSceneSrcDoc(code);
doc=doc.replace('let playing = true;',`const originalRender=renderer.render.bind(renderer);
renderer.render=(s,c)=>{
 if(s!==scene) return originalRender(s,c);
 const materials=[];s.traverseVisible(o=>{if(o.isMesh)materials.push({roughness:o.material.roughness,metalness:o.material.metalness,saturation:o.material.color.getHSL({},THREE.SRGBColorSpace).s});});
 window.renderedStyle={background:s.background.getHexString(),materials};return originalRender(s,c);
};
window.inspectStyle=()=>{
 const originals=[];scene.traverseVisible(o=>{if(o.isMesh)originals.push({roughness:o.material.roughness,metalness:o.material.metalness,color:o.material.color.getHexString()});});
 const sprite=scene.children.find(o=>o.userData.text==='Updated query');
 const canvas=sprite.material.map.image, g=canvas.getContext('2d');
 const pixels=g.getImageData(0,0,canvas.width,canvas.height).data;
 return {rendered:window.renderedStyle,originals,background:scene.background.getHexString(),surface:[...g.getImageData(12,12,1,1).data],brightInk:pixels.some((v,i)=>i%4===0&&v>=160)};
};
window.inspectStructure=()=>{
 const object=scene.children.find(o=>o.isMesh&&o.position.x===2);
 const b=new THREE.Box3().setFromObject(object),xs=[],ys=[];
 for(const x of [b.min.x,b.max.x])for(const y of [b.min.y,b.max.y])for(const z of [b.min.z,b.max.z]){
  const p=new THREE.Vector3(x,y,z).project(camera);xs.push((p.x+1)*innerWidth/2);ys.push((1-p.y)*innerHeight/2);
 }return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
};
window.inspectLabels=()=>{
  const rows=[];
  scene.traverse(object=>{
    if(!object.isSprite) return;
    const point=object.getWorldPosition(new THREE.Vector3());
    const depth=-point.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const pixels=renderer.domElement.clientHeight/(2*Math.tan(camera.fov*Math.PI/360)*depth);
    const scale=object.getWorldScale(new THREE.Vector3()); point.project(camera);
    const map=object.material.map.image;
    rows.push({text:object.userData.text,x:(point.x+1)*innerWidth/2,y:(1-point.y)*innerHeight/2,
      width:scale.x*pixels-scale.y*pixels*48/map.height*0.65,height:scale.y*pixels-scale.y*pixels*48/map.height*0.65,font:scale.y*pixels*48/map.height,
      rotation:object.material.rotation,aspectError:Math.abs(scale.x/scale.y-map.width/map.height)});
  }); return rows;
}; let playing = true;`);
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage({viewport:{width:390,height:600}});
 await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**',async route=>{
   const rel=new URL(route.request().url()).pathname.split('three@0.170.0/')[1].replace('three.module.min.js','three.module.js');
   await route.fulfill({body:await readFile('node_modules/three/'+rel),contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.setContent('<iframe sandbox="allow-scripts" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
 await page.evaluate(doc=>{window.messages=[];addEventListener('message',e=>window.messages.push(e.data));document.querySelector('iframe').srcdoc=doc;},doc);
 await page.waitForFunction(()=>window.messages.some(m=>m.type==='scene-ready'||m.type==='scene-error'));
 for(const width of [390,830]) {
   await page.setViewportSize({width,height:600}); await page.waitForTimeout(200);
   const all=await page.frames()[1].evaluate(()=>window.inspectLabels());
   const style=await page.frames()[1].evaluate(()=>window.inspectStyle());
   assert.equal(style.rendered.background,'000000');
   assert.equal(style.background,'ff0000');
   assert.equal(style.rendered.materials.length,2,'Late-created meshes use the same treatment');
   for(const m of style.rendered.materials) {assert(m.roughness>=0.85);assert(m.metalness<=0.05);assert(m.saturation<=0.351);}
   for(const m of style.originals) {assert.deepEqual(m,{roughness:0,metalness:1,color:'ff0000'});}
   assert.equal(style.surface[3],0,'Text has no opaque label badge');
   assert(style.brightInk,'Black authored ink becomes readable on the shared dark surface');
   assert.equal(all.find(row=>row.text==='Hidden').height,0);
   const rows=all.filter(row=>row.text!=='Hidden');
   const structure=await page.frames()[1].evaluate(()=>window.inspectStructure());
   const annotation=rows.find(r=>r.text.startsWith('An explanatory'));
   assert(annotation.x+annotation.width/2<=structure.left || annotation.x-annotation.width/2>=structure.right || annotation.y+annotation.height/2<=structure.top || annotation.y-annotation.height/2>=structure.bottom,'Annotation covers its structure');
   assert.equal(rows.length,4);
   assert(rows.some(r=>r.text==='Updated query'));
   assert(rows.some(r=>r.text==='Score 0.75'));
   for(const row of rows) {assert(row.font>=11.99); assert(row.aspectError<0.001); assert.equal(row.rotation,0);}
   for(let i=0;i<rows.length;i++) for(let j=i+1;j<rows.length;j++) {
     const a=rows[i],b=rows[j];
     assert(Math.abs(a.x-b.x)>=(a.width+b.width)/2 || Math.abs(a.y-b.y)>=(a.height+b.height)/2,'Labels overlap');
   }
 }
 assert(!(await page.evaluate(()=>window.messages)).some(m=>m.type==='scene-error'));
 console.log('Passed: fresh scene styling, late-created meshes, source restoration, label contrast/aspect/upright text, 12px minimum, collision separation, dynamic text, and viewport resize.');
} finally {await browser.close();}
