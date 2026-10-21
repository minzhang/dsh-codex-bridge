# Reliable execution ownership, interruption detection and explicit recovery

Status: implemented and verified by Codex on 2026-10-21; see development/reviews.md.
Owner and implementer: Codex, using the user's selected model. Baseline: 50448bb.
The user clarified that this repository itself must not delegate development to DSH. The
initial delegation was stopped before any production edits; its local evidence is retained.

## 1. Goal and scope

Improve the existing local one-way DSH delegation path so a timeout, killed bridge, failed
launch/session resume or interrupted finalization does not silently permit a second writer
or lose the evidence needed to resume work. Worktree functionality is deferred in design 008.
No automatic restart, daemon, scheduler, bidirectional conversation, credential/profile
change, dependency, packaging or CI is included. Keep Flash/max, workspace-write and normal
Windows preflight. Codex explicitly decides recovery and session selection.

This change affects execution control, not the implementer business-report schema. A model
claim and an exit code remain separate from independent acceptance. Preserve existing report,
usage, sandbox and real-child-process assertions; no skipped checks to accommodate a backend.

## 2. Public interface and user decisions

Existing dsh-impl.ps1 invocations continue to work, with automatic repository ownership and
start/end records. Keep -Session semantics and increase the default hard run timeout to
180 minutes (3 hours), as requested by the user. Per-run overrides remain available. Keep zero
timeout as an immediate-timeout case used by existing tests; reject negative timeout early.
DryRun must not acquire execution ownership or leave a live-run record.

Add dsh-codex-bridge/dsh-run.ps1:

    pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Status
    pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Scan
    pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Recover -RunId <id> -Apply -Reason '<reason>'
    pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Stop -RunId <id> -Apply -Reason '<reason>'

Status reads the active/latest run, or an explicit RunId; Scan lists recorded runs requiring
attention (including uncertain/corrupt records), with enough evidence to choose the next step.
Both are read-only and require no API credentials or DSH startup/preflight repair. Return a
documented JSON object to stdout suitable for Codex; diagnostics belong on stderr. No records
is a normal empty result. An invalid/unreadable selection returns a clear nonzero failure.
Recover/Stop without Apply are previews; mutations require an explicit RunId and nonempty
Reason. Recover never launches DSH or chooses a session. Stop affects only the proven owned
process tree for that run; an uncertain identity must be refused rather than guessed.

After Recover, Codex inspects the working diff, tests/logs and current design, then invokes
dsh-impl normally using either the verified old session or a new session, with a reason.
There is no new handoff-document requirement. Never roll back, reset, clean, delete user
files or automatically replay commands during recovery.

## 3. Persistent ownership and observability

Use one fixed repository-local ignored control location under .dsh-runs, independent of
OutDir and bridge installation path. Normalize repository identity (including Windows case
and aliases) before locking. Execution ownership applies per repository, not per session or
output directory. Two simultaneous launchers must never both start DSH. Serialize launch,
Stop and Recover mutations with the same coordination mechanism and an ownership generation
token so delayed finalizers/recoverers cannot release a newer run's ownership.

Persist a versioned run-start record atomically before launching DSH (and before fallible
preflight/DSH resolution once the repository/control storage can be resolved). Record runId,
canonical repository, design reference, requested session, observed session and its provenance,
UTC timestamps, stage, launcher/supervisor and child process identities (PID plus creation
time, never PID alone), artifact pointers, timeout, heartbeat/last-observed activity, end
outcome and recovery diagnostics. Never store credentials. Reuse existing run IDs and
artifact names. Persist facts required for recovery; don't rely on a live Codex conversation.
Lifecycle metadata is operational evidence, separate from task business results.

Stages must distinguish preparing, running, finalizing and terminal states. Observation
must distinguish a confirmed active run, an orphan whose child is still active, an interrupted
inactive run, a normally finished run and UNKNOWN. A stale heartbeat or silent stream alone
is not proof of death or lack of useful progress. Record heartbeat while supervising and
separate it from last event/log activity. Prefer incremental event observation to repeatedly
reading an unbounded stream. Session confirmation comes from a DSH session event; requested
fallback alone is not proof of successful continuation. Detect/report requested vs observed
session mismatch; do not silently call it a successful resume or auto-switch sessions.

At startup, refuse an active or unresolved previous owner with the run ID and actionable
Status/Scan/Recover instructions. Never automatically remove a stale-looking owner. Missing,
malformed, partially written, incompatible or inaccessible ownership evidence must fail
closed for launching/mutation and stay visible to diagnostics. A timeout/error must not
release ownership while child processes may still write. Preserve evidence after recovery.
Runtime metadata paths must be bounded, reject traversal/link escapes and never follow
arbitrary record-supplied paths for deletion or process termination. Validate before mutation.
If external OutDir cannot be recovered safely, reject it clearly before launch and document
the restriction rather than following unsafe recovery pointers.

## 4. Process lifetime, timeout and abnormal termination

Remove process-name/start-time-wide Stop-OrphanDsh cleanup. Associate each launched process
tree with its run, including a test child. On Windows use a job object with kill-on-close
or an equivalently strong owned-tree mechanism, with launch ordering that prevents an
untracked child escaping if the bridge dies between process creation and record persistence.
Native Windows interop via existing PowerShell/.NET is allowed; no new package dependencies.
Do not enable breakaway or disable DSH confinement to make process ownership work. If safe
containment cannot be established, fail before the task starts and explain why.

Timeout must terminate only that run's process tree, wait for confirmed termination, then
finalize TIMEOUT/124 with available artifacts and partial token usage. Cancellation/bridge
death must either stop that tree through OS containment or leave accurate ownership that
blocks another writer. A killed launcher must not leave a falsely successful run.
Keep launcher, DSH and child-tool processes distinguishable. Verify identities on inspection
and termination; PID reuse, another repository's run and unrelated same-name processes are
never termination targets. Stop is explicit, records its reason and does not mark task accepted.

Current Windows environment is the verification target. Preserve existing non-Windows entry
points where possible, but do not claim a tested cross-platform recovery guarantee. If a
backend cannot prove safe ownership/termination, refuse destructive recovery, report UNKNOWN
and document that limit; never fall back to name-based kills.

## 5. Scanning and recovery semantics

Scan is a bounded, repository-local read, driven by the fixed control records (works even
with a custom safe OutDir). Inspect actual process identity and record/result state together.
No final result is not a conclusion by itself. A completed result paired with a live owner
is not grounds for release. Known-dead owner with live child is ORPHANED/active, not recoverable.
PID creation-time mismatch means that particular recorded process is gone, not permission to
kill the new PID occupant. Access-denied/unknown liveness stays UNKNOWN and blocks mutation.

Recover must revalidate under the exclusive coordination guard before changing anything.
Only release stale execution ownership after all owned writers are proven stopped. Keep a
durable recovery record (run, reason, prior state, time, action) and the old raw artifacts.
If finalization was interrupted and a complete, credible recorded exit/final result exists,
retain it. Never overwrite a valid existing canonical result or fabricate zero exit/DONE.
If the execution outcome is unknown after interruption, finalize as execution FAILED with
originalExitCode null, bridgeExitCode 1 and an explicit interruption diagnostic; do not label
it LAUNCH_FAILED if DSH is known to have started. Acceptance remains PENDING. Available usage
must be PARTIAL/UNAVAILABLE with unreported work unknown. Keep schemaVersion 1 and existing
execution enums; optional validated lifecycle metadata may be additive.

If safe canonical reconstruction lacks required data, report that limitation in the recovery
record and retain the evidence; never invent it. Recover is idempotent for an already recovered
run, and cannot clear a later run's owner. A recovered task may still contain broken or partial
code: restarting is an explicit Codex decision after inspecting work and updating the task.

## 6. Files and integration

Codex may modify/add production implementation in:
- dsh-codex-bridge/dsh-impl.ps1 and new dsh-run.ps1;
- new focused lifecycle helpers under dsh-codex-bridge/node/ and/or windows/lib/;
- node/run-report.mjs for additive lifecycle/diagnostic and interrupted-finalization support;
- mcp/dsh-mcp-server.mjs only as needed to preserve usable errors/artifact paths. The management
  CLI is sufficient for this phase; no new MCP tools required.
- development/tests/bridge-lifecycle.test.mjs (new) and focused regression additions to existing
  bridge/config/usage/report or Windows syntax tests; package.json to synchronize test lists.
Tests that copy a partial delivery fixture must copy required new runtime files as necessary;
preserve every existing behavior/assertion. No production dependency on development/.
Codex also updates delivery README/SKILL/AGENTS documentation and development records.

## 7. Acceptance

Use real disposable child processes, file-backed capture and unique bounded temp fixtures.
Cover: normal run; launch/session failure; safe same-session resume; live Status/heartbeat;
same-repo concurrent attempts (also different OutDir); timeout killing only the owned tree;
killed launcher with a real child; interrupted finalization; recovery and next successful run;
preview/read-only invariants; refused recovery while any writer lives; PID reuse/uncertainty;
malformed ownership state; path/junction escape refusal; preserved raw evidence/results;
repeated/racing Recover versus launch; custom OutDir; no false COMPLETE usage on interruption.
No broad process kills in tests either. Setup repairs only unique host-temp disposable repos.

The earlier affected-only instruction was for design 007; this lifecycle change follows the
current repository's complete bridge/demo verification rules. Codex runs no-worker and ordinary
suites and leaves exact full logs and exit codes. Codex also runs Windows checks, copied-folder
delivery and real owned-child termination tests using disposable fixtures and controlled fake
DSH launchers. Per the user's model/ownership instruction, no further DSH agent is launched for
this repository's work. No fresh live-model, worktree or additional platform verification is claimed.

<!-- dsh-acceptance-start -->
[
  {"id":"A1","command":"npm run test:sandbox","cwd":"."},
  {"id":"A2","command":"npm run test:windows","cwd":"."},
  {"id":"A3","command":"npm --prefix demos/pascal-desk run check","cwd":"."},
  {"id":"A4","command":"npm run test:demo:sandbox","cwd":"."},
  {"id":"A5","command":"node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts","cwd":"."}
]
<!-- dsh-acceptance-end -->

## 8. Review notes

Codex implemented and reviewed the change directly after the user's model/ownership
clarification. The initial delegation was stopped before production edits. No subsequent DSH
model session was used. Windows job containment covers DSH launch and preparation/report helpers;
the real installed sandbox's repair/verify/rollback probes also passed inside this containment.

Review corrected a report-helper orphan on bridge death, a session-return mismatch in an old
fake launcher fixture (all assertions retained), recovery interrupted between recording its
completion and releasing ownership, and custom output entering the reserved control directory.
The final two production corrections received focused ordinary and no-worker regression runs.
Existing reports and session/token accounting remain compatible, with mismatched session IDs
now rejected. The complete verification record and explicit platform limits are in the review.

Preserve the downstream restriction that DSH does not commit, publish or access GitHub
credentials. No authentication/profile settings were changed.
