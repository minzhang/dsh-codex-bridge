# Verify the copied bridge

> Historical record: paths and test totals below describe the original development layout.
> Use the current repository READMEs for commands. Raw logs and machine-specific recovery
> artifacts remain local and are not distributed.

This is a verification-only task after the host has completed Windows Check, Repair (if needed),
and Verify. Read the package README. Keep workspace-write confinement enabled and use the existing
model profile. Do not change code, permissions, profile configuration, or Git history.

From the repository root, run:

```powershell
node dsh-codex-bridge/node/run-tests.mjs dsh-codex-bridge/tests/capture-process.test.mjs dsh-codex-bridge/tests/run-tests.test.mjs dsh-codex-bridge/tests/reviewer-node.test.mjs
```

Save the full output and exact exit code under `dsh-codex-bridge/.state/first-use/`.
Report actual pass/fail/skip totals and exit status, then stop. Do not repeatedly probe a known
failure, alter assertions, run the host-only permission lifecycle, or start project development.
If blocked, report the exact command/error and evidence path.

These are package tests, not the new project's build or product tests. Codex must separately
specify and verify the complete project acceptance commands before accepting development work.
