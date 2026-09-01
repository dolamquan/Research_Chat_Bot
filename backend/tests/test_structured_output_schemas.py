"""Every model sent through `_structured_llm_call` must stay strict-mode legal.

`_structured_llm_call` tries `with_structured_output(method="json_schema")`
first -- OpenAI strict mode -- and swallows any failure with a bare `except`,
degrading silently to a plain-JSON prompt with weaker conformance and roughly
double the token cost. A schema that strict mode rejects therefore produces no
error anywhere: quality just quietly drops. This suite is the tripwire.

Strict mode rejects: any field with a default, any union (`Optional[X]` emits
`anyOf`), and any object whose `required` list does not cover every property.
"""

from __future__ import annotations

import re
from typing import Iterator, List, Tuple

import pytest

from app.rag.diagram_mutator import ModificationPatch
from app.rag.paper_visualizer import (
    DiagramIR,
    MechanismDomainGuess,
    NodeExpansionContent,
    WorkedExample,
)
from app.rag.variant_chat import DiscussionReply

STRICT_MODELS = [
    NodeExpansionContent,
    WorkedExample,
    MechanismDomainGuess,
    ModificationPatch,
    DiscussionReply,
]


def strict_mode_violations(node: object, path: str = "$") -> Iterator[str]:
    if isinstance(node, dict):
        if "default" in node:
            yield f"{path}: carries a default"
        for key in ("anyOf", "oneOf"):
            if key in node:
                yield f"{path}: {key} (union / Optional)"
        if node.get("type") == "object" and "properties" in node:
            props = set(node["properties"])
            required = set(node.get("required", []))
            if required != props:
                yield f"{path}: optional fields {sorted(props - required)}"
        for key, value in node.items():
            yield from strict_mode_violations(value, f"{path}.{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from strict_mode_violations(value, f"{path}[{index}]")


@pytest.mark.parametrize("model_cls", STRICT_MODELS, ids=lambda m: m.__name__)
def test_schema_is_strict_mode_legal(model_cls):
    violations = list(strict_mode_violations(model_cls.model_json_schema()))
    assert not violations, (
        f"{model_cls.__name__} would be rejected by strict structured output "
        f"and silently fall back to the plain-JSON path:\n"
        + "\n".join(violations)
    )


def test_diagram_ir_known_violations_do_not_grow():
    """DiagramIR predates this suite and already fails strict mode.

    `IRNode.group` and `IRGroup.repeat` are Optional, so diagram extraction
    has been running on the JSON fallback path all along. Fixing that changes
    extraction behaviour and deserves its own change; until then this pins the
    violation set so new ones cannot hide behind the known ones.
    """
    pattern = re.compile(r"\$defs\.(\w+)\.properties\.(\w+):")
    fields: List[Tuple[str, str]] = sorted(
        match.groups()
        for violation in strict_mode_violations(DiagramIR.model_json_schema())
        if (match := pattern.search(violation))
    )
    assert fields == [("IRGroup", "repeat"), ("IRNode", "group")]
