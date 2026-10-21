# Portable bridge acceptance — 2026-10-19

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.
> Current onboarding follows the installed skill under [design 010](../design/010-skill-only-usage.md).

**Accepted by Codex after DSH implementation and corrective review.** This was bridge setup work;
no product development phase was started. The originating project's phase 3 remains paused.

At this acceptance point, reusable code, setup/rollback instructions, Node helpers, tests and onboarding lived in the delivery
folder. No original-project documentation, machine
paths, saved sessions, SIDs, credentials, or old repair scripts are required. Start with
[current skill README](../../dsh-codex-bridge/README.md), [Windows setup](../../dsh-codex-bridge/docs/windows-sandbox.md), and [Node testing](../../dsh-codex-bridge/docs/node-testing.md).

## Verified environment and results

Tested on Windows with DSH's desktop ACL backend **0.2.1-rc.2**, Node **22.14.0**, PowerShell 7,
and the configured Flash model at **Max** effort. DSH stayed in **workspace-write** mode.

| Check | Result |
|---|---|
| DSH package regression suite | 12 passed; no failures, skips or cancellations |
| Codex independent package regression suite | 12 passed; no failures, skips or cancellations |
| PowerShell syntax | All 9 scripts parsed |
| Boundary and reviewer ACL checks | Passed: path/link refusals, safe state outputs, temporary ACE order, restore validation |
| TypeScript NodeNext consumer | Passed, including exported error constructors |
| Copied-folder lifecycle with existing FullControl | Passed repair, confinement, no-op repair, unsafe-alias refusal and exact restoration |
| Copied-folder lifecycle needing temporary WRITE_OWNER | Passed the same checks; temporary rights removed |
| Fresh-repository bridge delegation | Normal preflight READY; actual DSH run passed all 12 package tests |
| Originating repository's bundled repair and Verify | Passed; PowerShell and real Node outside writes denied; sentinels unchanged |
| Originating product through DSH | Typecheck and build passed; all **74** tests passed, zero failures/skips/cancellations |
| Codex independent product check | Typecheck and ordinary 74-test suite passed; all 15 source/test/config hashes unchanged |
| Download markers | Removed from all distributable files; Windows execution policy unchanged |

The two final lifecycle fixtures copied only this package into fresh Git repositories with spaces
in their paths. After backup, the tests added an outside hard-link alias and a new junction: Restore
refused both before changing original permissions. After removing those aliases, original security
descriptors matched exactly. The suite also checked redirected `.state`/report directories before writes.

The current repository needed broader readiness provisioning than the earlier targeted repair.
The bundled script snapshotted **1,322 objects**, repaired **461 integrity labels**, verified original
owners/access entries, and removed its temporary WRITE_OWNER grant. Its root descriptor remained
unchanged. This permission operation covered the bounded repository tree, including dependencies,
Git metadata and local diagnostics; product source contents were not changed.

## Review and evidence

The initial implementation hit its run time limit. Codex withheld acceptance and delegated corrections
in the same DSH session. Rework addressed canonical deny/allow ordering, output-path redirection,
current-tree validation before rollback, exact restored permission/label verification, option-like
test filenames, TypeScript declarations, and timeout termination. Codex independently reviewed the
code and reran acceptance checks. A first-use launch also exposed a download marker on the original
entry script; the reviewed package files were unblocked without changing execution policy.

Machine-specific evidence remains locally under `dsh-codex-bridge/.state/` (excluded from Git):

- `implementation-runs/` and `rework-runs/`: implementation/review delegation records.
- `lifecycle-64c1845bdbb248be8832a86ca877a0d8/`: final FullControl lifecycle.
- `lifecycle-803c4023a17345d0bcc5f2227918b4d6/`: final temporary-WRITE_OWNER lifecycle.
- `lifecycle-358cf4c69c3c4ddf90f9f81ec6fc6cfe/`: copied-repository first-use delegation and complete logs.
- `backups/20261019-124324-3c9e03ee-acl.json`: original repository permission recovery manifest.
- `reports/20261019-124324-3c9e03ee-repair.json` and `reports/20261019-124420-3d98cc4d-verify.json`.
- `current-project-runs/` and `current-project-checks/`: actual DSH typecheck/build/74-test logs and exit codes.
- `node-final.log`, `product-host-verification.log`, and `reviewer-product-baseline.json`: Codex checks.

Retain backups at the original repository; omit them when distributing the kit. Restore only with
the matching repository and the command in [the recovery guide](../../dsh-codex-bridge/docs/windows-sandbox.md#evidence-and-recovery).

These findings concern the Windows backend. macOS/Linux repair is not implemented or validated here.
The Node pipe limitation is handled by complete-suite no-worker execution and real file-backed child
capture; the backend's named-pipe behavior itself was not changed. Future DSH versions or unusual
filesystem layouts require their own verification. No commit or push was made.
