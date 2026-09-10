"""The note's Markdown is durable; exports keep math and text formatting."""
from app.integrations.notion import markdown_to_blocks, _rich_text
from app.storage import notes


def test_highlight_and_nested_formatting_export_as_annotations():
    rich = _rich_text("A ==**key** and ++underlined++== finding.")
    key = next(item for item in rich if item.get("text", {}).get("content") == "key")
    assert key["annotations"] == {"bold": True, "color": "yellow_background"}
    underlined = next(item for item in rich if item.get("text", {}).get("content") == "underlined")
    assert underlined["annotations"]["underline"] is True
    assert underlined["annotations"]["color"] == "yellow_background"


def test_inline_and_display_equations_export_as_native_notion_math():
    blocks = markdown_to_blocks("Energy $E=mc^2$.\n\n$$\n\\frac{a}{b}\n$$\n\nAfter equation.")
    assert blocks[0]["paragraph"]["rich_text"][1] == {"type": "equation", "equation": {"expression": "E=mc^2"}}
    assert blocks[1] == {"object": "block", "type": "equation", "equation": {"expression": r"\frac{a}{b}"}}
    assert blocks[2]["paragraph"]["rich_text"][0]["text"]["content"] == "After equation."


def test_same_line_and_matrix_equations():
    blocks = markdown_to_blocks("$$x^2$$\n\n$$\n\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}\n$$")
    assert [b["type"] for b in blocks] == ["equation", "equation"]
    assert "\\\\" in blocks[1]["equation"]["expression"]


def test_code_and_escaped_currency_stay_literal():
    blocks = markdown_to_blocks("```latex\n$x^2$\n==literal==\n```\n\nCost \\$5 and `$x$`.")
    assert blocks[0]["type"] == "code"
    assert blocks[0]["code"]["rich_text"][0]["text"]["content"] == "$x^2$\n==literal=="
    rich = blocks[1]["paragraph"]["rich_text"]
    assert all(item["type"] == "text" for item in rich)
    assert "Cost $5" in "".join(item["text"]["content"] for item in rich)


def test_incomplete_display_equation_preserves_source():
    blocks = markdown_to_blocks("$$\n\\frac{a}{b}")
    assert "$$" in blocks[0]["paragraph"]["rich_text"][0]["text"]["content"]


def test_existing_markdown_still_exports():
    blocks = markdown_to_blocks("# Heading\n\n- **bold**\n- *italic*\n\n> quote\n\n[Link](https://example.com)")
    assert [b["type"] for b in blocks] == ["heading_1", "bulleted_list_item", "bulleted_list_item", "quote", "paragraph"]
    assert blocks[-1]["paragraph"]["rich_text"][0]["text"]["link"]["url"] == "https://example.com"


def test_combined_bold_and_italic():
    rich = _rich_text("==***important***==")
    assert rich[0]["text"]["content"] == "important"
    assert rich[0]["annotations"] == {"bold": True, "italic": True, "color": "yellow_background"}


def test_save_reopen_and_dirty_tracking_preserve_formula_source(monkeypatch, tmp_path):
    monkeypatch.setattr(notes, "DB_PATH", tmp_path / "notes.sqlite3")
    monkeypatch.setattr(notes, "DATA_DIR", tmp_path)
    body = "==Important== $E=mc^2$\n\n$$\n\\sum_i x_i\n$$"
    note = notes.create_note(title="Research", body_md=body)
    assert notes.get_note(note["note_id"])["body_md"] == body
    notes.mark_note_synced(note["note_id"], notion_page_id="page", notion_page_url="https://notion.so/page", notion_database_id="db", content_hash=note["content_hash"])
    updated = notes.update_note(note["note_id"], body_md=body.replace("x_i", "x_i^2"))
    assert updated["notion_dirty"] is True
    assert "x_i^2" in updated["body_md"]
