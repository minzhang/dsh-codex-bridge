# Execution status, stop and recovery

The bridge records each invocation under the target repository's ignored
`.dsh-runs/control/`. This operational metadata is separate from the task report:
the canonical `<run>-result.json` still holds execution outcome, per-run token usage,
the implementer's claim and pending independent acceptance. Token counts belong to
execution metadata; they are not part of the implementer's business report.

One repository can have one managed execution at a time, including preparation and
report finalization. Changing `-OutDir` or `-Session` does not bypass that ownership.
The default DSH execution timeout is **180 minutes (3 hours)**; use
`-TimeoutMinutes 360` for a task expected to need six hours. Zero means immediate
timeout, and negative values are rejected. The timeout starts at DSH launch;
preparation and report helpers have their own bounded waits.
Windows preflight allows ten minutes; inventory and report helpers allow two minutes each.

## Inspect without starting DSH

After the installed skill prepares the project runtime, Codex runs from the target project:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Status
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Scan
```

`Status` returns the active or latest run. Add `-RunId <id>` to inspect an older run.
`Scan` lists unfinished, uncertain and failed runs needing attention, including
stale ownership. Both return JSON and are read-only: no model launch, API credentials,
permission repair or automatic recovery. Empty history is a normal empty result.
Inspect top-level `errors` and per-run `errors` even when the inspection command exits zero.

| Observed state | Meaning and next step |
|---|---|
| `ACTIVE` | Recorded launcher is alive. Check its stage, heartbeat and artifacts. |
| `ORPHANED` | Launcher has ended but an owned process is still alive. Stop that run before recovery. |
| `INTERRUPTED` | Execution is unfinished and recorded writers are confirmed stopped. Review evidence, then Recover. |
| `FINISHED` | Execution finished and its writers stopped. Read the outcome/result; this is not task acceptance. |
| `RECOVERED` | Explicit recovery recorded and stale ownership released. Code may still be incomplete. |
| `UNKNOWN` | State, identity or liveness cannot be established. Preserve the evidence and resolve the diagnostic first. |

`stage` distinguishes PREPARING, RUNNING and FINALIZING from terminal stages.
`heartbeatAt` records bridge supervision; `lastActivityAt` tracks event/stderr writes.
Neither a stale heartbeat nor quiet output proves a hung or dead model. Process identity
uses PID plus creation time, so a reused PID is not mistaken for the old execution.
`requestedSession` alone does not prove a successful resume; `observedSession` and
`sessionProvenance: EVENT` come from captured DSH events. A mismatch fails the run.

## Stop a specific run

Preview first when useful; mutation requires an explicit run ID and reason:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Stop -RunId <id>
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Stop -RunId <id> -Apply -Reason 'Execution no longer matches the current task'
```

Stop records the request and terminates only that run's owned process trees. The launcher
can finish its report; inspect Status afterward. If the launcher itself was interrupted,
Recover may still be needed. Stop does not accept the task, discard changes or reset Git.

## Recover after interruption

When Codex resumes work after a crash or a launch is refused because the repository is
occupied, use Scan and inspect the named run's events, stderr, result and actual working diff.
Do not delete the ownership file to force another launch.

```powershell
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Recover -RunId <id>
pwsh -NoProfile -File dsh-codex-bridge/dsh-run.ps1 -Repo . -Action Recover -RunId <id> -Apply -Reason 'Confirmed interrupted run; retained changes inspected'
```

Recover rechecks ownership and process identities under the same coordination lock used
by launch and Stop. It refuses live writers or uncertain state. It retains raw evidence
and code, preserves an existing canonical result, and reconstructs a missing result when
recorded facts allow it. An unknown execution exit becomes FAILED with a null original
exit and bridge exit 1, never an invented success. Available usage is PARTIAL/UNAVAILABLE
when the interrupted work cannot be fully accounted for. A durably recorded completed
execution can retain its actual outcome. Acceptance stays PENDING.

Recovery itself never starts DSH, retries a command, rolls back files or chooses a session.
After reviewing the diff and tests, explicitly invoke `dsh-impl.ps1` again. Follow the
[session choice rule](../SKILL.md#choose-a-dsh-session): normally resume related work with
`-Session <confirmed-id>`, or omit `-Session` for a new session, recording a short reason.
The next task prompt supplies the needed context; no separate handoff document is required.

## Boundaries and evidence

- Managed execution and recovery currently require Windows 10 or newer with PowerShell 7.
  Other platforms have not been verified. There is no background monitor or automatic restart.
- Windows job containment covers the launched DSH process and ordinary descendants, plus
  preparation/report helpers. Closing the owning bridge kills these trees. Processes
  launched through external services are outside this guarantee.
- The default preflight remains enabled and workspace-write confinement is unchanged.
- `-OutDir` must be inside the repository and outside the reserved `.dsh-runs/control/` tree.
  Control/artifact paths reject reparse points
  and hard links. Keep local evidence where it was created; do not copy ownership records
  between repositories or edit their process identities.
- Control writes are atomic. Scans are limited to 5,000 run records; archive reviewed
  terminal evidence before exceeding that limit. Preserve unresolved records.
- A failure before DSH launch may have only a control record and diagnostic, with no
  canonical result yet. Corrupt or inaccessible records stay visible and block new
  execution until their cause is understood; recovery does not guess missing facts.
- Scan covers invocations recorded by this version. Older runs without control records
  remain ordinary local evidence and are not automatically adopted or restarted.
