# 003 — File handling, search, safeguards, and release

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

**Status:** accepted after DSH rework and independent Codex validation — 2026-10-19; paused before phase 4
**Owner (design):** Codex
**Implementer:** DeepSeek Harness
**Branch / base:** local `main`, reviewed phases 1 and 2

## 1. Goal

Deliver the usable Pascal Desk v1 editor: local file open/save, find, safeguards, example, and
clear launch documentation. Complete final validation after any DSH corrective rounds.

## 2. Success criteria

- CLI path/demo loads a real file. Open and Save As prompts accept paths containing spaces.
- Save updates the dirty baseline only after successful disk I/O. Failure retains document and history.
- New/Open/Quit on a dirty document require explicit discard confirmation; Escape cancels safely.
- Save As to another existing file requires explicit overwrite confirmation. Escape preserves that file.
- Case-insensitive literal find wraps, moves the cursor, and reports no match without changing text.
- User docs accurately describe shortcuts and limitations. No compiler, execution, or debugger exists.

## 3. Acceptance checks

```powershell
npm ci --ignore-scripts --cache .dsh-runs/npm-cache
npm run check
npm run build
npm run test:sandbox
node dist/src/cli.js --help
```

Codex runs `npm ci` on the host before delegation and independently runs ordinary `npm test`
with worker isolation. DSH runs check/build/the complete sandbox test suite and CLI help; save
full output and immediate exit codes under `.dsh-runs/phase3-checks/`. Keep normal and sandbox
test lists identical, including every new test and all reviewer tests. Keep existing coverage;
the baseline is 74 tests. No skipped tests or sandbox-mode changes. The repaired bridge's normal
Windows preflight must pass. No permission repairs, profile edits, or bridge changes in this phase.
Codex additionally performs terminal smoke testing and file-preservation checks before acceptance.

## 4. Scope

In: files, app flows and overlays, literal search, CLI path/demo, example, README, integration tests.
Out: compiler/debugger/runtime, selections, clipboard, multiple buffers, autosave, plugins, file watching.

## 5. Design

### Files (`src/files.ts`)

Export `openDocument(filePath:string):Promise<EditorState>` and
`saveDocument(editor:EditorState, filePath:string, overwrite:boolean):Promise<EditorState>`.
Return a fresh loaded/saved state on success; never mutate arguments. Absolute resolved path is stored.
Export a typed user-displayable error or use standard codes to distinguish destination-exists (EEXIST).

Support UTF-8 with LF or CRLF, retaining trailing newline and Unicode content. Preserve a UTF-8 BOM
if present. Reject invalid UTF-8, NUL-containing files, nonregular files, and files over 1 MiB with a
clear message. Check byte length after reading as well as file metadata. Do not silently replace bytes.
Opening a nonexistent path is an error; the user creates a new document using New then Save As.

Specific authorized core change: add `bom:boolean` to EditorState. `createEditor` detects and strips
one leading U+FEFF into this metadata; `serialize` prepends it when bom is true. New documents use
false. The BOM is not an editable glyph or part of cursor positions. Preserve this flag through
edits/history/save; savedContent remains the serialized baseline. Add tests for this change without
weakening existing editor tests. No other core behavior changes are authorized. The existing first-
newline normalization policy remains; document that mixed/lone-CR line endings are normalized.
Reject unpaired UTF-16 surrogates on save rather than encoding silent replacement characters.

Save must avoid destroying an existing file if writing fails. Write an exclusive temporary sibling,
then install it only after the full write completes. `overwrite:true` may replace a regular destination
with rename; `overwrite:false` must use a no-clobber primitive, e.g. hard-link completed temp to the
destination (EEXIST if it appeared concurrently), then unlink temp. Never check existence then overwrite
without protection. Clean up only the unique temp created by this call, including error paths.
Reject a symlink destination for overwrite; explain unsupported path in the UI. Existing normal save
uses overwrite=true; unnamed/Save As uses overwrite=false until user explicitly confirms EEXIST.
Do not create missing parent directories. Saving errors keep the original editor and dirty status.
Limit serialized output to 1 MiB too. This is a small text editor, not a large-file editor.

### Controller and dialogs (`src/app.ts`)

Extend pure controller state and transitions to implement these flows. Export and document typed
effects and completion functions so tests can exercise them with fake I/O. Suggested effects:
`{type:'open';path:string}`, `{type:'save';path:string;overwrite:boolean}`, `{type:'quit'}`.
The terminal adapter alone invokes files.ts. State stores busy/pending intent where needed;
do not accept buffer edits or additional file effects while an operation is pending. The saved snapshot
must correspond exactly to the bytes written. On completion clear busy and show Saved/Opened/error.

F2/Ctrl+S save current path, or prompt Save As if unnamed. F3/Ctrl+O prompts Open after any required
discard confirmation. New creates a clean empty unnamed buffer after any required confirmation.
Quit/Ctrl+C emits quit only when clean or discard is explicitly confirmed. Dirty confirmation says
`Discard unsaved changes? Y / N` (or equivalent). Only Y accepts; N/Escape cancel; Enter must not
silently discard. Cancel returns to editing with original cursor/content/history/path.
File prompt accepts printable input and spaces, Backspace, Enter to submit, Escape to cancel;
blank/whitespace-only path shows a message and remains in the prompt. No shell interpolation.
For v1 prompt editing at the end is acceptable; show the trailing part and a bounded cursor for long paths.
Overwrite dialog defaults to cancel and only Y authorizes replacing another existing file.

Expose pure literal search (`src/search.ts`), e.g.
`findNext(lines:string[], query:string, from:Position): {row:number;col:number;length:number}|null`.
Case-insensitive ASCII matching, within a single line, scanning from `from` inclusively and wrapping
once. Empty query returns null. Escape cancels find prompt. First submitted query searches from current
cursor inclusively; repeated search with same query begins one column after current match and wraps.
Ctrl+F opens prompt prefilled with last query. F4 repeats last query (or opens Find if none).
Match only moves cursor/preferredCol, never content or undo history; show found/wrapped or not-found
status. Highlight the current found match if feasible; if included, invalidate highlight on content edits.
Modal overlays never leak keystrokes into the document.

### Terminal adapter and rendering

Replace all phase placeholders with actual behavior. `npm start -- [file.pas]` launches built CLI
(start script may build first); `npm run demo` opens `examples/hello.pas`. Reject unknown options and
multiple paths; `--help` succeeds without TTY. File startup failures print a concise error and exit
nonzero before enabling raw/alternate screen. Interactive use still requires input/output TTY.
Show prompts and confirmations in blue/gray retro panels with bounded text and no terminal injection.
Keyboard-generated Ctrl+C follows dirty protection; external SIGINT/SIGTERM restores terminal and exits.
All cleanup is idempotent. Save errors remain inside the application with actionable messages.
At terminal sizes below 60x16, freeze ordinary editing while keeping quit/cancel/confirmation functional.

## 6. Implementation plan

| File | Change |
|---|---|
| `src/editor.ts`, `tests/editor.test.ts` | Only the BOM metadata/serialization change described above and its additive tests |
| `src/files.ts` | validated UTF-8 load and failure-safe/no-clobber save |
| `src/search.ts` | pure find/wrap |
| `src/app.ts` | prompts, confirmation, async effect protocol, search |
| `src/render.ts` | new overlays and accurate help/shortcut text |
| `src/cli.ts` | file effects, startup args, lifecycle, small terminal handling |
| `package.json` | final start/demo/test scripts and description |
| `examples/hello.pas` | small original Pascal example for visual editing |
| `README.md` | install/start/demo, shortcut table, behavior, limitations, architecture, collaboration links |
| `tests/files.test.ts` | UTF-8/BOM/CRLF round-trip, invalid/binary/large input, errors, no-clobber/overwrite |
| `tests/search.test.ts` | case-insensitive literal matching, wrap, empty/no match |
| `tests/app.test.ts` | dialog isolation, dirty and overwrite cancellation, errors, busy sequencing |
| `tests/render.test.ts` | new dialog bounds/injection checks |
| `tests/cli.test.ts` | arguments, non-TTY and startup failures, lifecycle |
| `tests/integration.test.ts` | representative controller+real temp files edit/save/reopen/cancel flows |

Phase 2 tests may change expected command results to final effect/dialog behavior, but preserve their
behavioral coverage. Do not edit `tests/reviewer-core.test.ts` or other reviewer-owned tests.
Use repository-local `.dsh-runs/test-*` temporary folders and always clean your own test fixture only.
No added dependencies. Core changes are limited to the BOM metadata/serialization exception above.

## 7. Constraints

No successful save claim until persistence resolves. No silent data loss on New/Open/Quit or overwrite.
No process/global event handlers at import. Existing Unicode survives round-trip; README explains
ASCII-oriented cursor widths and single-line Pascal highlighting. Document 1 MiB file limit and
the requirement to build before directly invoking the dist CLI. Do not claim interactive verification
without actually performing it. README links `docs/design/000-product.md` and `docs/reviews.md`.

## 8. Open questions

No open product questions. The user authorized phase 3 implementation, review and rework.
After acceptance, report the result and pause before any phase 4 work. No commit or push.

## 9. Review notes

Codex records results and any corrective rounds in `docs/reviews.md` and reports phase acceptance to user.
