# Portable Windows sandbox setup package

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

Status: implemented and accepted on 2026-10-19; see [verification](../history/bridge-verification-2026-10-19.md).

Engineering specification for this package's Windows support. This document records the design;
it does not grant permission to modify a new repository or override its existing instructions.
For onboarding, start with the package README and obtain authorization appropriate to that repo.

Codex owns this design, README/AGENTS/docs and final review. DSH implements the scripts and
tests below. Package development stays inside `dsh-codex-bridge`; no project or installed DSH edits.

## Deliverables

Make this folder independently copyable into another repository, with no dependency on this
project's docs, `.dsh-runs`, source/tests, drive letter, user SID, saved session, or credentials.
Use PowerShell 7 / Node 22.14+ and the installed Windows DSH desktop runtime; no new dependencies.

Allowed edits: `windows/*`, `node/*`, `tests/*`, `.gitignore`, `dsh-impl.ps1`, and
`mcp/dsh-mcp-server.mjs` only if parameter forwarding requires it. Codex writes all other docs.
The complete repair method lives in `../windows-sandbox.md` and the package's `windows/` sources.
Do not vendor the installed diagnostic tool or patch installed code.

### Windows entry point

Provide `windows/setup.ps1 -Repo <path> -Action Check|Repair|Verify|Restore`.
Default Action Check is read-only (aside from optional local diagnostics), returns nonzero for
unready permissions, and gives the precise Repair command. Repair requires `-Apply` and never
changes the sandbox mode. Restore requires `-Backup <json> -Apply` and is separate from Repair.
Use an explicit optional `-InstallDir` for nondefault desktop installs. Refuse non-Windows clearly.

Use the installed Electron-as-Node runtime, its `app.asar/dsh/node_modules` package, and public
`AclWriteGrant` / `workspaceWriteSid` API. Derive canonical repository paths and SIDs dynamically.
Keep native interop in a small helper. Preserve environment variables and caller cwd on exit.
The known-tested backend is 0.2.1-rc.2; validate the layout/exports and record actual version.
Fail clearly on unsupported layout/API rather than guessing or weakening restrictions.

Repair method, replacing hardcoded proof-of-concept paths:
- Inspect a bounded directory tree (default maximum 10000 objects). Reject drive roots, home,
  temp root, and installed-program roots. Package must be inside the selected dedicated repo.
- Refuse reparse points/junctions (including ancestor aliases), multiply-linked files, foreign-owned
  objects, and protected/custom inheritance requiring separate review. Do not follow links.
  All checks must happen before mutation, not after traversing through a junction.
- Include root and existing descendants in the saved owner/DACL/mandatory-label snapshot.
  Capture only metadata, never file contents. Keep complete backups/reports under this package's
  `.state/` (ignored), not outside the package. Validate restore manifest paths and root before use.
- Keep original owners, original allow/deny entries, and non-label SACL information intact.
  Use DSH's ordinary capability grant and directory-only protective deny. Never apply the
  directory DELETE_CHILD deny to a file. Existing files need capability inheritance and Low labels.
- If WRITE_OWNER is needed to provision labels, add only a temporary current-user permission;
  remove that exact addition in finally, even on failure. Handle pre-existing user FullControl or
  merged ACEs correctly (do not assume there is no existing inheritable user grant).
- Apply the root grant through the DSH API and repair existing directory grants/Low labels as
  needed. Do not reset ACLs wholesale, change owners, erase denies, or grant Everyone broad access.
- Verify resulting labels/capabilities and original owners/deny entries. Repair errors must fail
  closed, preserve backups, attempt bounded rollback and report any incomplete rollback explicitly.
- State honestly that root grant propagation can affect descendant ACLs, including metadata and
  dependency directories; snapshot the entire bounded tree. Never claim excluded trees are untouched.
- A second Repair on a ready tree should make no permission changes. Files created for `.state`
  during repair must not make preflight permanently fail. Exclude only the package's `.state`
  diagnostics from readiness enumeration, explain its scope; snapshot it if root propagation can touch it.

Verify must run actual confined processes using the installed DSH runner in workspace-write mode:
root and existing nested create/overwrite/read/delete; real Node child file-backed capture; the
same child's outside-workspace write must be denied; also PowerShell outside-write denial.
Use your own disposable sentinel in ambient temp outside Repo, check it remains unchanged,
then remove only that fixture. Manage DSH private temp normally, without changing token groups.
The verification can use a small bundled Node test fixture under no worker isolation; never
report project tests passed just because this smoke test passes. Save concise summary + full logs.
Check readiness before Verify; it should not unexpectedly repair missing workspace permissions.

### Node helpers

Provide `node/capture-process.mjs`: real child process with stdout/stderr file descriptors in
unique `os.tmpdir()` directory, ignored stdin, windowsHide, optional cwd/env/timeout, returns
code/signal/stdout/stderr, proper cleanup on success/error/timeout, no swallowed cleanup failures.
No shell interpretation or sandbox escape. Add declarations/example usable from TypeScript.

Provide `node/run-tests.mjs`: accepts explicit test file arguments, invokes the current Node
with `--test --experimental-test-isolation=none`, inherits stdio, forwards exit/signal failures.
No project-specific list of tests or assumption about a project's build. Empty arguments must fail clearly.
Documented npm pattern will build first then call this helper with the same files as ordinary tests.

### Bridge integration

Before a real Windows workspace-write run, call the package's read-only Check preflight and stop
with setup instructions if unready. Do not do this for -DryRun, read-only mode, or non-Windows.
Offer explicit `-SkipWindowsPreflight` only for diagnosing unsupported installations; it must
not alter the DSH permission mode. Keep existing launcher/protocol/report behavior unchanged.
Add a short Windows sandbox note in delegated prompts: use the project's full sandbox-compatible
test command; named-pipe EPERM does not justify turning off confinement or skipping tests.

### Tests and handoff

Write meaningful package tests for file-backed capture outputs/exit, spawn failure, timeout and
cleanup; argument forwarding/empty test list; path boundary/link rejection and backup validation
where practical. PowerShell syntax-check all scripts. Do not run permission repair on the real
project automatically; Codex will test the complete Windows lifecycle on a disposable repo with
the bridge copied inside it. Supply a bounded disposable-fixture acceptance script if helpful.
Run the helper tests through DSH's sandbox (no worker isolation), report actual results.
Leave changes uncommitted. No product development, profile edits, or installed-runtime changes.
