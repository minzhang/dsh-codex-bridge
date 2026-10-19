# DSH sandbox repair — 2026-10-19

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

## Outcome

**Final outcome: accepted.** DSH's sandbox remains enabled. Existing nested-folder writes,
typecheck, build, and all 74 tests now pass through the actual bridge using `npm run test:sandbox`.
Real Node children also remain confined. Ordinary Node worker pipes are still a backend
limitation, accommodated by the project test harness rather than by weakening confinement.

The initial repair below was performed in a side conversation. Its verification found remaining
failures; the final repair and acceptance are recorded at the end of this report. Phase 3 remains paused.

## Origin of the repository restriction

Codex added the blanket "Do not repair permissions" instruction as a temporary workaround
after the first failed DSH run. It was not a user requirement. Automatic approval review then
treated it as a prohibition and rejected a diagnostic probe. The user explicitly authorized
overriding it. Codex replaced it with bounded repair guidance and the verified status below.

## Diagnosis and repair

- Reproduced the original failure directly through DSH's installed Windows sandbox runner,
  with a confined PowerShell marker command; exit 127.
- DSH's bundled repair tool confirmed the signed-in account had effective WRITE_DAC but lacked
  WRITE_OWNER on the project root. The backend needs both when preparing its write grant and label.
- The tool added the signed-in account's FullControl entry on the project root, backed up the
  original permission list, and verified both required rights. The same confined marker then passed.
- A deeper probe found an existing nested diagnostic folder could not be written. A second bounded
  run of the same tool added the missing account permissions on `.dsh-runs` and its
  `sandbox-repair-proposal` subfolder, with backups and verification. This refreshed inherited
  DSH permission entries, but the confined nested write still failed.
- No foreign app-package entries were found or removed. No owners or deny entries were changed
  by the repair tool. Parent directories outside this repository were inspected only.
- The DSH runner installs its normal standing workspace capability grant and low-integrity label.
  Those are normal sandbox provisioning; it was never run in danger-full-access mode.

## Actual verification

| Probe inside DSH workspace-write sandbox | Result |
|---|---|
| PowerShell marker command | Passed after repair; failed before repair |
| Create/read/remove disposable file at repository root | Passed |
| Create disposable file in the existing diagnostic subfolder | Still denied |
| Append to a controlled temporary sentinel outside allowed roots | Correctly denied; sentinel unchanged |
| Node version | Passed: v22.14.0 |
| npm version | Passed: 10.9.2 |
| Node smoke test with normal worker isolation | Failed: spawn EPERM |
| Same smoke assertion with `--experimental-test-isolation=none` | Passed: 1 test |

The smoke assertion is diagnostic only, not a replacement for product acceptance tests. DSH's
bundled instructions identify piped grandchild `spawn EPERM` as an expected confinement limitation,
not an ACL-repair case. Existing subfolders also still lack the inherited low-integrity label seen
on the repository root; this is evidence for further backend investigation, not a confirmed complete
explanation of every write failure. No recursive permission replacement was attempted.

## Evidence and recovery

The unchanged bundled repair script, its instructions, probe scripts, and logs are in
`.dsh-runs/sandbox-repair-proposal/` (ignored local evidence).

- Root repair report: `recovery/acl-report-72a56424fa2049c28d9526230b0ed848.jsonl`
- Nested repair report: `recovery/acl-report-ba5c6611a8bd451bb9828cc8ed999cff.jsonl`
- Final combined probe: `verification-2.stdout.log` and `verification-2.stderr.log`
- Single-process test: `single-process-test.stdout.log`

Each repair report contains exact recovery commands and independent scripts. To undo the permission
repairs, use the commands from the nested report in its recorded reverse order, then the root report.
Their backups are `acl-backup-6c92455de3f741419486a0c42d3b8bb8.json`,
`acl-backup-d81d78ddcf88461ba26ae8d293179f1b.json`, and
`acl-backup-fae8bef1bd6d43aeb416921e61138c2d.json`, respectively. These restore the saved DACLs;
the scripts deliberately preserve owners and system access-control labels. No rollback was needed
for the verified account-permission changes.

## Follow-up verification through the actual bridge — 2026-10-19

Codex delegated a verification-only task through `dsh-codex-bridge/dsh-impl.ps1`, with DSH
still in `workspace-write` mode. Phase 3 remained paused. DSH executed one repository-bounded
PowerShell probe; Codex reviewed its tool output and report.

**Conclusion: partial repair confirmed. Shell provisioning is fixed; the normal development
build/test workflow is still blocked.**

| Actual bridge check | Result |
|---|---|
| DSH PowerShell startup, Node and npm versions | PASS |
| Repository-root disposable write/read/remove | PASS |
| Disposable writes in `src`, `tests`, `dist/src`, `.dsh-runs` | FAIL: access denied |
| `npm run check` | PASS, exit 0 |
| `npm run build` | FAIL, exit 2: TS5033 / EPERM writing `dist/` files |
| `npm test` | FAIL, exit 2 during its build step; normal tests never start |
| Direct default-isolation Node test | FAIL, exit 1: `spawn EPERM` |
| All seven compiled test files with isolation disabled | 69 passed / 5 failed; five CLI subprocess tests fail with `spawn EPERM` |

The final two rows are recorded in DSH's full run report. The bridge's NDJSON tool-result preview
is truncated to 8,192 characters, so its preview ends during the earlier build errors.

- Session: `<local-session>`.
- Run report: `.dsh-runs/20261019-113432-report.md`.
- Probe: `.dsh-runs/verify-dsh-sandbox-20261019.ps1`.
- Task contract: `docs/verification/dsh-sandbox-check-2026-10-19.md`.
- Captured tool-result preview: `.dsh-runs/sandbox-verification-20261019-raw-result.txt`.
- Codex verified source/test/package/config hashes remained unchanged and no probe files remained.
- No permission repair or access-mode change was performed during this verification.

DSH can now run typechecking and in-process assertions itself. Codex still needs to execute the
full build/test workflow while these confinement limitations remain. This is not a product regression:
the accepted phase 2 suite passed all 74 tests in Codex's approved execution environment.

## Final targeted repair and acceptance — 2026-10-19

The user explicitly requested repair of the remaining nested writes and Node subprocess workflow,
with DSH's sandbox enabled. Codex repaired permissions and reviewed the work; DSH implemented
the test-harness changes using the saved Flash/Max profile. No phase 3 features were implemented.

### Nested permissions

Inspection of the installed DSH 0.2.1-rc.2 backend and raw security descriptors showed two gaps:
existing project subtrees lacked the workspace capability ACE, and existing descendants lacked
the low-integrity label required by DSH's low-integrity processes. Applying DSH's normal grant to
`.dsh-runs` refreshed its descendant DACLs but left existing descendants unlabeled. An exact-match
grant cache at the workspace root also meant subsequent launches did not repair the stale children.

Codex saved owner, DACL, and mandatory-label descriptors for 186 existing objects before repair.
The repair was bounded to `src`, `tests`, `dist`, `docs`, `dsh-codex-bridge`, and `.dsh-runs`:

1. Temporarily granted the signed-in owner inheritable WRITE_OWNER on those six directories so
   labels could be provisioned. This was not granted to the restricted workspace capability.
2. Used the installed DSH `AclWriteGrant` API with the existing workspace SID to apply its standard
   write grant and protective directory-delete deny. No sandbox token or installed code was patched.
3. Applied low-integrity labels to the existing objects explicitly, including existing build files.
   The final traversal covered 189 objects; three new local diagnostic files appeared after the snapshot.
4. Removed all temporary WRITE_OWNER rules in `finally` and independently confirmed their removal.
   Re-read all 186 original descriptors: owners and every original deny ACE were preserved.

No existing permissions were reset wholesale. No project content was changed by the permission
script. `.git`, dependency trees, and paths outside the six named subtrees were not permission-repair
targets. DSH's normal private-temp provisioning remained enabled. Subsequent independent and bridge
runs succeeded, including overwriting all 12 compiled outputs.

### Node subprocess compatibility

DSH replaced only the CLI test helper's named-pipe capture with writable file descriptors in a unique
private-temp directory. The five CLI assertions still launch the real CLI and check its real exit
status/stdout/stderr. The helper retains a ten-second timeout and cleans its own handles/files,
retrying cleanup after a timed-out child closes; removal errors are best-effort. No helper temp
directories remained in the observed successful run.

`npm run test:sandbox` builds and runs the same seven test files with
`--experimental-test-isolation=none`. No test names, assertions, reviewer tests, or product source
were changed. `npm test` retains ordinary worker isolation for compatible hosts. The underlying
Node named-pipe restriction remains; this is a project workflow repair, not a generic backend IPC fix.
The restriction is documented in the
[official DSH Windows sandbox README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md).

### Reviewed evidence

| Check | Final result |
|---|---|
| DSH bridge permission mode | `workspace-write` throughout |
| Create/overwrite/read/delete probes in nine repository locations | PASS |
| Outside sentinel append from confined PowerShell | DENIED; sentinel unchanged |
| Real Node child write in private temp | PASS |
| Same Node child's outside sentinel append | DENIED; sentinel unchanged |
| DSH `npm run check` | PASS, exit 0 |
| DSH `npm run build` | PASS, exit 0 |
| DSH `npm run test:sandbox` | PASS, 74/74, zero failures/skips/cancellations |
| Codex independent DSH-runner build/sandbox suite | PASS, 74/74 |
| Codex ordinary `npm test` with worker isolation | PASS, 74/74 |
| Product/reviewer-test/dependency/config hashes versus pre-repair baseline | Unchanged |

DSH's initial build attempt during the repair failed before Codex applied the permission changes;
its later successful build was not an unexplained transient result. Codex's inspection accepted
the final implementation without further requested rework. Phase 3 stays paused.
Codex also compared both TAP logs: all 74 test names match. The outside fixture's content and
permissions were unchanged; its test file and empty temporary directory were then removed.

- DSH session: `<local-session>`.
- Implementation report: `.dsh-runs/20261019-114346-report.md`.
- Final bridge verification: `.dsh-runs/20261019-115011-report.md`; its tool-result preview contains
  the complete concise probe summary, while full TAP output is retained separately.
- Contract: `docs/verification/dsh-sandbox-fix-2026-10-19.md`.
- Final logs/summary: `.dsh-runs/sandbox-fix/verified-{check,build,tests}.log` and
  `verification-result.json`.
- Independent evidence: `independent-verification.log`, `independent-tests.log`,
  `ordinary-tests.log` in the same directory.

### Permission recovery artifacts

`.dsh-runs/sandbox-fix/acl-before.json` contains the 186 original owner/DACL/label descriptors.
`repair-nested.ps1`, `grant-nested.cjs`, `acl-state.ps1`, and `repair.log` retain the exact operation.
Do not rerun the repair script blindly. For a deliberate rollback, after all DSH processes have
stopped, the saved descriptor helper can reapply the captured DACLs and labels:

```powershell
pwsh -NoProfile -File .dsh-runs/sandbox-fix/acl-state.ps1 -Action Restore
```

It bounds every path to this repository, refuses reparse paths, restores ancestors before children,
and leaves owners unchanged. Windows can recompute inherited ACEs; review resulting descriptors
against the backup. Objects created after the snapshot are not covered. The initial side-conversation
repair backups above are separate and remain intact. No rollback was needed.
