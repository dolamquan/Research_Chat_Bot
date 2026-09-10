import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { noteExtensions, parseNote } from "./noteFormat";
import { NotePreview } from "./NotePreview";
import { NoteEditor } from "./NoteEditor";

afterEach(cleanup);
const sample = "# Research notes\n\nA ==**key finding**== and ++underlined++ text with $E=mc^2$.\n\n$$\n\\begin{bmatrix}1 & 2 \\\\ 3 & 4\\end{bmatrix}\n$$\n\n- First\n- Second";

describe("rich research notes", () => {
  it("round-trips formatted notes and LaTeX through the stored Markdown format", () => {
    const editor = new Editor({extensions: [...noteExtensions(), Markdown], content: sample, contentType: "markdown"});
    const saved = editor.getMarkdown();
    const original = editor.getJSON();
    editor.destroy();
    const reopened = new Editor({extensions: [...noteExtensions(), Markdown], content: saved, contentType: "markdown"});
    expect(reopened.getJSON()).toEqual(original);
    expect(saved).toContain("E=mc^2");
    expect(saved).toContain("bmatrix");
    reopened.destroy();
  });
  it("renders nested highlights, underlines, lists and both formula types", () => {
    const {container} = render(<NotePreview value={sample} />);
    expect(container.querySelector("mark strong, strong mark")).toHaveTextContent("key finding");
    expect(container.querySelector("u")).toHaveTextContent("underlined");
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });
  it("does not execute pasted HTML or unsafe equation links", () => {
    const {container} = render(<NotePreview value={'<img src=x onerror="alert(1)">\n\n$\\href{javascript:alert(1)}{x}$'} />);
    expect(container.querySelector("[onerror],script,a[href^='javascript:']")).toBeNull();
  });
  it("keeps ordinary old notes and escaped dollar signs readable", () => {
    const {container} = render(<NotePreview value={"An old note.\n\nCost: \\$5. `==literal==`"} />);
    expect(container).toHaveTextContent("An old note.");
    expect(container).toHaveTextContent("Cost: $5.");
    expect(container.querySelector("mark")).toBeNull();
    expect(parseNote("plain text").content?.[0].content?.[0].text).toBe("plain text");
  });
  it("switches between editable source and the formatted document without losing formulas", () => {
    function Harness() { const [value, setValue] = useState("Old note"); return <NoteEditor value={value} onChange={setValue} />; }
    render(<Harness />);
    fireEvent.click(screen.getByTitle("Edit Markdown and LaTeX source"));
    fireEvent.change(screen.getByLabelText("Markdown and LaTeX source"), {target: {value: sample}});
    expect(screen.getByLabelText("Formula: E=mc^2")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Edit Markdown and LaTeX source"));
    expect(screen.getByRole("textbox", {name: "Note document"}).querySelector("mark")).toHaveTextContent("key finding");
    expect(screen.getByRole("textbox", {name: "Note document"}).querySelectorAll(".katex")).toHaveLength(2);
  });
  it("provides a formula preview and prevents applying invalid LaTeX", () => {
    render(<NoteEditor value="" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", {name: "Insert formula"}));
    fireEvent.change(screen.getByLabelText("LaTeX source"), {target: {value: "\\frac{"}});
    expect(screen.getByRole("button", {name: "Apply formula"})).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", {name: "Fraction"}));
    expect(screen.getByRole("button", {name: "Apply formula"})).toBeEnabled();
    expect(screen.getByLabelText("Formula preview").querySelector(".katex")).not.toBeNull();
  });
});
