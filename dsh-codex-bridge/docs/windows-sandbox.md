# Windows sandbox setup, repair, and recovery

This method addresses DSH's **Windows ACL/restricted-token backend**, tested with desktop
DSH 0.2.1-rc.2. It does not apply to macOS/Linux permission systems. Node's file-backed capture
helper is portable, but the reason for using it here is a Windows backend limitation.

## What failed and why

There are three distinct failure modes:

| Symptom | Cause addressed by this package |
|---|---|
| `SetNamedSecurityInfoW ... grantWrite` / Win32 5 before the shell starts | The owner lacks a permission needed to provision the write grant/integrity label |
| Shell starts, but existing nested files/folders or compiler outputs reject writes | Existing descendants lack the workspace capability grant or Low integrity label |
| Node worker/CLI `spawn EPERM` with piped output | Windows named-pipe access under the restricted token; not a filesystem-permission repair |

The sandbox combines a per-workspace capability SID, a protective directory-delete deny, and
Low integrity labels. Its cached root grant does not prove that every existing descendant is ready.
Applying a label to a parent did not repair every existing child in the observed installation.
The repair therefore inspects existing objects and verifies them individually.

The first two problems need repository permission provisioning. The third needs the project test
adjustment in [Node testing](node-testing.md). Do not remove the sandbox's deny entries, grant
Everyone broad access, add unrestricted token groups, or change DSH to danger-full-access.

## Prerequisites and scope

- Run PowerShell 7 as the ordinary repository owner. Administrator/UAC elevation is not required.
- Keep this package inside the dedicated project repository being prepared.
- Stop agents/build processes that could alter the tree during permission repair or restoration.
- Run setup from the **host**, not from a DSH confined child. That child deliberately cannot
  rewrite Windows permissions. Codex may need approved host execution under its own tool policy;
  this is separate from, and does not disable, DSH's child sandbox.
- The script rejects unsafe roots, external aliases/reparse points, multiply-linked files,
  unexpected owners and unsupported ACL layouts. Resolve or separately review such cases;
  do not widen the root to a drive, home, or installation folder to bypass a refusal.
- The default object limit bounds the scan. Dependency directories, metadata and other existing
  descendants count too. Consult the script's parameters if an intentionally larger bound is needed.
  A pnpm store with hard-linked dependencies may be refused; do not weaken link checks to force it.

Windows applies inheritable root permission changes to descendants. The backup therefore covers
the entire bounded tree, including metadata/dependencies. This is not an operation that can promise
unselected descendants' ACLs remain untouched. File contents, owners, original grants/denies and
non-label audit information must remain intact.

## First-run commands

From the repository root:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Check
```

Check does not change permissions. If it reports missing readiness and the user has authorized
setup/repair for this repository:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Repair -Apply
```

Repair saves a snapshot before modifying permissions. It uses the installed DSH API to derive the
actual workspace SID and provision DSH's standard grants. Existing objects get the required Low
labels. Any current-user provisioning rights added temporarily must be removed afterward, including
on failure. Existing FullControl entries must be preserved. The directory-delete deny must never
be applied to files. A ready tree should produce a no-op repair result.

Then run:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Verify
```

Verify checks readiness first and launches actual restricted processes. It exercises writes inside
the repository, file-backed Node child output, and outside-write denial from PowerShell and a real
Node child. It creates and cleans only its own disposable outside-temp sentinel. Its child sandbox
mode must remain `workspace-write`. Review the summary and saved full logs before accepting setup.

A custom desktop installation can be selected with `-InstallDir '<desktop install directory>'` on
setup commands. The helper checks the expected executable/ASAR/package API and records its version.
It never downloads or patches DSH. If bridge automatic discovery cannot find that same installation,
perform setup/verification explicitly and use `-Dsh '<launcher>' -SkipWindowsPreflight` for that
diagnosed case. The opt-out skips only preflight; it does not disable DSH confinement.

## Project acceptance after setup

1. Integrate a complete sandbox-compatible test command where needed.
2. Delegate a verification-only design through the bridge. Have DSH run the actual project
   typecheck, build and full test suite, saving full logs with exit codes and test totals.
3. Codex reviews those logs and independently reruns appropriate acceptance checks.

The setup smoke test is deliberately small and project-independent. It cannot prove that a new
project builds, that its entire suite ran, or that arbitrary IPC/network operations are supported.
Do not replace a failing project test with the smoke test.

## Evidence and recovery

Setup artifacts live under this package's ignored `.state/`. Preserve the reported backup and
logs at the original repository. Do not distribute them as part of a fresh package copy; they
contain machine-specific paths and descriptors and apply only to their original tree.

For an intentional rollback, stop active DSH/build processes, use the exact backup printed by the
repair, and run:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Restore `
  -Backup '<absolute path to the saved backup JSON>' -Apply
```

Restore validates the saved root and each path before mutation. Owners are not changed. Windows
may recompute inherited entries; inspect the restore verification, not just the process exit text.
Objects created after the snapshot are outside its coverage. Failed repair/rollback must preserve
evidence and clearly report unfinished recovery; do not repeatedly retry a failing repair.

The Low label and workspace grants stand after DSH exits, as required by this backend. Low labels
also affect other Low-integrity processes that otherwise have access to the same files. Keep the
scope to the intended repository and retain the recovery snapshot.

## Platform distinction

These ACLs, mandatory-integrity labels, restricted SIDs and this named-pipe restriction are Windows
mechanisms. macOS/Linux DSH backends have different constraints and are not tested by this Windows
repair. The bridge skips Windows preflight there; a different platform's access error needs its own
diagnosis rather than this repair.

Primary reference: [DSH Windows backend documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md).
