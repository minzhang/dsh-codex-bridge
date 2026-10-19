# Repository publication review — 2026-10-19

**Acceptance: ACCEPTED after implementation, rework and independent review.**

The primary product is the copyable `dsh-codex-bridge/` folder. Maintainer tests and sanitized
records are under `development/`; the accepted Pascal Desk editor is under `demos/pascal-desk/`.
Root and standalone bridge licenses are MIT. Linux/macOS and web/backend/native UI workflows
remain explicitly unverified.

## Final delivery decision

Users copy `dsh-codex-bridge/` into a project's root. No build, npm install or packaging step is
required for the bridge itself. The owner's clarification removed CI and export tooling from
scope. The workflow, exporter, allowlist and seven exporter-specific tests were removed together;
all 12 original bridge Node tests and all 148 demo tests remain. Verification stays local.

## Implementation and review

Codex organized the repository, wrote documentation and the publication design, and independently
reviewed and tested the result. DSH adapted relocated test integration and completed corrective
rework in the same session. Both DSH runs used DeepSeek Flash/Max with workspace-write confinement
and normal readiness preflight. Codex performed the final mechanical removal of unwanted tooling.

Review found and corrected:

- Ordinary test workers shared temporary capture directories; the capture suite now scopes its
  own temp directory and verifies environment restoration. All cleanup assertions remain.
- Standalone runner subprocesses inherited NODE_TEST_CONTEXT; test child environments now remove
  it while preserving real execution, marker, output and exit-code assertions.
- Windows argument-validation tests now use a bounded synthetic install without requiring DSH
  credentials. Actual lifecycle checks still use the configured installation.
- Retained lifecycle fixtures restored to Medium integrity correctly failed the containing
  project's next preflight. DSH moved live fixture trees to unique host-temp directories, with
  evidence pointers under `development/.state/`. Codex archived completed old fixtures, verified
  every archived file, and removed only those old disposable directories.
- Codex corrected the reviewer-owned temporary-WRITE_OWNER fixture setup: its unique outer
  container supplies an inheritable Modify grant, while the copied repository retains an
  unprotected DACL. This exercises temporary provisioning even when system temp inherits
  FullControl. All permission, confinement and exact-restoration assertions remain intact.

No delivery permission algorithm changed. The operational Node probe moved into `windows/lib/`
without changing its bytes, and its setup reference was updated. The other nine runtime files
match the accepted baseline. All 21 Pascal Desk source/test files remain byte-for-byte unchanged
in the local relocation; Git applies the repository's LF text normalization.

## Acceptance evidence

Verified locally on Windows with DSH desktop 0.2.1-rc.2, PowerShell 7 and Node 22.14.0.

| Check | DSH sandbox | Independent Codex |
|---|---|---|
| Retained bridge suite | All 12 passed within the earlier 19-test run | Final 12-test rerun passed, 0 failures/skips, ordinary worker isolation |
| PowerShell/Node syntax, boundary and ACL checks | Passed | Passed again after removing CI/export tooling |
| Demo typecheck and build | Passed | Passed |
| Complete Pascal Desk suite | 148 passed, 0 failures/skips | 148 passed with ordinary worker isolation |
| TypeScript NodeNext helper consumer | Passed | Passed |
| Concurrent capture / inherited test-context regressions | Passed supplementary checks | Covered by ordinary suite and code review |
| Copied kit with existing FullControl | Host-only check | Passed real confinement, no-op repair, unsafe-alias refusal and exact rollback |
| Copied kit requiring temporary WRITE_OWNER | Host-only check | Passed the same checks; original assertion confirms permission absent before repair |
| Main repository preflight after lifecycle tests | Normal preflight used for both runs | READY; no repository permission changes |

Both successful final lifecycle cases restored all 55 original security descriptors. PowerShell
and real Node children could write inside their copied repository and were denied outside writes.
Historical failed fixture attempts remain recorded locally; failures were not reported as passes.

Raw reports and check logs remain under ignored `.dsh-runs/publication-checks/`,
`.dsh-runs/publication-rework/` and `.dsh-runs/publication-host/`. Machine-specific setup evidence
and original recovery backups stay local and are not published.

## Publication

The repository is public at [minzhang/dsh-codex-bridge](https://github.com/minzhang/dsh-codex-bridge),
with `main` as its default branch and GitHub recognizing the MIT license. Publication checks cover
unintended local files, credential patterns, personal workspace paths and broken local Markdown
links. There is no CI or generated delivery artifact; the tracked delivery folder is ready to copy.
