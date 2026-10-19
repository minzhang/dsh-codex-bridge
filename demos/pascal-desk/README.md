# Pascal Desk

The first verification demo for [DSH Codex Bridge](../../README.md). Its design, implementation,
testing and review exercised the bridge across multiple development rounds.

Pascal Desk is a small Turbo Pascal inspired terminal editor. It opens, edits,
and saves ordinary UTF-8 text with a blue retro frame, a visible cursor,
line/column status, lightweight Pascal coloring, undo/redo, and literal find.

It is an editor only. There is no compiler, interpreter, runtime, debugger, or
language server.

## Requirements

- Node.js 22.14 or newer
- A terminal with ANSI support; interactive use has been verified on Windows only. macOS and Linux remain unverified.
- Recommended terminal size: 80x25. Editing freezes below 60x16; quitting and
  dialog cancellation keep working.

## Install and run

Run these commands from "demos/pascal-desk" (or use npm --prefix from the repository root):

```powershell
npm ci --ignore-scripts
npm run build
npm start -- [file.pas]
```

`npm start -- file.pas` opens one existing file. With no file it starts an empty
unnamed buffer. Quote a path that contains spaces, for example
`npm start -- "notes/my file.pas"`. The `start` lifecycle builds first, so it
also works without a separate `npm run build`; direct `node dist/src/cli.js`
use requires a prior build.

Open the bundled example:

```powershell
npm run demo
```

Show usage without a terminal:

```powershell
node dist/src/cli.js --help
```

Unknown options and more than one file path are rejected. A startup file that
cannot be loaded prints a concise error and exits nonzero before the alternate
screen is entered. Interactive use requires both stdin and stdout to be TTYs.

## Keyboard

| Key | Action |
|---|---|
| F1 | Toggle Help |
| F2 / Ctrl+S | Save the current path, or prompt for Save As if unnamed |
| F3 / Ctrl+O | Prompt for Open (discard confirmation first when dirty) |
| F4 | Find the next occurrence of the previous query, or open Find |
| F10 | Menu |
| Ctrl+N | New unnamed clean buffer (discard confirmation when dirty) |
| Ctrl+F | Find prompt, prefilled with the previous query |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+Q / Ctrl+C | Quit (discard confirmation when dirty) |
| Escape | Close overlays and cancel prompts or confirmations |
| Arrows, Home, End, PageUp, PageDown | Move the cursor |
| Enter, Backspace, Delete, Tab | Edit text; Tab inserts two spaces |

The menu contains New, Open, Save, Save As, Find, Undo, Redo, Help, and Quit.
Menu actions use the same safeguards as the shortcuts.

## Files and safeguards

- Files are read and written as UTF-8. LF and CRLF are both supported; the first
  newline convention in a loaded file is retained when saving. Lone CR and mixed
  line endings are normalized to that convention, as documented below.
- A trailing newline and Unicode content are preserved. A leading UTF-8 BOM is
  preserved as file metadata: it is not an editable glyph, does not occupy a
  cursor position, and is re-emitted on save.
- Invalid UTF-8, NUL bytes, nonregular files, symlinks, and files larger than
  1 MiB are rejected with a message. Serialized output is also limited to 1 MiB.
- Open only opens existing files. To create a file, use New and then Save As.
- Save writes to an exclusive temporary file beside the destination and installs
  it only after the whole write succeeds. A failed save leaves the original file
  and the editor's content, cursor, history, and dirty state intact.
- Save As never clobbers an existing file silently. It first reports that the
  destination exists, then asks for explicit overwrite confirmation. Only `Y`
  authorizes replacement; `N` and Escape cancel and preserve the file, and
  Enter never overwrites.
- New, Open, and Quit ask `Discard unsaved changes? Y / N` when the buffer is
  dirty. Only `Y` discards. Cancel restores editing with the original content,
  cursor, history, and path.
- Save errors stay inside the editor with a status message; the application
  does not crash or exit.
- Save As does not create missing parent directories.
- File prompts accept printable paths containing spaces, edit at the end,
  support Backspace and Enter, and cancel with Escape. Blank paths stay in the
  prompt with a message. Paths are never passed through a shell.
- Overwrite destinations that are symlinks are rejected; this v1 editor does not
  follow or replace symlinks.

## Find

Find is literal and case-insensitive for ASCII letters only. Matching stays
within one line, starts at the current cursor inclusively, and wraps once around
the document. Ctrl+F reopens the prompt with the previous query. F4 searches
again from one column after the current match, wrapping if needed. A match moves
only the cursor and preferred column; it never changes text or undo history.
The current match is highlighted until the next content edit. Empty queries are
not submitted, and a query with no match reports it without changing the
document.

## Limitations

- This is a small text editor, not a large-file editor. Files over 1 MiB are
  rejected.
- Editing and display are ASCII-oriented. Non-ASCII content is preserved, but
  cursor columns and wide-character display widths are not guaranteed to match
  every terminal's cell widths.
- Pascal syntax coloring is a lightweight single-line lexer. It does not parse
  the language, and `{...}` or `(*...*)` comments spanning lines are colored one
  line at a time.
- Mixed or lone-CR line endings are normalized to the first convention detected
  in the loaded file. Reopening a file written by Pascal Desk is stable, but the
  original mixed bytes are not retained.
- No compiler, execution, debugger, language server, selections, clipboard,
  multiple buffers, tabs, autosave, file watching, plugins, mouse support, or
  network services.
- Prompt editing is at the end of the value. Long paths show a bounded trailing
  window.
- There are no embedded terminal libraries or runtime dependencies.

## Architecture

```
src/editor.ts  pure immutable buffer, cursor, history, BOM/EOL metadata
src/app.ts     pure controller: keys, prompts, confirmations, effects, search
src/search.ts  pure literal find with one wrap
src/files.ts   validated UTF-8 load and failure-safe no-clobber save
src/render.ts  bounded ANSI frame renderer and modal overlays
src/syntax.ts  single-line Pascal coloring
src/cli.ts     thin terminal adapter and process lifecycle
```

The editor, controller, search, and renderer are terminal-independent and are
tested directly. The CLI adapter alone touches the filesystem and terminal.
File startup happens before raw mode and the alternate screen are enabled.

## Tests

Install and run the normal suite:

```powershell
npm ci --ignore-scripts
npm test
```

The normal script builds TypeScript and runs every test file, including the
reviewer-owned tests. Restricted Windows sandboxes, including DSH's
workspace-write sandbox, can block Node's test-worker subprocess pipes. In that
environment run the exact same test list in the main process:

```powershell
npm run test:sandbox
```

The sandbox command disables only the test runner's worker isolation. CLI tests
still spawn real confined processes and capture their output through files.
Neither command skips tests or changes the editor.

## Collaboration record

- Product plan and phase scope: [docs/design/000-product.md](docs/design/000-product.md)
- Codex/DSH review log and acceptance decisions: [docs/reviews.md](docs/reviews.md)

## License

[MIT](../../LICENSE), as part of DSH Codex Bridge.
