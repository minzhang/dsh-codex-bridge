# 001 — Editor core and TypeScript foundation

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

**Status:** approved
**Owner (design):** Codex
**Implementer:** DeepSeek Harness
**Branch / base:** `main`, unborn repository

## 1. Goal

Build a deterministic, terminal-independent editor model and runnable TypeScript test scaffold.
This is phase 1 only. Later phases add terminal presentation and file integration.

## 2. Success criteria

- Immutable state transitions maintain a nonempty array of newline-free lines and bounded cursor.
- Insertion, multiline paste, split/join, delete/backspace, navigation, undo/redo work at boundaries.
- Dirty status compares content against saved content, including after undo back to a save point.
- CRLF and LF input normalize to lines while retaining the detected convention for serialization.
- Tests exercise behavior and important edge cases, not merely implementation helpers.

## 3. Acceptance checks

```powershell
npm run check
npm run build
npm test
```

`check` = `tsc --noEmit`; `build` = `tsc`; `test` builds then runs compiled node:test tests.
All commands must exit nonzero on failure. Install named dev dependencies if required.

## 4. Scope

In: package/config, core state/actions, core tests. Out: UI, file I/O, search UI, CLI, dependencies beyond listed.

## 5. Design

### Public interfaces (`src/editor.ts`)

Export `Position { row: number; col: number }`, `EditorState`, `EditorAction`, and:

```ts
createEditor(text?: string, filePath?: string): EditorState
reduceEditor(state: EditorState, action: EditorAction): EditorState
serialize(state: EditorState): string
isDirty(state: EditorState): boolean
markSaved(state: EditorState, filePath?: string): EditorState
```

`EditorState` exposes `lines: string[]`, `cursor: Position`, `preferredCol: number`,
`filePath: string | null`, `eol: '\n' | '\r\n'`. Add typed history/saved-content fields as needed.
History keeps up to 200 content-edit snapshots including cursor; navigation is not recorded.
No mutation of previous states, nested arrays, cursor objects, or snapshots.

`EditorAction` discriminated unions:
- `{type:'insert'; text:string}` (normalize CRLF/lone CR to LF; expand each tab into two spaces)
- `{type:'backspace'}` / `{type:'delete'}` / `{type:'newline'}`
- `{type:'move'; direction:'left'|'right'|'up'|'down'|'home'|'end'|'pageUp'|'pageDown'; pageSize?:number}`
- `{type:'undo'}` / `{type:'redo'}`

### Data and flow

New buffer = `['']`, cursor 0,0, LF, unnamed, clean. Create from text preserves trailing newline
as an empty final line. First newline convention wins, default LF. Lone CR normalizes to LF.
Serialization joins lines using `eol`; unedited loaded content survives the supported normalizations.
Opening a new document resets history and baseline. `markSaved` updates the baseline/path without
discarding undo history. Undo/redo never restores stale file paths or saved baselines.

Left/right wrap across lines. Vertical/page movement preserves preferred column through shorter
lines; horizontal movement and edits reset it. Page size defaults to 20, clamped to at least 1.
Home/End go to line bounds. Delete at EOF/backspace at BOF are true no-ops. Insert empty text and
ineffective edits must not add history or clear redo. A real new edit after undo clears redo.

ASCII is the v1 edit target; do not strip Unicode code units or silently change unedited file text.
Do not add terminal escapes, filesystem operations, or global input listeners here.

## 6. Implementation plan

| File | Change |
|---|---|
| `package.json` | private ESM package named `pascal-desk`, Node >=22.14, check/build/test scripts |
| `package-lock.json` | lock named dev dependencies |
| `tsconfig.json` | strict TS, NodeNext, ES2022+, root '.', outDir dist; include src and tests |
| `src/editor.ts` | exported model/reducer |
| `tests/editor.test.ts` | meaningful invariants, actions, history, dirty/eol tests |

## 7. Constraints

Allowed dev dependencies: `typescript` (^5.7 or newer 5.x) and `@types/node` (^22).
No runtime dependencies. Work only in named files. Do not change supplied bridge or design docs.
Keep tests portable to Windows; use Node APIs instead of shell-specific glob assumptions.

## 8. Open questions

None.

## 9. Review notes

Codex records each review in `docs/reviews.md`.
