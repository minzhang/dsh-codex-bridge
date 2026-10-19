# Repository publication review — 2026-10-19

**Local acceptance: ACCEPTED after implementation, rework and independent review.**

The copyable bridge is the primary product under `dsh-codex-bridge/`. Maintainer tests,
packaging and sanitized records are under `development/`. The accepted Pascal Desk editor is
under `demos/pascal-desk/`. Root and standalone bridge licenses are MIT. Linux/macOS and
web/backend/native UI workflows remain explicitly unverified.

## Implementation and review

Codex organized the repository, wrote documentation and the publication design, and performed
independent review. DSH implemented packaging, relocated test integration and Windows CI, then
completed a corrective round in the same session. Both DSH runs used the configured DeepSeek
Flash/Max profile with workspace-write confinement and normal readiness preflight.

Review found and corrected:

- Ordinary test workers shared temporary capture directories; the capture suite now scopes its
  own temp directory and verifies environment restoration. All cleanup assertions remain.
- Standalone runner subprocesses inherited NODE_TEST_CONTEXT; test child environments now remove
  it while preserving real execution, marker, output and exit-code assertions.
- CI needs no installed/authenticated DSH. Its argument-validation test uses a bounded synthetic
  install. Artifact upload includes the allowlisted hidden `.gitignore`.
- Retained lifecycle fixtures restored to Medium integrity correctly failed the containing
  project's next preflight. DSH moved live fixture trees to unique host-temp directories, with
  evidence pointers under `development/.state/`. Codex archived the completed old fixtures,
  verified every archived file, and removed only those old disposable directories.
- Codex corrected the reviewer-owned temporary-WRITE_OWNER fixture setup: its unique outer
  container supplies an inheritable Modify grant, while the copied repository retains an
  unprotected DACL. This exercises temporary provisioning even when system temp inherits
  FullControl. All permission, confinement and exact-restoration assertions remain intact.

No delivery permission algorithm changed. The operational Node probe moved into `windows/lib/`
without changing its bytes, and its setup reference was updated. The other nine runtime files
match the accepted baseline. All 21 Pascal Desk source/test files remain byte-for-byte unchanged
in the local relocation; Git applies the repository's documented LF text normalization.

## Acceptance evidence

Verified locally on Windows with DSH desktop 0.2.1-rc.2, PowerShell 7 and Node 22.14.0.

| Check | DSH sandbox | Independent Codex |
|---|---|---|
| Complete bridge suite | 19 passed, 0 failures/skips | 19 passed with ordinary worker isolation |
| PowerShell/Node syntax, boundary and ACL checks | Passed | Passed |
| Demo typecheck and build | Passed | Passed |
| Complete Pascal Desk suite | 148 passed, 0 failures/skips | 148 passed with ordinary worker isolation |
| TypeScript NodeNext helper consumer | Passed | Passed |
| Concurrent capture / inherited test-context regressions | Passed supplementary checks | Covered by ordinary suite and code review |
| Clean delivery export | 18 files, hashes checked | Exact allowlist, bytes, SHA-256 and MIT license checked |
| Copied kit with existing FullControl | Host-only check | Passed real confinement, no-op repair, unsafe-alias refusal and exact rollback |
| Copied kit requiring temporary WRITE_OWNER | Host-only check | Passed the same checks; original assertion confirms permission absent before repair |
| Main repository preflight after lifecycle tests | Normal preflight used for both runs | READY; no repository permission changes |

Both successful final lifecycle cases restored all 55 original security descriptors. PowerShell
and real Node children could write inside their copied repository and were denied outside writes.
Historical failed fixture attempts remain recorded locally; failures were not reported as passes.

Raw DSH reports and full check logs remain under ignored `.dsh-runs/publication-checks/`,
`.dsh-runs/publication-rework/` and `.dsh-runs/publication-host/`. Machine-specific setup evidence
stays local. The delivery export excludes `.state/`, tests, history, demos, credentials and build
products. The original bridge recovery backups remain in place and are not published.

## Publication checks

The staged snapshot is checked for unintended local files, credential patterns, personal workspace
paths and broken local Markdown links. GitHub's Windows workflow runs the ordinary bridge and demo
suites, syntax/boundary/ACL checks, declaration compilation and packaging without DSH credentials.
The live result is available in [GitHub Actions](https://github.com/minzhang/dsh-codex-bridge/actions).
Public CI and download verification will be recorded after the initial push.
