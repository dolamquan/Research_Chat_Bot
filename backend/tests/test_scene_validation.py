import pytest
from pathlib import Path

from app.rag.scene_validation import scope_findings
from app.rag.scene_coder import generate_stage_code, check_scene_code, _cached_scene_findings


BROKEN = """
const state = {};
function init(ctx) { const rightX = 6; state.x = rightX; }
function update(ctx, t) { state.x = rightX + t; }
"""
FIXED = """
const state = {};
function init(ctx) { state.rightX = 6; }
function update(ctx, t) { state.x = state.rightX + t; }
"""


def test_screenshot_error_is_rejected_before_playback():
    assert any('`rightX`' in finding for finding in scope_findings(BROKEN))
    assert scope_findings(FIXED) == ()


def test_validation_cache_reuses_results_without_sharing_mutable_lists():
    _cached_scene_findings.cache_clear()
    first = check_scene_code(BROKEN)
    expected = list(first)
    first.clear()
    assert check_scene_code(BROKEN) == expected
    assert _cached_scene_findings.cache_info().hits == 1


@pytest.mark.parametrize('fixture', ['layer_normalization.js', 'query_formulation.js', 'hierarchical_index.js'])
def test_reviewed_examples_use_valid_shared_scope(fixture):
    code = (Path(__file__).parent / 'fixtures' / fixture).read_text(encoding='utf-8')
    assert scope_findings(code) == ()


@pytest.mark.parametrize('code', [
    'const state={}; function init({THREE: T}) { state.x = new T.Vector3(); }',
    'const state={}; function init(ctx) { const {x=1, ...rest} = ctx; state.x = x; state.rest=rest; }',
    'const state={}; function init(ctx) { state.x = [1,2].map((x,i) => x+i); }',
    'function init(ctx) { for (const x of [1,2]) { ctx.setCaption(x); } }',
    'function init(ctx) { for (var i=0; i<2; i++) {} ctx.setCaption(i); }',
    'function init(ctx) { try { throw new Error(); } catch (error) { ctx.setCaption(error.message); } }',
    'const helper = function local(n) { return n ? local(n-1) : 0; };',
    'const state={}; function init(ctx) { const x=1; state.x = {x}; state.f = () => `${x}`; }',
    'class Thing { constructor(x) { this.x=x; } value() { return this.x; } }',
    'const state={}; function init(ctx) { state.x = ctx.values?.[0] ?? Math.PI; }',
    'function init(ctx) { helper(); } function helper() {}',
])
def test_modern_javascript_and_valid_scopes_are_accepted(code):
    assert scope_findings(code) == ()


@pytest.mark.parametrize('code', [
    'function init(ctx) { for (let i=0; i<2; i++) {} ctx.setCaption(i); }',
    'function init(ctx) { if (true) { const x=1; } ctx.setCaption(x); }',
    'function init(ctx) { ctx.setCaption(`${missing}`); }',
    'function init(ctx) { const x={missing}; }',
    'function init(ctx) { const {x=missing}=ctx; }',
    'function init(ctx) { const x = ; }',
])
def test_undefined_names_and_bad_syntax_are_rejected(code):
    assert scope_findings(code)


def test_repair_contains_original_code_and_scope_error(stub_chat_model, sample_visualization):
    client = stub_chat_model(responses=[BROKEN, FIXED])
    scene, _ = generate_stage_code(sample_visualization, {'id': 'norm'}, llm=client)
    assert scene['code'] == FIXED.strip()
    assert BROKEN.strip() in client.prompts[1]
    assert 'undefined identifier `rightX`' in client.prompts[1]
