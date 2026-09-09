"""Parse generated JavaScript without executing it; catch unbound identifiers.

This is a scope/grammar check, not a proof of runtime correctness or a sandbox.
The browser remains the execution boundary. Tree-sitter supports modern JS,
including destructuring, optional chaining and template expressions.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

from tree_sitter import Language, Node, Parser
import tree_sitter_javascript

_LANGUAGE = Language(tree_sitter_javascript.language())
_GLOBALS = set("""
ctx Math Number String Boolean Object Array JSON Date RegExp Map Set WeakMap
WeakSet Symbol BigInt Infinity NaN undefined parseInt parseFloat isNaN isFinite
Error TypeError RangeError ReferenceError SyntaxError URIError EvalError
ArrayBuffer SharedArrayBuffer DataView Float32Array Float64Array Int8Array
Uint8Array Uint8ClampedArray Int16Array Uint16Array Int32Array Uint32Array
BigInt64Array BigUint64Array Promise Reflect Proxy Intl console performance
encodeURI encodeURIComponent decodeURI decodeURIComponent
""".split())
_FUNCTIONS = {
    "function_declaration", "function_expression", "arrow_function",
    "generator_function_declaration", "generator_function", "method_definition",
}
_BLOCKS = {
    "statement_block", "for_statement", "for_in_statement", "switch_body",
    "catch_clause", "class_body",
}


@dataclass
class _Scope:
    parent: _Scope | None = None
    function: bool = False
    names: set[str] = field(default_factory=set)

    def contains(self, name: str) -> bool:
        return name in self.names or bool(self.parent and self.parent.contains(name))


@lru_cache(maxsize=128)
def scope_findings(code: str) -> tuple[str, ...]:
    root = Parser(_LANGUAGE).parse(code.encode("utf-8")).root_node
    if root.has_error:
        pending = [root]
        while pending:
            node = pending.pop()
            if node.type == "ERROR" or node.is_missing:
                return (f"JavaScript syntax error at line {node.start_point.row + 1}",)
            pending.extend(reversed(node.children))
        return ("JavaScript syntax error",)

    global_scope = _Scope(function=True, names=set(_GLOBALS))
    bindings: set[int] = set()
    references: list[tuple[Node, _Scope]] = []

    def name(node: Node) -> str:
        return node.text.decode("utf-8")

    def bind(node: Node | None, scope: _Scope) -> None:
        if node is None:
            return
        if node.type in {"identifier", "shorthand_property_identifier_pattern"}:
            scope.names.add(name(node))
            bindings.add(node.id)
        elif node.type in {"assignment_pattern", "object_assignment_pattern"}:
            bind(node.child_by_field_name("left"), scope)
        elif node.type == "pair_pattern":
            bind(node.child_by_field_name("value"), scope)
        else:
            for child in node.named_children:
                bind(child, scope)

    def walk(node: Node, scope: _Scope) -> None:
        kind = node.type
        if kind in _FUNCTIONS:
            identifier = node.child_by_field_name("name")
            if "declaration" in kind:
                bind(identifier, scope)
            scope = _Scope(scope, function=True)
            if kind != "arrow_function":
                scope.names.add("arguments")
            if kind != "method_definition":
                bind(identifier, scope)
            bind(node.child_by_field_name("parameters"), scope)
            bind(node.child_by_field_name("parameter"), scope)
        elif kind in {"class_declaration", "class"}:
            identifier = node.child_by_field_name("name")
            if kind == "class_declaration":
                bind(identifier, scope)
            scope = _Scope(scope)
            bind(identifier, scope)
        elif kind in _BLOCKS:
            scope = _Scope(scope)
            if kind == "catch_clause":
                bind(node.child_by_field_name("parameter"), scope)
        if kind == "variable_declarator":
            target = scope
            if node.parent.type == "variable_declaration":  # var is function scoped
                while target.parent and not target.function:
                    target = target.parent
            bind(node.child_by_field_name("name"), target)
        if kind == "for_in_statement":
            declaration = node.child_by_field_name("kind")
            if declaration is not None:
                target = scope
                if declaration.type == "var":
                    while target.parent and not target.function:
                        target = target.parent
                bind(node.child_by_field_name("left"), target)
        if kind in {"identifier", "shorthand_property_identifier"} and node.id not in bindings:
            references.append((node, scope))
        for child in node.named_children:
            walk(child, scope)

    walk(root, global_scope)
    findings = []
    for node, scope in references:
        identifier = name(node)
        if not scope.contains(identifier):
            finding = f"undefined identifier `{identifier}` at line {node.start_point.row + 1}; share init/update values through state"
            if finding not in findings:
                findings.append(finding)
    return tuple(findings[:20])
