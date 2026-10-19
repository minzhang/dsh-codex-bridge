# DSH sandbox compatibility repair — 2026-10-19

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

This is an environment repair between accepted phase 2 and paused phase 3.
Codex owns Windows permission diagnosis/repair. DSH owns the test-harness adjustment.
Keep DSH in workspace-write mode and use the saved Flash/Max profile.

## DSH scope

Allowed changes: `tests/cli.test.ts`, `package.json`, and the README's test instructions.
Do not change product source, test names/count/assertions, reviewer tests, dependencies,
the bridge, sandbox configuration, design documents, or phase 3 implementation.

DSH's Windows restricted token cannot use Node's named-pipe stdio capture for descendants.
Accommodate this documented limitation without changing token permissions:

1. Replace the CLI test helper's pipe capture with real subprocesses whose stdout and stderr
   are writable file descriptors. Use a unique directory under `os.tmpdir()` (DSH supplies its
   private writable temp directory); stdin stays ignored. Read both outputs after the process
   closes, preserve exit-code/signal/output assertions, and retain a 10-second timeout that
   fails clearly. Close handles and delete only that helper's own temporary files/directory on
   success, error, and timeout. Keep `windowsHide` and removal of `NODE_TEST_CONTEXT`.
2. Keep the ordinary `npm test` command for environments supporting worker pipes. Add
   `npm run test:sandbox`, building first and running the exact same seven test files with
   `--experimental-test-isolation=none`. No skipped tests or mocked CLI subprocesses.
3. Briefly document both commands and why sandbox isolation is disabled for the test runner.
   This changes test execution, not DSH confinement. The underlying pipe restriction remains.

Run typecheck, build, and the sandbox suite if filesystem permissions permit. Report any
remaining access error precisely; Codex is repairing the nested-folder permissions separately.
Final acceptance requires all 74 original tests passing inside the real DSH bridge, with
nested write probes succeeding and an outside-workspace sentinel write still denied.
Leave all changes uncommitted. Do not start phase 3.

## Final reviewer verification round

The bounded permission repair is now applied. Run only the following command through
the ordinary confined `pwsh` tool (timeout at least 180000 ms), then report its actual
exit status and output. Read the two scripts and child probe first. No further edits
or exploratory checks are needed.

```powershell
$fixture = Get-Content .dsh-runs/sandbox-fix/outside-fixture.json -Raw | ConvertFrom-Json
& .dsh-runs/sandbox-fix/verify-final.ps1 -OutsideFile $fixture.file
```

The reviewer-created temp sentinel is an explicitly authorized disposable fixture.
The scripts may read it and attempt an append that must be denied, from PowerShell
and from a real Node child. They may create/remove their own probes under the workspace
and DSH's private temp; run check/build/test:sandbox; and save full logs and a summary
under `.dsh-runs/sandbox-fix/`. A denial or nonzero result must be reported without
altering permissions, sandbox settings, scripts, tests, or product files.
