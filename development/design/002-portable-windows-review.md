# Portable setup review corrections

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

Status: completed and accepted on 2026-10-19; see [verification](../history/bridge-verification-2026-10-19.md).
The requests below are the historical review record, not outstanding onboarding work.

This is bridge-tooling rework only. Do not start a product development phase.
Keep the existing API and all assertions. Codex owns reviewer tests and docs.

The copied-repository happy path now passes Check→Repair→Check→Verify→no-op Repair→Restore,
including exact restoration of original descriptors. Earlier compile, signed-mask, CI/OI,
Repair -Apply and root-relative-path problems were corrected during the first round.

## Remaining required corrections

1. **Canonical temporary ACE ordering.** `AddWriteOwnerAce` inserts an Allow at index zero,
   ahead of explicit Denies. Insert it after explicit Denies and before inherited entries,
   preserving canonical order and never defeating an existing deny. Test against a directory
   that already has DSH's explicit protective deny. Restore/remove only the added exact ACE.
2. **Protect the .state output boundary.** `New-SetupContext` currently checks `.state` only
   lexically, while readiness skips that subtree. `New-StateDirectories` can follow a `.state`
   junction before the later snapshot rejects it. Validate state root/ancestors and output
   directories for reparses before any write, including no-op Repair and Restore report paths.
   Rejection must happen before creating directories/files in a redirected target.
3. **Restore/rollback current-tree validation.** Before any root DACL propagation, scan the
   entire current tree including .state. Reject newly added junctions, hard links, unsupported
   owners/ACLs. Recorded files need current hard-link checks too. An object can acquire an
   outside hard-link alias after backup. Never apply an old manifest blindly to that changed tree.
   Validate before mutation and report incomplete/refused recovery honestly if unsafe.
4. **Restore verification.** Verify mandatory labels and restored explicit DACL state, not
   just that original ACEs remain a subset. Residual added capability/temporary rights or Low
   labels must not be reported as a complete rollback. Account explicitly for legitimate
   inherited ACE recomputation. Keep owner and non-label SACL preservation.
5. **Explicit test filenames.** `node/run-tests.mjs` treats an existing filename such as
   `--test-name-pattern=never.test.mjs` as a Node flag and currently returns success with zero
   tests. Resolve paths to absolute files or use an option terminator. Pass the unchanged
   `tests/reviewer-node.test.mjs` assertions.
6. **TypeScript declarations.** Rename `capture-process.d.ts` to `capture-process.d.mts`
   alongside `.mjs`, and ensure its declarations match the actual exports. A strict NodeNext
   consumer previously got TS7016; `.d.mts` now exists, so remove the obsolete duplicate `.d.ts`.
   Declare the exported error classes' actual constructor arguments and optional properties too.
   Codex will run the TypeScript compiler again.
7. Record `mutations.tempWriteOwnerRemoved` accurately after cleanup. Mirror the installed
   launcher's `--expose-internals` flag for Electron helper/runner calls for compatibility.
8. Keep only one host lifecycle acceptance script: retain Codex's stricter
   `tests/reviewer-lifecycle.ps1` (do not weaken it); remove the duplicate
   `tests/acceptance-disposable.ps1`, which currently mixes report strings into its returned
   result and writes persistent evidence outside the package.

For capture-process timeout handling, ensure a child ignoring SIGTERM cannot keep the caller
alive indefinitely on non-Windows. Use forced termination where appropriate and describe child
versus child-tree guarantees accurately; do not suppress cleanup/termination failures.

## Checks and scope

Modify only the implementation files/tests required for these corrections inside the package.
Do not change reviewer assertions, README, AGENTS, docs, product files, installed DSH or profile.
Add focused regressions for the permission-boundary corrections; no live repairs on the real repo.
The host-only lifecycle is run by Codex, not from a confined DSH child.
The reviewer lifecycle now also injects a new hard-link alias and a new junction after backup,
requires Restore to refuse both without changing any original descriptor, removes those aliases,
then requires the ordinary Restore to pass. Do not run this host-only script from DSH.

Run once after fixes, correcting actual failures:

```powershell
node --test --experimental-test-isolation=none tests/capture-process.test.mjs tests/run-tests.test.mjs tests/reviewer-node.test.mjs
pwsh -NoProfile -File tests/setup-syntax.test.ps1
pwsh -NoProfile -File tests/setup-boundaries.test.ps1
pwsh -NoProfile -File tests/reviewer-acl.ps1
```

Run from the bridge folder; also run any new focused boundary test you add. Do not repeatedly
probe known host-only operations from inside DSH or rerun the historical repair scripts.
Report actual results and remaining host checks, then stop for Codex review.
