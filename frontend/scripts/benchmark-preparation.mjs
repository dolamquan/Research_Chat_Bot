import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {transformSync}=createRequire(require.resolve('vite'))('esbuild');
const file='frontend/src/app/components/VisualizerView.tsx';
const sources={original:execFileSync('git',['show',`HEAD:${file}`],{encoding:'utf8'}),revised:await readFile('src/app/components/VisualizerView.tsx','utf8')};
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function run(source,notesMs,sceneMs,notesCached=false){
  const begin=source.indexOf('  async function prepareAllStages()');
  const end=source.indexOf('\n  useEffect(',begin);
  const body=transformSync(source.slice(begin,end),{loader:'ts'}).code;
  const nodes=Array.from({length:9},(_,i)=>({id:String(i)}));
  let active=0,peak=0,first=null,last=null,notes=0,scenes=0;
  const start=performance.now();
  const delay=ms=>new Promise(r=>setTimeout(r,ms));
  const task=async(ms,kind)=>{active++;peak=Math.max(peak,active);await delay(ms);active--;if(kind==='scene'){scenes++;first??=performance.now()-start;last=performance.now()-start;}else notes++;};
  const scope={viz:{viz_id:'viz',diagram:{nodes}},prepareDone:null,activeVariant:null,preparedIds:new Set(notesCached?nodes.map(n=>n.id):[]),stageScenes:{},prepareAbortRef:{current:false},activeDiagramId:'viz',diagramRef:{current:'viz'},setPrepareTotal(){},setPrepareDone(){},setPreparedIds(){},setStoryboards(){},setStageScenes(){},refreshViz(){},
    expandVisualizationNode:async()=>{await task(notesMs,'notes');return {expansion:{content:{process_steps:[]}}};},
    generateStageScene:async()=>{await task(sceneMs,'scene');return {stage_scene:{}};}};
  Object.assign(scope,{preparationLoaded:true,setPrepareError(){},sceneIsPlayable:()=>true});
  const prepare=new Function(...Object.keys(scope),body+';return prepareAllStages;')(...Object.values(scope));
  await prepare();
  return {first_scene_ms:first,all_scenes_ms:last,all_prepared_ms:performance.now()-start,peak_requests:peak,notes_calls:notes,scene_calls:scenes};
}
const result={kind:'controlled-delay benchmark of actual prepareAllStages source; not live provider latency',stages:9,scenarios:{}};
for(const [name,notes,scene,cached] of [['balanced',60,60,false],['scene_heavy',5,120,false],['notes_heavy',120,5,false],['notes_cached',0,120,true]]){
  result.scenarios[name]={};
  for(const [variant,source] of Object.entries(sources)){
    const runs=[];
    for(let i=0;i<5;i++)runs.push(await run(source,notes,scene,cached));
    result.scenarios[name][variant]=Object.fromEntries(Object.keys(runs[0]).map(k=>[k,Math.round(median(runs.map(r=>r[k]))*100)/100]));
  }
}
await mkdir('../benchmarks/results',{recursive:true});
await writeFile('../benchmarks/results/preparation.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
for(const [name,{original,revised}] of Object.entries(result.scenarios)){
  if(revised.all_scenes_ms>original.all_scenes_ms*1.15 || revised.peak_requests>5 || revised.scene_calls!==9 || revised.notes_calls!==original.notes_calls){
    throw new Error(`Preparation regression: ${name}`);
  }
}
