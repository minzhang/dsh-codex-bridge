# Codex / DSH development review log

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

Codex designs and reviews; DSH implements. No changes are committed without a user request.
Raw bridge artifacts remain under ignored `.dsh-runs/`; this log records durable conclusions.

## Preparation — 2026-10-19

- Reviewed the supplied bridge and protocol; launcher reports DSH `0.2.1-rc.2`.
- Workspace starts as an empty local `main` with the user's untracked bridge folder.
- Approved product scope and phase 1 spec. Later specs will use reviewed phase interfaces.
- Runtime available: Node `22.14.0`, npm `10.9.2`, PowerShell 7.
- Implementation and validation are pending; no product completion is claimed.

## Phase 1 — editor core accepted, 2026-10-19

- DSH session: `<local-session>`.
- Bridge report: `.dsh-runs/20261019-110518-report.md`; DSH reported PARTIAL honestly because
  its shell cannot provision the Windows workspace sandbox (Win32 5). File tools worked.
- DSH authored `src/editor.ts`, `tests/editor.test.ts`, `package.json`, and `tsconfig.json`.
- Codex installed the declared development dependencies and generated the lockfile with
  `npm install --ignore-scripts --cache .dsh-runs/npm-cache`.
- Codex read the complete implementation and tests; history snapshots correctly exclude saved path/baseline.
- `npm run check` passed; `npm test` built successfully and passed all 34 DSH tests.
- Independent `node --test dist/tests/reviewer-core.test.js` passed 2 tests, including 1,200 randomized
  edits/navigation steps with a flat-string oracle and frozen previous states.
- The Node test runner required an approved unsandboxed launch due to subprocess `spawn EPERM`.
  No filesystem permissions were changed. DSH remains in workspace-write mode.
- Decision: accepted. Phase 2 must include every compiled test, including the reviewer tests,
  in `npm test`; phase 1's initial script names only its own test file.

## Requested runtime and reporting preferences — 2026-10-19

- User requested Max effort for DSH Flash. Verified the installed DSH agent-default-model
  schema supports `reasoningEffort`; its DeepSeek adapter supports `max`.
- Updated the user's headless `cordis.patch.yml` to `deepseek-official` / `deepseek-flash` /
  `reasoningEffort: max`, with approved access and a backup in `.dsh-runs/`.
- Installed model catalog labels `deepseek-flash` as DeepSeek-V4.1-Flash. The phase 2 run was
  already underway; subsequent bridge runs will read Max at startup. No in-flight change claimed.
- User wants an explicit report after each phase's rework, independent review, and acceptance.
  Phase 1 report was delivered; next report is due when phase 2 passes review.
- User subsequently requested pausing at each completed phase. Finish/rework/review phase 2,
  report acceptance, then stop before phase 3 delegation. Phase 3 is only a draft design so far.

## Phase 2 — initial review and rework

- Current DSH round: `.dsh-runs/20261019-110950-*`, same implementation session as phase 1.
- Codex's independent rendering test exposed an invisible cursor after scrolling through a long
  tab-containing line. Independent lifecycle tests exposed unhandled terminal input/output errors.
- DSH read those new tests during its implementation round and revised rendering and cleanup.
- Codex recheck: typecheck and build passed; `npm test` now executes 73 tests, 72 pass.
  All new reviewer tests pass. One DSH test remains wrong: in `tests/render.test.ts`, after moving to
  the end of `hello` and inserting `!`, zero-based cursor col is 6, so one-based status is
  `Ln 1, Col 7`, not `Ln 1, Col 6`. Fix that exact expectation, retaining the status assertion.
- Latest full check output: `.dsh-runs/phase2-recheck.log`.
- Real terminal smoke check displayed the blue editor, accepted a four-line Pascal sample,
  colored keywords/string literals, opened F1 help, dismissed it with Escape, and restored the
  alternate screen on Ctrl+Q. Final exit-code verification remains pending.
- Phase 2 is not yet accepted. Phase 3 remains unstarted.

## Phase 2 — accepted and paused, 2026-10-19

**Decision: ACCEPTED. Development paused before phase 3 at the user's request.**

### Delivery

- Blue terminal editor with cyan frame, filename/dirty indicator, line/column status, Pascal coloring,
  keyboard navigation/editing, undo/redo, scroll handling, F1 Help and F10 menu.
- Pure controller/renderer/lexer and import-safe Node terminal adapter; bounded small-terminal notice,
  text/control-character sanitization, raw-mode/alternate-screen lifecycle and stream-error cleanup.
- No runtime dependencies were added; phase 1 editor implementation and tests remain unchanged.

### DSH submission and rework

- Session: `<local-session>`.
- Final bridge report: `.dsh-runs/20261019-110950-report.md` (16m23s, 93 tool calls).
- DSH reported PARTIAL because its shell could not run checks; Codex supplied independent execution.
- Reviewer-authored tests exposed tab scrolling and unhandled input/output stream errors.
  DSH consumed those tests during the same implementation run and fixed both.
- Codex's execution exposed an incorrect one-based column expectation. DSH corrected it to Col 7.
- DSH extended `npm test` to include all seven existing test files, including six Codex reviewer tests,
  and added a tab-aware viewport regression. No reviewer-owned tests were weakened or edited by DSH.
- This rework occurred inside the original phase 2 run, which had started before the Max request.
  Max is saved in the headless profile for the next DSH run; no Max execution is claimed yet.

### Independent final validation

- `npm run check`: PASS.
- `npm test`: PASS; script runs the TypeScript build, then all 74 tests (68 DSH, 6 Codex), zero failures.
- `node dist/src/cli.js --help`: PASS, exit 0 without a TTY.
- Real Windows terminal: typed Pascal text, observed syntax coloring, exercised undo/redo,
  F1 Help, Escape, F10 menu navigation, and Ctrl+Q. Alternate screen/cursor restored; process exit 0
  recorded in `.dsh-runs/phase2-smoke-exit.txt`.
- Final automated output: `.dsh-runs/phase2-acceptance.log`.
- Compared core source and original core tests against the phase 1 snapshot: unchanged.

### Current limitations and continuation

- This is the accepted phase 2 prototype, not the final product. Open/Save/Save As/New/Find remain
  phase 3 placeholders. Quit currently exits immediately; editing is not persisted.
- Start from the repository with `npm run build` then `npm start` in a real terminal (60x16 minimum).
- Phase 3 remains a draft design, with no delegated run or implementation started. It will add files,
  find, dirty/overwrite safeguards, example/demo, README, integration tests, and final release checks.
- No commits, pushes, or branch changes were made. Wait for the user to request continuation.

## Sandbox repair follow-up — 2026-10-19

- User requested verification of the side-conversation repair report before phase 3.
- Ran an actual bridge delegation in workspace-write mode, session
  `<local-session>`; report `.dsh-runs/20261019-113432-report.md`.
- Confirmed partial repair: DSH's shell starts, root writes work, and `npm run check` passes.
- Nested writes in source/tests/build folders fail; build and `npm test` cannot write `dist/`.
  DSH reports default Node workers and five CLI child-process tests remain blocked by `spawn EPERM`.
- Source/test/package/config hashes are unchanged; no probe files remain. No further repair attempted.
- Updated `docs/dsh-sandbox-repair.md` with verification evidence. Phase 3 stays paused.

## Sandbox workflow repair — accepted, 2026-10-19

**Decision: ACCEPTED. Phase 3 remains paused.**

- Codex repaired stale descendant permissions and missing low-integrity labels within six named
  project subtrees, retaining original descriptors and removing temporary provisioning rights.
  Verified all 186 original owners and deny entries were preserved. DSH's sandbox stayed enabled.
- DSH used the saved Flash/Max profile, session `<local-session>`.
  It changed the CLI test helper to real subprocesses with file-backed output, added
  `npm run test:sandbox`, and documented the commands. No assertions or product code changed.
- Reviewed the helper, exact seven-file test lists, timeout/cleanup behavior, and unchanged source,
  reviewer tests, dependency lockfile, and TypeScript configuration. Accepted without further rework.
- DSH's final actual bridge run passed typecheck, build, and all 74 tests with no skips. Nine write
  locations passed; outside writes were denied from both PowerShell and a real Node child.
- Codex independently verified the DSH runner build/suite (74/74) and ordinary `npm test`
  with Node worker isolation (74/74). Full logs are saved, avoiding bridge-preview truncation.
- This fixes the project workflow. The upstream named-pipe restriction remains: DSH uses
  `test:sandbox`; ordinary `npm test` still requires a host permitting Node worker pipes.
- Reports: `.dsh-runs/20261019-114346-report.md`, `.dsh-runs/20261019-115011-report.md`.
  Detailed repair, validation, and recovery: `docs/dsh-sandbox-repair.md`.
- No phase 3 implementation, commit, push, or branch change occurred.

## Phase 3 — implementation and independent review, 2026-10-19

- User authorized phase 3 with DSH Flash/Max and sandbox enabled, followed by a pause before phase 4.
- Product scope was approved before delegation in `docs/design/003-files-release.md` and is fixed.
  Tests and corrective review check that scope; they do not add features or phases.
- DSH session: `<local-session>`; initial bridge artifacts:
  `.dsh-runs/20261019-125136-*`. Normal Windows readiness preflight passed. No permission repair,
  sandbox bypass, profile change, or bridge modification is authorized in this phase.
- Codex installed the locked dependencies with `npm ci --ignore-scripts --cache .dsh-runs/npm-cache`.
  Baseline source/tests/configuration and bridge hashes are retained under `.dsh-runs/phase3-baseline/`.
- Independent reviewer tests exposed three implementation defects: a temporary-file close error could
  be ignored before replacing the destination; dirty quit confirmation was invisible below 60x16;
  and resubmitting the same Find query returned the same match instead of advancing.
  DSH consumed these tests during its initial run and corrected all three. Independent regression
  execution confirms these corrections in the reviewed snapshot.
- Two further regression assertions expose one remaining defect: CLI startup diagnostics directly
  emit control characters from unknown options and failing file paths. Diagnostics must render those
  values safely before writing to a terminal, consistent with the existing no-terminal-injection rule.
  Reproduction: `tests/reviewer-flows.test.ts`; evidence `.dsh-runs/phase3-reviewer-round1.log`.
- Review tests additionally cover exact BOM/Unicode/CRLF bytes, concurrent no-clobber saves, failed-save
  preservation, byte limits, invalid input, search indexing/wrapping, real file dialogs, overwrite
  cancellation, small-terminal behavior, and terminal lifecycle. DSH must include every test file in
  both normal and sandbox commands without changing reviewer-owned assertions.
- Status: review in progress; phase 3 is not accepted yet. No phase 4 work has started.

### Launch-command rework after initial submission

- DSH's first submission completed in 15m12s and passed check/build/help and all 147 sandbox tests.
  Codex independently passed all 147 ordinary tests (20 reviewer tests) and reviewed the fixes.
- Real Windows terminal testing confirmed editing, repeated find, saving, dirty-quit protection,
  reopening a spaced path, and help. An instrumented real-TTY invocation recorded main/Node exit 0
  and raw mode false. `npm run demo` opened the bundled file correctly.
- However, the advertised `npm start -- "path with spaces.pas"` command failed on Node 22.14.0 /
  npm 10.9.2 / PowerShell 7: the current chained start script passes literal caret escapes in the
  path, producing ENOENT. Reproduced both inside and outside Codex's process sandbox. Direct CLI
  launch and in-app Open accept that same path correctly. This is a launch-script defect, not a
  new feature request or a DSH sandbox repair.
- Rework: fix npm launch argument forwarding while retaining automatic build and the existing
  CLI path contract. A separate npm `prestart` build plus a simple start command is an appropriate
  approach to verify. Add a regression that invokes npm with a real spaced path, and preserve
  all reviewer tests. Run the complete DSH acceptance commands again with full logs, same session,
  Flash/Max and workspace-write. Codex will repeat the documented terminal launch afterward.
- No phase acceptance until this launch defect is corrected and independently verified.

## Phase 3 — accepted and paused, 2026-10-19

**Decision: ACCEPTED. The planned Pascal Desk editor is delivered; development is paused before phase 4.**

### Delivery

- Real UTF-8 Open, Save, Save As and New; paths with spaces; BOM, Unicode, LF/CRLF and trailing
  newline preservation under the documented normalization policy; validated inputs up to 1 MiB.
- Temporary-sibling saves, atomic no-clobber installation and explicit overwrite confirmation;
  failed operations retain the document, undo history and dirty baseline.
- Literal ASCII-insensitive Find/Find Next with wrap and highlighting, dirty New/Open/Quit protection,
  bounded dialogs and small-terminal handling, CLI file loading, an example and launch documentation.
- Existing editing, navigation, undo/redo and Pascal coloring remain available. No compiler,
  execution or debugger was added. No runtime dependencies were added.

### DSH implementation and review corrections

- Both runs used the verified Flash/Max headless profile and workspace-write sandbox, with the
  normal Windows readiness preflight. No sandbox bypass, permission repair, profile edit or bridge change.
- Same session throughout phase 3: `<local-session>`.
  Initial report: `.dsh-runs/20261019-125136-report.md` (15m12s, STATUS DONE).
  Launch rework report: `.dsh-runs/20261019-130934-report.md` (8m18s, STATUS DONE).
- Reviewer regressions exposed and DSH corrected ignored save-close failures, hidden discard
  confirmations (including terminals with one to three rows), repeated-query search positioning,
  and unsafe control characters in CLI diagnostics.
- Real-terminal review exposed Windows npm argument corruption for spaced paths. DSH moved build
  steps to prestart/predemo hooks, kept the launch commands simple, documented quoting, and added
  a real npm argv regression. This was an additional corrective run in the same DSH session.
- DSH implemented all product changes and ran its own checks. Codex authored independent acceptance
  tests, reviewed code and corrections, and independently verified the result. Product scope stayed fixed.

### Final validation

| Check | DSH sandbox | Independent Codex |
|---|---|---|
| Typecheck | PASS | PASS |
| TypeScript build | PASS | PASS (ordinary test script builds first) |
| Complete suite | 148/148 PASS | 148/148 PASS, ordinary worker isolation |
| Direct CLI help | PASS, exit 0 | PASS, exit 0 |
| Real Windows terminal | Codex-owned check | PASS, behavior detailed below |

- All 14 source test files are present in both commands; zero failures, skips or cancelled tests.
  Total: 128 DSH tests and 20 Codex reviewer tests. Reviewer-owned assertions remain intact.
- Final DSH output and immediate exit codes: `.dsh-runs/phase3-launch-rework-checks/`.
  Final independent output: `.dsh-runs/phase3-final-{check,test,help}.log` and `phase3-final-exits.json`.
  Hashes of the independently verified source/tests/configuration: `.dsh-runs/phase3-final-verified-hashes.json`.
- Real 80x24 Windows terminal: opened a spaced path, found and advanced matches, edited, exercised
  undo/redo, saved, checked exact disk content, rejected Enter/N on dirty quit, explicitly discarded
  before reopening, displayed Help, and restored the terminal on quit. Final npm start with a spaced
  path and npm demo both ran their build hooks and opened the correct file.
- An instrumented actual-TTY run recorded application return 0, Node exit 0 and raw mode false.
  The surrounding PowerShell PTY tool reported 1; the recorded application lifecycle distinguishes
  that wrapper result from Node's exit. Evidence: `.dsh-runs/phase3-terminal-smoke/`.
- All 34 protected baseline files remain unchanged, including the bridge package, dependency lockfile,
  TypeScript configuration, syntax module and original reviewer tests. Core edits are confined to the
  approved BOM change, with additive core tests. No weakened or omitted baseline coverage found.

### Use and boundaries

- Run `npm run demo` or `npm start -- "path/to/file.pas"` in a real terminal. Both build automatically.
  After building, use `node dist/src/cli.js --help` for application help; npm 10.9.2 intercepts its own
  `--help`, so the product document's older npm-help wording was corrected to the verified command.
- Limits remain: one buffer, 1 MiB UTF-8 files, ASCII-oriented cursor/display widths, simple single-line
  Pascal coloring, no compiler/debugger, no clipboard or multiple buffers. Mixed/lone-CR endings normalize.
- Windows was exercised directly. No macOS or Linux interactive verification is claimed.
- No commits, pushes or branch changes. Phase 4 has not started and has no authorized scope.
