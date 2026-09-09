"""Reproducible scene checks and optional live paired generation benchmark.

Run from backend: python benchmarks/visualization_benchmark.py [--live]
Outputs stay in benchmarks/results; never modifies saved visualizations.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import statistics
import subprocess
import sys
import time
import types
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
os.environ['LANGSMITH_TRACING'] = 'false'
os.environ['LANGCHAIN_TRACING_V2'] = 'false'
from dotenv import load_dotenv
load_dotenv(ROOT / 'backend/.env')
os.environ.pop('LANGSMITH_API_KEY', None)
os.environ.pop('LANGCHAIN_API_KEY', None)
from app.rag import scene_coder as current
from app.rag.scene_validation import scope_findings
from app.rag.scene_requests import share_scene_request

OUT = ROOT / 'benchmarks/results'
OUT.mkdir(parents=True, exist_ok=True)
baseline = types.ModuleType('baseline_scene_coder')
exec(subprocess.check_output(['git','show','HEAD:backend/app/rag/scene_coder.py'], cwd=ROOT).decode('utf-8'), baseline.__dict__)


def summary(values):
    return {'median_ms': round(statistics.median(values), 6), 'min_ms': round(min(values), 6), 'max_ms': round(max(values), 6), 'samples': len(values)}


def offline():
    conn = sqlite3.connect(f'file:{ROOT / "backend/app/data/researchmind.sqlite3"}?mode=ro', uri=True)
    codes = [json.loads(row[0])['code'] for row in conn.execute('select scene_json from stage_scenes')]
    backup = json.loads((ROOT / 'backend/app/data/scene-repair-backups/layer_norm-2026-09-07.json').read_text(encoding='utf-8'))
    broken = json.loads(backup['scene_json'])['code']
    checks = {}
    for label, checker, cold in [('original',baseline.check_scene_code,False),('revised_cold',current.check_scene_code,True),('revised_warm',current.check_scene_code,False)]:
        times = []
        if label == 'revised_warm':
            for code in codes:
                checker(code)
        for _ in range(20):
            for code in codes:
                if cold:
                    scope_findings.cache_clear()
                    current._cached_scene_findings.cache_clear()
                start=time.perf_counter()
                checker(code)
                times.append((time.perf_counter()-start)*1000)
        checks[label]=summary(times)
    duplicates={}
    for label in ['original','revised']:
        samples=[]
        counts=[]
        for _ in range(5):
            calls=[]
            barrier=Barrier(5)
            def build(viz_id, node_id):
                calls.append(1)
                time.sleep(.08)
                return node_id
            target=share_scene_request(build) if label=='revised' else build
            def request():
                barrier.wait()
                return target('paper','norm')
            start=time.perf_counter()
            with ThreadPoolExecutor(max_workers=5) as pool:
                list(pool.map(lambda _: request(),range(5)))
            samples.append((time.perf_counter()-start)*1000)
            counts.append(len(calls))
        duplicates[label]={'wall':summary(samples),'expensive_calls_per_burst':counts}
    result={'validator':checks,'duplicates':duplicates,'broken_scene':{'original_findings':baseline.check_scene_code(broken),'revised_findings':current.check_scene_code(broken)},'stored_scenes':len(codes),'baseline_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()}
    (OUT/'backend.json').write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps(result),flush=True)


def live(preview=False):
    conn=sqlite3.connect(f'file:{ROOT / "backend/app/data/researchmind.sqlite3"}?mode=ro',uri=True)
    conn.row_factory=sqlite3.Row
    viz=dict(conn.execute('select * from paper_visualizations where viz_id=?',('57c115dfabb548dcafb3dac35facf56a',)).fetchone())
    viz['diagram']=json.loads(viz['diagram_json'])
    node=next(n for n in viz['diagram']['nodes'] if n['id']=='layer_norm')
    model=current._resolve_stage_model(None)
    if preview:
        payload={'destination':'OpenAI API via configured ChatOpenAI client','model':model,'pairs':3,'generation_runs':6,'maximum_model_calls_including_repairs':12,'context':'saved Layer Normalization node, diagram title and immediate connection labels; no PDF chunks or expansion text',
                 'original_prompt':baseline._build_stage_prompt(viz,node,None,None),
                 'revised_prompt':current._build_stage_prompt(viz,node,None,None)}
        (OUT/'live-request-preview.json').write_text(json.dumps(payload,indent=2),encoding='utf-8')
        print(json.dumps({k:v for k,v in payload.items() if not k.endswith('_prompt')}))
        return
    results=[]
    # Alternating order limits systematic cache/order bias. Three pairs are a
    # small diagnostic sample, not a population latency estimate.
    for pair in range(3):
        for label in (['original','revised'] if pair%2==0 else ['revised','original']):
            module=baseline if label=='original' else current
            client=module.build_chat_model(provider='openai',model=model,temperature=0,timeout=150,max_retries=0,**module._scene_model_kwargs(model))
            calls=[]
            class TimedClient:
                model_name=model
                def invoke(self,prompt):
                    start=time.perf_counter()
                    response=client.invoke(prompt)
                    calls.append({'seconds':time.perf_counter()-start,'usage':response.usage_metadata,'prompt_chars':len(prompt)})
                    return response
            start=time.perf_counter()
            item={'pair':pair,'variant':label,'model':model}
            print(json.dumps({'starting':item}),flush=True)
            try:
                scene,_=module.generate_stage_code(visualization=viz,node=node,llm=TimedClient(),provider='openai',model=model)
                filename=f'live-{pair}-{label}.js'
                (OUT/filename).write_text(scene['code'],encoding='utf-8')
                item.update({'code_file':filename,'code_chars':len(scene['code']),'scope_findings':current.check_scene_code(scene['code']),'success':True})
            except Exception as error:
                # Error classes suffice; avoid printing provider payloads or credentials.
                item.update({'success':False,'error_type':type(error).__name__})
            item.update({'seconds':time.perf_counter()-start,'calls':calls})
            results.append(item)
            (OUT/'live.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
            print(json.dumps(item),flush=True)
            if not item['success'] and not calls:
                return


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--live',action='store_true')
    parser.add_argument('--preview-live',action='store_true')
    args=parser.parse_args()
    if args.preview_live:
        live(preview=True)
    elif args.live:
        live()
    else:
        offline()
