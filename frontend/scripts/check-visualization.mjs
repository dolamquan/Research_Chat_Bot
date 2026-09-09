import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
// Read only. Requests in the preview use this snapshot and cannot generate scenes.
const data=JSON.parse(process.env.VISUALIZATION_DATA
  ? await readFile(process.env.VISUALIZATION_DATA,'utf8')
  : execFileSync('python',['-c',`import sqlite3,json
c=sqlite3.connect('file:../backend/app/data/researchmind.sqlite3?mode=ro',uri=True)
c.row_factory=sqlite3.Row
print(json.dumps({t:[dict(r) for r in c.execute('select * from '+t)] for t in ['articles','paper_visualizations','stage_scenes','node_expansions']}))`],{encoding:'utf8',maxBuffer:16*1024*1024}));
const output='../benchmarks/results/visuals'; await mkdir(output,{recursive:true});
const checks=[];
const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
const page=await browser.newPage({viewport:{width:1714,height:1000}});
await page.addInitScript(() => {
  window.sceneErrors=[];
  window.overviewDrawCalls=0;
  for(const prototype of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]) {
    for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
      const original=prototype[name]; if(!original) continue;
      prototype[name]=function(...args) {window.overviewDrawCalls++; return original.apply(this,args);};
    }
  }
  window.addEventListener('message',event=>{if(event.data?.type==='scene-error') window.sceneErrors.push(event.data.message);});
});
const errors=[]; const generationRequests=[]; page.on('pageerror',e=>errors.push(e.message));
await page.route('**/api/**',async route=>{
 const url=new URL(route.request().url()); const p=decodeURIComponent(url.pathname.replace('/api',''));
 let body={};
 if(p.includes('generate')) generationRequests.push(p);
 if(p==='/visualizer/expand-node') {
   const args=route.request().postDataJSON();
   const row=data.node_expansions.find(r=>r.viz_id===args.viz_id && r.node_id===args.node_id);
   return route.fulfill({json:{expansion:{...row,content:JSON.parse(row.content_json)}}});
 }
 if(route.request().method()!=='GET') return route.fulfill({status:409,json:{detail:'Read-only visual inspection'}});
 if(p==='/openapi.json') body={paths:Object.fromEntries(['/variants/propose','/variants/apply','/variants/item/{target_id}/verify','/variants/item/{target_id}/chat','/visualizer/generate'].map(p=>[p,{}]))};
 else if(p==='/articles') body={articles:data.articles.map(a=>({...a,tags:[],authors:[]}))};
 else if(p==='/articles/domains') body={domains:[]};
 else if(p==='/clusters') body={clusters:[],documents:[]};
 else if(p==='/chat/sessions') body={sessions:[]};
 else if(p.includes('ingestion')) body={jobs:[]};
 else if(p.endsWith('/expansions')) {const rows=data.node_expansions.filter(r=>p.includes(r.viz_id));body={prepared:rows.map(r=>r.node_id),expansions:rows.map(r=>({...r,content:JSON.parse(r.content_json)}))};}
 else if(p.endsWith('/stage-scenes')) body={stage_scenes:data.stage_scenes.filter(r=>p.includes(r.viz_id)).map(r=>({...r,valid:Boolean(r.valid),scene:JSON.parse(r.scene_json)}))};
 else if(p.startsWith('/variants')) body={variants:[],tree:[],history:[]};
 else if(p.endsWith('/discussion')) body={history:[]};
 else if(p.startsWith('/visualizer/')) body={visualizations:data.paper_visualizations.filter(r=>p.endsWith(r.article_id)).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).map(r=>({...r,diagram:JSON.parse(r.diagram_json),worked_example:JSON.parse(r.worked_example_json||'null')}))};
 await route.fulfill({json:body});
});
await page.route('https://cdn.jsdelivr.net/npm/three@0.170.0/**',async route=>{
 const rel=new URL(route.request().url()).pathname.split('three@0.170.0/')[1].replace('three.module.min.js','three.module.js');
 await route.fulfill({body:await readFile('node_modules/three/'+rel),contentType:'text/javascript',headers:{'Access-Control-Allow-Origin':'*'}});
});
await page.goto((process.env.VISUALIZATION_URL || 'http://127.0.0.1:5175')+'/app');
await page.getByRole('button',{name:'Visualizer',exact:true}).click();
for(const [paper,name] of [[/DRAGIN.*research/,'dragin'],[/Attention Is All You Need.*research/,'attention']]) {
 await page.getByRole('button',{name:paper}).click();
 await page.getByText('All stages ready',{exact:true}).waitFor();
 await page.waitForTimeout(3000);
 const canvas=page.locator('canvas').first();await canvas.waitFor({state:'visible'});
 const flatCards=await page.locator('[data-stage-card]').count();
 if(flatCards) throw Error('The flat overview replacement is still mounted');
 if(await page.getByText('3d view unavailable',{exact:true}).count()) throw Error('3D renderer failed');
 await page.screenshot({path:output+'/'+name+'-desktop.png'});
 const bounds=await canvas.boundingBox();
 await page.mouse.move(bounds.x+bounds.width*0.6,bounds.y+bounds.height*0.7);
 await page.mouse.down();await page.mouse.move(bounds.x+bounds.width*0.8,bounds.y+bounds.height*0.6,{steps:12});await page.mouse.up();
 await page.waitForTimeout(400);
 await page.screenshot({path:output+'/'+name+'-orbit.png'});
 await page.getByTitle('Reset camera').click();
 await page.waitForTimeout(500);
 if(name==='dragin') {
  const download=page.waitForEvent('download');await page.getByTitle('Download PNG').click();
  await (await download).saveAs(output+'/dragin-export.png');
 }
 await page.getByRole('button',{name:/^2d$/i}).click();
 await page.waitForTimeout(300);
 await page.screenshot({path:output+'/'+name+'-2d.png'});
 await page.getByRole('button',{name:/^3d$/i}).click();
 await page.getByRole('button',{name:'Walkthrough',exact:true}).click();
 await page.locator('iframe').waitFor({state:'visible'});
 const frame=page.frames().find(f=>f.parentFrame());
 await frame.waitForSelector('#scene-header');
 await frame.waitForFunction(()=>document.querySelector('#caption').textContent.length>0);
 await page.getByTitle('Pause',{exact:true}).click();
 await page.screenshot({path:output+'/'+name+'-theatre.png'});
 const theatre=await frame.evaluate(()=>({title:document.querySelector('#scene-title').textContent,background:getComputedStyle(document.body).backgroundColor}));
 const theatreBounds=await page.locator('iframe').boundingBox();
 if(theatreBounds.width<bounds.width+500) throw Error('Theatre is still squeezed between the paper sidebars');
 theatre.width=theatreBounds.width;theatre.overviewWidth=bounds.width;
 if(theatre.background!=='rgb(0, 0, 0)') throw Error('Shared theatre style was lost');
 await page.getByTitle('Exit playback').click();
 await page.locator('iframe').waitFor({state:'detached'});
 if(!await page.getByRole('button',{name:paper}).isVisible()) throw Error('Paper sidebar did not return after theatre exit');
 checks.push({paper:name,flatCards,theatre,returnedToOverview:true});
}
const result={checks,errors,sceneErrors:await page.evaluate(()=>window.sceneErrors),generationRequests};
await writeFile(output+'/checks.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
if(errors.length||result.sceneErrors.length||generationRequests.length)throw Error('Visualization checks failed');
}finally{await browser.close()}
