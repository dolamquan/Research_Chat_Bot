# Rich notes and LaTeX

The workspace Notes pane now has a document editor: headings, bold, italic,
underline, yellow highlights, links, lists, quotes, undo and redo. Select text
and use the toolbar, or use Ctrl/Cmd+B, I, U. Expand editor opens a larger writing
area. Ctrl/Cmd+S saves to the Notes library. Existing browser draft autosave and
image/sketch attachments continue to work.

Use the sigma button to insert an inline or display equation. The equation dialog
accepts LaTeX and previews it with KaTeX. Fractions, sums, integrals, matrices and
aligned equations are supported. Click an existing formula to edit it. Invalid
expressions keep their source visible and cannot be applied from the dialog.
This supports mathematical LaTeX, not full TeX documents, packages or bibliography
compilation.

Source mode offers editable Markdown/LaTeX with a live preview. The storage
contract remains `body_md`: `==highlight==`, `++underline++`, standard Markdown
formatting, `$inline math$` and `$$` display math. No data migration is required.
Notes library cards render the same grammar, and their Edit button opens the
document editor for saved workspace notes, chat captures and PDF-note comments.

Notion conversion preserves highlights as yellow background annotations,
underline as an annotation, inline math as equation rich text and display math
as equation blocks. Formulas longer than Notion's expression limit are retained
as code instead of truncated. No external pages are written by automated tests.
Live Notion export still depends on the configured integration and network access.

Implementation: `components/notes/NoteEditor.tsx`, `NotePreview.tsx`,
`noteFormat.ts`, and `backend/app/integrations/notion.py`. Tiptap handles editing
and Markdown parsing; preview renders an explicit set of React elements, with
KaTeX trust disabled. Raw note HTML is not injected into the application.

References: [Tiptap mathematics](https://tiptap.dev/docs/editor/extensions/nodes/mathematics)
and [Notion rich text](https://developers.notion.com/reference/rich-text).

Validation includes Markdown round trips, old plain notes, invalid formulas,
safe rendering, temporary SQLite persistence and Notion block conversion.
`frontend/scripts/check-note-editor.mjs` tests the application in Chromium using
mock note APIs, and saves review screenshots under `benchmarks/results/notes-editor`.

## Images and sketches sent to Notion

Save and Notion in the workspace pane include the current drawing as a PNG,
including pictures embedded in the canvas. The editable elements and image files
remain in the saved scene. Add to note keeps a separate snapshot; a matching
snapshot is reused instead of rendering the current canvas twice. Returning to
Sketch restores the current drawing, including its embedded files.

Each local attachment sends a stable `client_id` to `/notes/{id}/attachments`.
SQLite scopes it to the note, so retrying after a reload or interrupted upload
updates one attachment. Identical older uploads are adopted without duplicating
them. The schema adds `client_id` and `content_hash` columns without removing
existing images. Image bytes and sketch edits participate in sync change detection.

Before exporting a library note, the browser checks that its saved sketch has a
matching image and generates one if necessary. The backend checks this again,
uploads every image through Notion's file upload API, and confirms upload status
before creating image blocks. Any image failure stops the export before page
replacement or marking the note synced. This protects existing page contents
from attachment upload failures; Notion page replacement itself is not atomic.

Missing embedded picture files produce an actionable error instead of a blank
export. Single-part uploads above 20 MiB produce an error; Notion may enforce a
smaller limit depending on the workspace. Notion shows a rendered image, while
the editable Excalidraw scene remains in Zoetrope.

`backend/tests/test_note_images.py` covers retries, legacy migration, edited
images, native Notion blocks and failure handling. `WorkspaceNotesPane.test.tsx`
and `sketchExport.test.ts` cover reopened notes, automatic snapshots and older
library notes. `frontend/scripts/check-note-images.mjs` runs the production UI
in Chromium, verifies embedded picture pixels in a real PNG, and exercises
reopening, library repair and failed exports against mock APIs. Artifacts are in
`benchmarks/results/note-images`. No test writes to a live Notion page.

The production build and automated tests are runnable. `pnpm typecheck` currently
has no `tsconfig.json` to load and therefore cannot serve as a full project type
check. Restart the backend to load Python changes, then refresh the frontend.
`restart-backend.ps1` documents the local AVG/TLS issue with agent-launched
backend processes; run that script from your own PowerShell terminal.
