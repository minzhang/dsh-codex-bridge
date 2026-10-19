# 003 — Public repository and delivery packaging

Status: approved by Codex for the user's requested publication, 2026-10-19.

## Goal and scope

Make the copyable bridge the primary product, with maintainer assets and demo projects separate.
Preserve all accepted behavior. No new platform support or Pascal Desk features. Codex has moved
source files mechanically and saved the original under ignored `.dsh-runs/publication-baseline/`.

Canonical layout:
- `dsh-codex-bridge/`: self-contained operational delivery, no development regression suite/history.
- `development/`: bridge tests, packaging, designs and sanitized acceptance history.
- `demos/pascal-desk/`: unchanged editor source and all 148 tests.

## Ownership / allowed changes

DSH may edit the files explicitly described below, root package.json/package-lock.json,
`.github/workflows/ci.yml`, and write its logs to `.dsh-runs/publication-checks/`.
Codex concurrently owns all README/AGENTS/LICENSE files, CONTRIBUTING.md, .gitignore,
.gitattributes, design/history/review documents. Do not edit those files.
Do not change Git configuration, commit, push, read credentials or change DSH profiles.

## Implementation

1. Adapt all relocated bridge tests in `development/tests/` to canonical delivery paths.
   Preserve every assertion and original test. Include delivery scripts and development test/scripts
   in syntax checks. Lifecycle tests must copy only delivery (omit .state) into their own fresh
   fixture under a unique host-temp directory, outside the project; store the evidence index under `development/.state/`. Preserve the existing
   `dsh-codex-bridge/.state/` recovery evidence. Fixture permission work never targets this repo.
   TypeScript consumer imports must resolve the canonical helper.
2. Rename the operational self-check `dsh-codex-bridge/windows/verify/confined.test.mjs` to
   `windows/lib/verify-node.mjs`; update setup-lib.ps1's reference. Preserve its assertions and
   its relative import depth/real confined behavior. This is a runtime setup probe, and stays in
   delivery. No other sandbox behavior changes.
3. Create a root dependency-free private ESM package `dsh-codex-bridge-workspace` version 0.1.0,
   MIT, Node >=22.14, with lockfile. `test` runs every development Node test normally;
   `test:sandbox` runs the same explicit files without worker isolation. `test:windows` runs
   syntax, boundary and reviewer ACL checks. `test:demo` and `test:demo:sandbox` delegate the
   corresponding npm scripts with --prefix demos/pascal-desk. `demo` delegates that demo.
   `package` invokes `development/scripts/package.mjs`. Add MIT metadata to the demo manifest
   and lock only. Do not change dependency versions or demo implementation/test assertions.
4. Add `development/delivery-files.json` and `development/scripts/package.mjs` using only Node
   built-ins. The explicit allowlist contains kit LICENSE, README, AGENTS, .gitignore, bridge,
   MCP script, Node helpers, Windows scripts including renamed probe, docs/windows-sandbox.md,
   docs/node-testing.md and docs/design/TEMPLATE.md. Codex supplies LICENSE and moves the old
   VERIFY-NEW-REPO.md out of delivery. No maintainer docs/tests or machine state in the export.
   Export exact source bytes to `.artifacts/dsh-codex-bridge/` plus `.artifacts/SHA256SUMS.txt`.
   Fail for missing/unexpected source files (except ignored .state), symlinks/reparse points,
   or output redirection outside .artifacts, before destructive effects. No recursive deletion:
   create a fresh stage under .artifacts and refuse existing final output. No CLI options needed.
   Functions may accept fixture roots for tests; CLI roots must be fixed to this repository.
5. Add meaningful packaging regression tests: exact allowlist and hashes, LICENSE and operational
   probe present, local state excluded; missing, unexpected and link fixtures rejected without
   output overwrite. Keep fixture cleanup bounded to the test's own directory.
6. Add `.github/workflows/ci.yml`: Windows only, Node 22, checkout@v4/setup-node@v4,
   upload-artifact@v4. Install root/demo locked deps; run ordinary bridge tests, Windows checks,
   demo typecheck/tests, TypeScript declaration consumer check, clean package export and upload.
   No DSH installation/authentication/secrets required in CI. Actual DSH integration remains a
   separate host check. Do not imply Linux/macOS or other project-type validation.

## Acceptance

Run root lock generation with npm install --package-lock-only --ignore-scripts, then run:
- npm run test:sandbox
- npm run test:windows
- npm --prefix demos/pascal-desk run check
- npm --prefix demos/pascal-desk run build
- npm run test:demo:sandbox (all 148 tests, no skips)
- Compile development/tests/types-consumer.mts with the demo's tsc, strict NodeNext, ES2022,
  --types node and --typeRoots demos/pascal-desk/node_modules/@types.
- npm run package, after Codex documentation/license is present, once only; do not overwrite
  existing .artifacts output. If Codex is still editing, report packaging pending rather than race.

Save full command logs and immediate exit codes under `.dsh-runs/publication-checks/`; summaries
must distinguish checks actually run and pending checks. Codex is installing demo dependencies
and will run independent ordinary suites, inspect diffs and verify a copied kit's Windows lifecycle.
Host-only lifecycle checks are not required inside DSH. Do not repair root permissions to solve a
new blocker. Report the exact failure instead. Keep Flash/Max, sandbox and preflight enabled.

Return STATUS: DONE/PARTIAL/BLOCKED, changed files, commands/counts, remaining limitations.
Leave changes uncommitted for Codex review.

## Codex review correction 1 — ordinary-runner isolation and CI delivery

Independent ordinary `npm test` exposed four failures (full log:
`.dsh-runs/publication-host/bridge-test.log`). Keep the ordinary command worker-isolated and all
assertions; do not switch it to the sandbox runner or suppress failures.

- `capture-process.test.mjs` compares all dsh-capture-* entries in shared os.tmpdir(). Other test
  workers legitimately create captures there. Isolate this suite's own temporary directory under
  the original os.tmpdir() (therefore under DSH private temp when confined). Scope environment
  changes and restore them reliably, including in no-worker mode; keep every cleanup assertion.
  A scoped describe group/fixtures is allowed. Do not weaken cleanup checks or change production
  captureProcess behavior to accommodate the tests.
- `run-tests.test.mjs` launches standalone runner subprocesses with inherited NODE_TEST_CONTEXT.
  Under ordinary workers this produces Node's binary reporter protocol instead of standalone TAP.
  Pass a copied child environment with NODE_TEST_CONTEXT removed, like reviewer-node.test.mjs
  already does. Preserve real subprocesses, exit assertions, marker assertions and output checks.
- `.github/workflows/ci.yml` uploads files from hidden `.artifacts/`, including the necessary kit
  `.gitignore`. Add `include-hidden-files: true` to the upload-artifact step, restricted to the
  existing exact export/checksums paths. The allowlist already excludes all sensitive local state.
  Reference: https://github.com/actions/upload-artifact#uploading-hidden-files .

These test-fixture corrections are approved in the two named test files in addition to the original
path-only changes. Additive tests are allowed if needed; no assertions may be removed or weakened.
Rerun the complete sandbox bridge suite and Windows checks and log exact results. Codex will rerun
ordinary bridge tests after rework, then publish only after acceptance. No delivery runtime change
or new demo feature is needed. Do not rerun packaging into an existing export or delete it.

## Codex review correction 2 — lifecycle fixture location

After both successful lifecycle runs restored Medium labels, retaining their copied repositories
inside development/.state caused normal workspace preflight to fail on 136 fixture objects.
The preflight correctly detected those labels; do not alter it, skip it, or repair this repository.

Update development/tests/reviewer-lifecycle.ps1 so the actual disposable reviewRoot/copy/alias
fixtures and full permission recovery evidence live in a unique host system-temp directory
(`dsh-bridge-lifecycle-<guid>`). Validate that canonical path is under that temp root and outside
repoRoot before creating or mutating anything. Preserve every lifecycle assertion. A small
JSON evidence pointer under development/.state should record the external reviewRoot/result and
scenario so developers can find retained recovery logs on both success and failure. Do not copy
or move live Medium-labelled fixture trees back into the project. No automatic destructive cleanup
or privilege escalation is needed. This remains a host-only test repairing its own disposable repo.

Codex archives the two already-passed old fixtures, verifies archive contents, then removes only
those completed fixture directories to restore ordinary preflight readiness. Original bridge
.state recovery evidence is untouched. Codex will rerun both corrected lifecycle cases and check
that main-repository preflight remains READY afterward. DSH does not run host lifecycle tests.
Fixture detail for correction 2: host inspection confirms this machine's system-temp parent grants
inheritable current-user FullControl. Merely removing the explicit fixture grant leaves inherited
WRITE_OWNER, so the temporary-right scenario would fail its existing assertion. In that scenario,
prepare ONLY the fresh disposable outer reviewRoot container before capturing baseline: protect its DACL while
converting inherited entries, replace the current-user allow grants with inheritable Modify
(without WRITE_OWNER), retain other principals/denies/owner and the Medium label, then retain the
existing assertion that WRITE_OWNER is absent. Remove the explicit FullControl grant from the copied repo; its DACL remains unprotected and inherits Modify from that container. FullControl scenario remains unchanged. Never alter
the temp parent or the project. Baseline capture and exact restoration follow this intentional
fixture preparation. A bounded fresh-fixture setup is within this test's allowed scope.


Codex implemented the final outer-container permission preparation in the reviewer-owned lifecycle
test as an independent acceptance-fixture correction. DSH implemented the exporter, runner-test
rework and external lifecycle layout. No delivery permission algorithm was changed.
