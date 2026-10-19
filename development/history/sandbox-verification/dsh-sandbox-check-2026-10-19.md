# DSH sandbox repair verification — 2026-10-19

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

**Scope:** verification only, requested by the user. Phase 3 remains paused.
**Reviewer:** Codex. **Executor:** DSH through the supplied bridge, workspace-write mode.

## Goal

Verify the repair documented in `docs/dsh-sandbox-repair.md` through a real DSH agent shell tool.
Distinguish shell provisioning, nested writes, typecheck, build, standard tests, and single-process tests.

## Exact task

Read `AGENTS.md`, then use the ordinary confined `pwsh` tool to execute this one command:

```powershell
& '<workspace>\.dsh-runs\verify-dsh-sandbox-20261019.ps1'
```

Use a tool timeout of 180000 ms or higher. The script runs each diagnostic independently and
prints results. Do not stop after its first failing check. If the script itself cannot start,
report that exact error without retrying or repairing anything.

## Allowed effects

- The script may create/read/remove only its uniquely named disposable probe files inside this repo.
- It may run version, typecheck, build, and test commands. Build may rewrite ignored `dist/` outputs.
- No edits to production source, tests, configuration, docs, bridge, permissions, or credentials.
- Do not install packages, widen sandbox access, repeat failed probes, or launch another agent.
- Do not implement phase 3. Do not review/reason through the product source; this is an execution check.

## Reporting

Immediately after the command finishes, report each check's actual exit/result and key failure text.
Report whether shell startup is repaired and whether the full normal build/test workflow now works.
Keep the report brief. A known remaining environment limitation is an observation, not a request
to fix it. Do not claim the single-process fallback is equivalent to passing the normal test suite.

## Recorded result

Completed through DSH session `<local-session>`.
Shell startup and `npm run check` pass. Nested writes, build outputs, and Node child-process
spawns remain blocked. DSH reports 69/74 tests passing with isolation disabled; this does not
replace the normal acceptance suite. Details and evidence are in `docs/dsh-sandbox-repair.md`.
Phase 3 remains paused. No implementation or further repair was attempted.
