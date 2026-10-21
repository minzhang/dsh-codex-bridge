# Reliable one-way implementation reports

> Onboarding directions were updated by [design 010](010-skill-only-usage.md).
> Dated implementation and verification results below remain historical evidence.

Status: accepted after DSH implementation, same-session rework and independent Codex
verification, 2026-10-20. Implementation and publication were authorized by the user.
Design/review owner: Codex. Implementer: DSH.
Base: main at 1996948a2cf70d5ec1d0b8196179bc2b4156cfd0.

## Goal and boundaries

Keep one non-interactive delegation followed by one report. Make the report distinguish
process outcome, implementer claims, report validity and independent acceptance, with
traceable check coverage and honest observations of working-tree changes. Implement all
five improvements discussed with the user. No bidirectional channel, progress service,
new dependencies, demo features, CI, packaging or global/profile/authentication changes.
DSH must not commit, push, switch branches or access GitHub credentials.

Use Flash/max, Not Allow, workspace-write and normal Windows preflight. Preserve all
existing assertions and actual subprocess checks. Existing fixtures may produce the new
report format instead of the superseded unstructured output, retaining their sentinel
text and every configuration/forwarding assertion. Same DSH session for every rework.
The current run may have been launched by the old bridge: its final response should still
be the JSON implementer report specified below, even if the old prompt requests prose.

## Public result contract

Add `<run>-result.json` beside the existing prompt, patch, events, stderr and Markdown
artifacts. Schema version is numeric 1. One canonical in-memory result drives JSON,
Markdown, terminal summary and MCP structuredContent; keep the readable MCP text too.
Keep existing CLI options, effective configuration and `session:` / `report:` output
lines; add `result:` with a repository-relative result file path. Put the four outcome
dimensions and artifact pointers before long text. Keep artifacts ignored and local.

Required result sections (document exact implemented schema):

- `schemaVersion: 1`, `runId`, `sessionId` (nullable), design path and timestamps.
- `execution`: status `SUCCEEDED | FAILED | TIMEOUT | LAUNCH_FAILED`, original DSH exit
  code (nullable when unavailable), bridge exit code, duration and effective settings.
- `task`: status `DONE | BLOCKED | PARTIAL | UNKNOWN`, summary, changes, checks,
  decisions and followUps. This section is explicitly an implementer claim, never acceptance.
- `report`: validity `VALID | INVALID | MISSING`, errors and warnings; retain the raw final
  text either here or via a named artifact. Invalid output cannot yield a trusted DONE.
- `acceptance`: status always `PENDING` for a DSH report; coverage
  `COMPLETE | INCOMPLETE | NOT_DECLARED`, expected check IDs and missing IDs.
- `observations`: working-tree comparison, tool call/error counts and token use when known.
- `diagnostics`: malformed event line count and line numbers (not raw sensitive content),
  last valid event type/phase, turn end/error information, capture/inventory errors.
- `artifacts`: paths for the existing run files and result. Full logs are not echoed wholesale.

Execution SUCCEEDED only states the child exited normally with code zero, independently
of report validity or task status. Preserve nonzero DSH exits and timeout exit 124. If the
child exits zero but the report is missing/invalid or internally inconsistent, bridge exits
65. A valid BLOCKED or PARTIAL with normal execution exits zero and is a normal MCP result.
DONE with declared checks missing, failed, blocked or unrun is invalid, not accepted.
Tool errors followed by successful recovery do not alone make a task fail.

MCP must return the same validated result in `structuredContent`, with text summary and
isError based on the bridge exit. Read only the exact expected result artifact within the
selected repository/run location; reject outside or reparse/symlink escapes. Treat an
invalid/missing result after a normal bridge run as an error, not success. Early argument,
configuration or preflight failures retain their existing before-artifact semantics and
plain diagnostic failure response. Do not forge a structured success for those failures.
Dry runs retain their current behavior and do not require a result.

## Implementer final response and validation

Request a single JSON object as the final message, without fences, with these required keys:

```json
{
  "schemaVersion": 1,
  "status": "DONE",
  "summary": "Concrete result ready for review",
  "changes": [{"path": "relative/file", "description": "What changed"}],
  "checks": [{
    "id": "A1",
    "command": "actual command",
    "cwd": ".",
    "status": "PASS",
    "exitCode": 0,
    "logPath": ".dsh-runs/checks/a1.log",
    "reason": ""
  }],
  "decisions": [],
  "followUps": []
}
```

Status is DONE/BLOCKED/PARTIAL. All shown keys/types are required; changes/checks and the
string arrays may be empty. Check status is PASS/FAIL/NOT_RUN/BLOCKED. exitCode is an
integer or null, logPath a relative string or null, cwd a repository-relative directory.
PASS requires zero; FAIL requires a nonzero integer; NOT_RUN/BLOCKED require null and a
nonempty reason. IDs must be unique nonempty strings. BLOCKED needs a nonempty followUp
or summary describing the blocker. Paths must not escape the repository. No evaluating
commands from reports, and no running a model-supplied command just to validate it.
Reject inconsistent types, unsupported versions, malformed JSON and missing required
keys. Store the original final text for diagnostics. A legacy STATUS prose response is
retained as raw text but marked INVALID with migration guidance, never silently accepted.

For check evidence annotate `source: IMPLEMENTER` and log availability
`PRESENT | MISSING | NOT_PROVIDED | UNSAFE`. Existence of a file is not evidence that the
command passed, and must not be labelled independently verified. Missing/unsafe claimed
logs produce visible report diagnostics and prevent a DONE report claiming evidence
completeness. Null logs remain explicitly NOT_PROVIDED; require a safe existing log for
PASS/FAIL of a declared acceptance check. Never follow a symlink/reparse into unrelated
paths or read log contents automatically. Logs and model output remain untrusted data.

## Declared acceptance checks

Add an optional JSON manifest in the design between the exact comment markers used below.
It contains an array of objects with unique `id`, `command` and `cwd` strings. A malformed
or duplicate-ID manifest is a design-input error before launch. Old designs without the
manifest remain usable with coverage NOT_DECLARED; do not claim they are fully covered.
The delivery design template documents the markers and includes a concrete example.

For a declared manifest every ID must appear in the implementer checks, including NOT_RUN
or BLOCKED cases. Coverage means ID coverage, not test success. Check declared command/cwd
against the reported command/cwd. Commands may only trim surrounding whitespace; cwd may
also normalize slash separators. Do not rewrite command arguments, quoted code or URLs;
do not accept a different command as satisfying that ID. Extra checks are allowed and
marked as additional. Missing declared checks make coverage INCOMPLETE and report INVALID.
Keep this validation clear for PARTIAL/BLOCKED: include every unrun declared check with a
reason instead of omitting it. A valid partial report may contain explicit failures.

## Working-tree observations

Replace the current assumption that pre-existing dirty paths are "not this run".
Take before/after inventories of relevant Git tracked and untracked nonignored files,
including index state, raw names (NUL-safe porcelain or equivalent), content SHA-256,
type and presence. Do not traverse .git, ignored run artifacts, dependencies or products;
do not follow symlinks/reparse points. Capture link identity safely if possible, otherwise
record unknown. No content snapshots in published files and no stash/reset/commit tricks.

Classify observed paths as `NEWLY_CHANGED`, `PREEXISTING_CHANGED`, `PREEXISTING_UNCHANGED`
and `UNKNOWN` where the comparison is unavailable. Include deletes, adds, renames (two
paths acceptable), restoration to HEAD and staged-only changes. A dirty file modified
again must appear as PREEXISTING_CHANGED, even if porcelain status is unchanged.
Use "observed during this run"; never assert causal attribution to DSH when concurrent
edits are possible. Retain DSH's changed-file claims separately. For non-Git repositories
report observation UNAVAILABLE; tool path mentions are not proof of modification.
Inventory failures are explicit warnings; do not silently report no changes.

## Failures and resilience

During a launched run preserve available artifacts even on launch failure, nonzero exit,
timeout, no final event, truncated/malformed event lines or incomplete output. Count and
report parsing failures; do not silently drop them. Keep a valid final report separate
from the condition of the event stream. Invalid event lines make diagnostics visible and
report INVALID conservatively. Tolerate unknown valid event types for forward compatibility.
Use the requested session as a fallback when no new session event is available and label
that provenance. No invented session IDs or missing-code-as-zero behavior.

Best effort does not mean hiding disk errors. If a result cannot be written/read, return
a visible nonzero infrastructure failure with available artifact paths. Write the result
atomically through a sibling temp file when feasible. No arbitrary recursive cleanup.
Keep timeout handling bounded and preserve the run evidence. This phase need not redesign
the existing DSH process cleanup mechanism.

## Files and implementation boundaries

DSH may edit dsh-codex-bridge/dsh-impl.ps1, mcp/dsh-mcp-server.mjs, README.md, AGENTS.md,
docs/design/TEMPLATE.md and docs/node-testing.md under delivery, plus root README.md,
development/README.md, package.json and development/tests/bridge-config.test.mjs.
It may add delivery node/run-report.mjs (or a small reporting-only PowerShell helper under
delivery/lib/) and development/tests/bridge-report.test.mjs. Keep runtime self-contained
and a single canonical implementation. Update test fixtures to copy any new helper when
they isolate the runtime; retain the installed-skill preparation path.
Codex owns this design and development/reviews.md. Skill docs may receive a minimal status
terminology/reference update only; preserve all existing onboarding instructions.
Do not modify Windows permission implementation or demo source/tests.

## Acceptance and evidence

Add meaningful actual subprocess regressions for DONE/BLOCKED/PARTIAL, exit-zero invalid
or missing final, nonzero execution, timeout, malformed events, launch/capture failures,
session fallback, required fields/types/version, contradictions, manifest coverage and
duplicate IDs, wrong command/cwd, log availability and traversal/link refusal. Test dirty
file edits, unchanged dirty files, new files, deletion, unusual/spaced filenames, restored
files and staged changes with actual disposable Git repositories. Check non-Git fallback.
Exercise MCP text + structuredContent equality, normal blocked/partial outcomes and safe
artifact reading. Preserve all original tests and synchronized ordinary/sandbox lists.
Keep test fixtures in unique bounded host-temp roots; never repair this repository.

Run all commands below and save complete logs and actual exits in ignored
.dsh-runs/report-checks/. Include every manifest item in the final response.

<!-- dsh-acceptance-start -->
[
  {"id":"A1","command":"npm run test:sandbox","cwd":"."},
  {"id":"A2","command":"npm run test:windows","cwd":"."},
  {"id":"A3","command":"npm --prefix demos/pascal-desk run check","cwd":"."},
  {"id":"A4","command":"npm --prefix demos/pascal-desk run build","cwd":"."},
  {"id":"A5","command":"npm run test:demo:sandbox","cwd":"."},
  {"id":"A6","command":"node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts","cwd":"."}
]
<!-- dsh-acceptance-end -->

Codex independently reviews and runs npm test, npm run test:windows, demo check/build,
npm run test:demo and the A6 consumer. Verify installed-skill project preparation and the two
host-only reviewer-lifecycle.ps1 scenarios if necessary for the changed delivery contents;
those repair only their own unique host-temp fixtures and retain recovery evidence.
Perform a live same-session follow-up through the newly implemented bridge to verify the
actual DSH JSON contract. Record real results and any rework in development/reviews.md.
After acceptance, commit and push the existing GitHub main branch without force, verify
remote HEAD and report the commit. No permission question is needed for this authorized push.

## Review notes

Independent review of the first helper draft found three reproducible issues. Evidence is
local in .dsh-runs/report-review/edge-probes.mjs and edge-probes-results.json:

1. Command comparison collapses repeated forward slashes. A report for
   `node test.mjs /target` is accepted for declared `node test.mjs //target`. Preserve
   repeated slashes and command contents. Review clarification: commands may only trim
   outer whitespace; separator normalization is allowed only for cwd, not command text
   or its quoted arguments/URLs. Update prompt/docs consistently. Add regressions where
   different repeated slashes or backslash escapes cannot satisfy a declared command.
2. Inventory checks only the leaf for a link. With a tracked `tracked/sample.txt`, replace
   its parent directory with a junction to an outside sibling fixture; the inventory
   hashes the outside file. Check ancestors before any content read, including clean-path
   follow-up inventory. Mark unsafe paths unknown with a warning, never traverse the link.
   Add a real disposable junction regression. The independent probe's outside file belongs
   to its own unique host-temp fixture; no unrelated content was read.
3. `buildResult` puts `facts.captureErrors` into diagnostics but does not invalidate the
   report or prevent exit zero. Calling finalizeRun with a valid final event, exitCode zero
   and a nonempty captureErrors array currently returns VALID and bridge exit zero.
   Preserve the diagnostics and original exit separately, but mark the report invalid and
   return a nonzero bridge exit. Include supplied inventoryErrors in diagnostics as well;
   inventory-only problems can remain warnings with observation unavailable.

Test review: in the MCP junction fixture, avoid creating then recursively removing
`.dsh-runs`; create the junction directly at its fresh missing path. Any remaining
recursive delete/move must verify its resolved target is under the unique fixture root.
The Windows junction regression must assert creation succeeded and assert refusal of that
actual junction, rather than counting an unrelated missing-file error as a link-safety
pass. Keep real regression coverage in both ordinary and sandbox suites.
Also clear `git diff --check` findings (currently a new blank line at dsh-impl.ps1 EOF).

For report-only rework, rerun the complete bridge sandbox suite and the syntax scan after
the fixes. Retain the completed A2 Windows behavioral regression and A3-A6 logs if none of
their implementation/tests changed; do not rerun the large object-count suite merely to
refresh an unchanged result. Describe reuse of those exact command logs in the final report.
Codex will independently run ordinary bridge tests on the final source and likewise reuse
its already completed demo/consumer and unchanged Windows checks, with a final syntax scan.

These findings were returned to the same DSH session; resolution is recorded below.

## Final acceptance

All three findings and the fixture/formatting notes were corrected by DSH in the original
session. Four independent host probes now pass. Final bridge suites pass all 50 tests
with zero failures/skips in both DSH's no-worker runner and Codex's ordinary runner.
The ordinary suite's 26 runtime/test/configuration file hashes stayed unchanged during
testing and still matched after DSH returned. The final syntax scan parsed 10 PowerShell
and 11 Node files. Existing assertions and identical ordinary/sandbox file lists remain.

The complete Windows behavior suite passed in DSH and independently on the host, including
the real 28000/28001-object cases. Both environments passed demo typecheck/build, all 148
demo tests and the TypeScript consumer. These unchanged Windows/demo/consumer results were
retained during report-only rework, with fresh syntax and bridge checks on the final code.
Both host copied-kit lifecycle scenarios and both delivery-route dry runs passed.

The actual same-session rework, launched through the new bridge with normal preflight,
produced schemaVersion 1 with SUCCEEDED / DONE / VALID / PENDING, COMPLETE coverage of all
six declared checks and no capture/parse errors. It observed four PREEXISTING_CHANGED paths
and ten PREEXISTING_UNCHANGED paths, while keeping the implementer's claims separate.
DSH's report remains PENDING by contract; Codex's independent acceptance is recorded here
and in ../reviews.md. Complete logs and raw run artifacts remain local and ignored.
