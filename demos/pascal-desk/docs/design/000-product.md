# Pascal Desk — product and collaboration plan

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

**Status:** approved
**Owner (design/review):** Codex
**Implementer:** DeepSeek Harness via `dsh-codex-bridge/dsh-impl.ps1`
**Base:** local `main`, no commits yet

## Goal

Deliver a small, runnable TypeScript terminal editor inspired by the classic Turbo Pascal
blue screen. Editing is real; compilation, execution, and debugging are entirely out of scope.
This project also demonstrates multiple DSH implementation rounds with independent Codex review.

## User experience

- Blue editor, cyan borders, gray menu/status/help bars, visible cursor and line/column.
- One text buffer, arrow/Home/End/Page navigation, insertion/deletion, two-space tabs,
  undo/redo, literal case-insensitive find, lightweight Pascal syntax coloring.
- File menu and help overlay; friendly errors; dirty marker and discard confirmation.
- Open and save UTF-8 files, including a bundled example; preserve a loaded CRLF or LF convention.
- Shortcuts: F1 help, F2/Ctrl+S save, F3/Ctrl+O open, F10 menu, Ctrl+N new,
  Ctrl+F find, Ctrl+Z undo, Ctrl+Y redo, Ctrl+Q quit, Escape close/cancel.
- CLI: `npm start -- [file.pas]`; `npm run demo` opens the bundled example;
  `node dist/src/cli.js --help` prints usage without requiring a TTY after building.
- Interactive use requires a real terminal, recommended 80x25 or larger. Smaller terminals
  show a bounded resize notice and allow quitting. No mouse support or clipboard integration.
- ASCII is the supported editing/display repertoire for v1. Existing Unicode file content
  must survive open/save; document limited display width/cursor support for non-ASCII.

## Architecture

Node.js 22.14+; TypeScript compiled to ESM in `dist/`. No production dependencies.
Only development dependencies: `typescript` and `@types/node` (22.x).
Use built-in `node:test`, `node:readline` key decoding, `node:fs/promises`, and ANSI terminal output.

Pure editor reducer (`src/editor.ts`) -> pure application controller (`src/app.ts`) ->
pure bounded screen renderer (`src/render.ts`) -> thin interactive adapter (`src/cli.ts`).
File access lives in `src/files.ts`. No terminal side effects in imported core/view modules.
Models and render functions are testable without a TTY; file tests use temporary repository folders.

## Development phases

| Phase | Spec | DSH deliverable | Codex review gate |
|---|---|---|---|
| 1 | `001-editor-core.md` | Project scaffold, pure buffer operations and history | Typecheck, build, core invariant tests, direct code review |
| 2 | `002-terminal-interface.md` | Renderer, controller, keyboard TUI and overlays | Screen/controller tests, terminal lifecycle review, core regression |
| 3 | `003-files-release.md` | File integration, search, sample, user docs and release polish | File/interaction regression, CLI checks and terminal smoke test |

Codex finalizes each later spec against reviewed interfaces. Review defects become additional
DSH rounds in the same session. All production implementation remains DSH-owned.

User reporting requirement: after each development phase, complete any rework and independent
review, then publish a phase report with delivered features, findings/rework, actual validation
results, and an explicit accepted/not accepted decision. Do not report a phase accepted merely
because DSH finished its run. There are four overall phases: design plus three development phases.

User pause requirement: finish the active development phase, including rework and independent
acceptance, report its outcome, then pause. Do not start the next development phase until the user
asks to continue. Requested during phase 2; phase 3 must remain unstarted after phase 2 acceptance.

Continuation on 2026-10-19: the user authorized the documented phase 3 (files/search/safeguards)
with DSH Max effort and sandboxing, including review and rework. Report acceptance and pause
before phase 4. No phase 4 scope is defined or authorized by this plan.

Phase 3 accepted on 2026-10-19 after DSH implementation/rework with Flash/Max and sandboxing,
148 passing tests in both DSH and Codex runs, and Windows terminal verification. The planned
editor is delivered. Development is paused before phase 4; wait for explicit user continuation.
The help command above reflects verified behavior: npm 10.9.2 intercepts `npm start -- --help`
and prints npm's own help, so use the direct built CLI for application usage.

## Non-goals and decisions

No Pascal compiler/interpreter/debugger, language server, multi-file tabs, selections, mouse,
plugins, network services, bundled executable, or exact historical Turbo Pascal compatibility.
No open product questions. Build a usable editor, with honest documentation of v1 limitations.

## Final acceptance

`npm ci`, `npm run check`, `npm run build`, `npm test`, and CLI help/smoke checks must succeed.
The editor must restore terminal state on normal quit, Ctrl+C, and handled fatal errors.
Review evidence and DSH session IDs belong in `docs/reviews.md`. No commit is part of this task.
