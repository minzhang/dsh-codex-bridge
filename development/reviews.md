# Repository publication review — 2026-10-19

> Dated acceptance records follow. Current installation and use are skill-only under
> [design 010](design/010-skill-only-usage.md). Past test results for retired distribution
> paths are preserved as evidence, not onboarding instructions.

**Acceptance: ACCEPTED after implementation, rework and independent review.**

At this acceptance point, the primary product was the self-contained `dsh-codex-bridge/` runtime.
Maintainer tests and sanitized records are under `development/`; the accepted Pascal Desk editor
is under `demos/pascal-desk/`.
Root and standalone bridge licenses are MIT. Linux/macOS and web/backend/native UI workflows
remain explicitly unverified.

## Publication scope at that time

No build, npm install or packaging step was required for the bridge itself.
The owner's clarification removed CI and export tooling from
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
links. There is no CI or generated delivery artifact. Current installation follows the skill README.

## Codex skill entry point introduced — 2026-10-19

Added `dsh-codex-bridge/SKILL.md` and `agents/openai.yaml` to the same runtime. Skill installation
was initially an additional entry point; [design 010](design/010-skill-only-usage.md) later made
it the sole user entry. There is one canonical set of runtime files. The skill reuses an existing
project bridge or prepares its bundled runtime there, omitting local state; setup and delegation run from that
project-local copy. It preserves user model/effort choices, sandbox preflight, DSH implementation
and testing, Codex independent review/rework, and requested phase pauses.

This is an instruction/documentation change; no bridge, Windows setup, Node helper, or demo code
changed. Codex used the skill-creator validator and inspected all relative skill references.
Temporary fixtures checked both direct copying and copying from an installed-skill layout,
including hidden files, MIT license, identical file contents, absence of `.state/`, paths with
spaces, explicit target repository selection, and project-local dry-run output. These checks did
not launch a live DSH session or apply permissions. A fresh Codex session's skill selection and
live delegation have not been independently exercised for this entry point.

Local acceptance: skill validation passed; both route dry runs passed; all 12 ordinary bridge
tests, Windows syntax/boundary/ACL checks, demo typecheck/build and all 148 ordinary demo tests
passed with no failures or skips. Evidence stays ignored under `.dsh-runs/skill-checks/`.

## Default configuration and folder object count — 2026-10-19

**Acceptance: ACCEPTED after implementation, same-session rework and independent review.**

The unlimited object-count default accepted here was subsequently superseded by the
user's 28,000-object default request in [design 005](design/005-object-count-default.md).
The following records the checks of the earlier implementation.

The delivery folder now includes `bridge.config.json` with `reasoningEffort: "max"` and
`codexReviewEdits: "Not Allow"`. `-Config`, `-ReasoningEffort` and `-CodexReviewEdits`
resolve each value independently using explicit parameter, configuration file, then built-in
default. Supported effort values are off/low/high/max. Invalid configuration fails before
preflight or model launch. Missing implicit configuration retains max/Not Allow; an explicitly
missing file fails. MCP exposes the same optional settings without injecting defaults over the
project's choices.

Every invocation writes a unique ignored YAML overlay and passes it through DSH's real
`--patch` interface. It selects `deepseek-official/deepseek-flash` and the resolved effort,
including when resuming a session. The prompt, dry run and normal report identify the effective
configuration. The bridge does not edit global profiles or authentication. Portable instructions
make Not Allow the default for Codex's post-review production/test edits; Allow permits only
recorded local review fixes and focused tests. This instruction does not change sandbox powers.

Windows setup now defaults to `-MaxObjects 0`, meaning no object-count cap. Check, Repair,
Verify, Restore and ordinary bridge preflight retain their full scans and path/link/owner/ACL
checks. Explicit positive limits remain available; negative values fail before mutation.
Backups and restore-manifest validation retain their previous schema and integrity checks.

DSH implemented the change and review corrections using Flash/Max, workspace-write confinement
and normal Windows preflight. Rework reused the original session through the modified bridge;
the live run succeeded with the generated max overlay and the implicit Not Allow configuration.
Codex reviewed the diff and independently ran the ordinary acceptance checks. Review corrected
the introductory role wording, added independent and combined parameter coverage and omitted-MCP
argument coverage, and put the MCP test's temporary files under its verified suite fixture with
one cleanup owner. All original 12 bridge tests and 148 demo tests remain; existing test files,
the demo implementation and its assertions were not changed.

| Acceptance check | Result |
|---|---|
| Complete bridge Node suite | Final 28 tests passed with no failures or skips in both DSH no-worker and Codex ordinary suites, including the restored combined-parameter case |
| Windows syntax, boundaries and ACL regressions | Passed in DSH and independently on the host |
| Large-tree and restore-manifest regression | 10,001 real files enumerated and loaded; finite-limit and pre-mutation negative-limit checks passed |
| Demo typecheck/build and complete tests | Passed; 148 tests, no failures or skips, DSH sandbox and Codex ordinary host suites |
| TypeScript NodeNext helper consumer | Passed in DSH and independently |
| Copied kit with existing FullControl | Passed real confinement, no-op repair, alias refusal and exact rollback of 59 original descriptors |
| Copied kit requiring temporary WRITE_OWNER | Passed the same checks and exact rollback of 59 original descriptors |
| Skill validation and both delivery routes | Validator passed; direct-folder and installed-skill layout dry runs preserved complete project-local copies and omitted recovery state |
| Live configured session resume | Passed with normal Windows readiness preflight, Flash/max, Not Allow and workspace-write |

Both lifecycle tests used their own unique host-temp copied repositories. Their tested Windows
runtime files match the final source; neither test repaired this repository. Recovery evidence
remains at its original location with ignored indexes under `development/.state/`.

The initial Codex-restricted demo run had nine file-save failures caused by host-sandbox EPERM;
the complete ordinary host rerun passed all 148 tests without code or assertion changes. The
skill validator reused its already available ignored Python dependency directory; no project
dependency was added. Linux/macOS, other DSH versions and other project types remain unverified.

Complete local logs and exit codes remain ignored under `.dsh-runs/config-checks/` and
`.dsh-runs/config-review/`; live reports and per-run overlays are under
`.dsh-runs/config-implementation/`, `.dsh-runs/config-rework/` and
`.dsh-runs/config-coverage-rework/`. No credentials, raw transcripts or machine-specific recovery
data are part of the tracked change.

## Default 28,000-object limit and parameter guidance — 2026-10-20

**Acceptance: ACCEPTED after same-session DSH implementation/rework and independent review.**

The user's follow-up replaces the unlimited default with **28000** in Windows setup,
New-SetupContext and the bridge's automatic preflight. Explicit positive values such as
`-MaxObjects 50000` raise the cap; `0` retains its explicit unlimited meaning. All four setup
actions use the selected limit. Documentation and limit-exceeded errors explain how to
raise it and account for folders, metadata and repair headroom. The bridge forwards its
selected limit to normal preflight, and MCP exposes optional validated `max_objects`,
including explicit zero. Omission leaves the bridge default in control. The accepted
Flash/max and Not Allow defaults from design 004 remain intact.

DSH used Flash/max, workspace-write confinement and normal Windows preflight, resuming the
same session. Review restored explicit-zero enumeration and manifest loading on the real
28001-object fixture, preserving exact/every-file counts and the existing small-fixture,
finite-limit and negative-before-mutation checks. No existing demo or original bridge
regression assertions were removed. Ordinary and sandbox test-file lists remain identical.

Codex made a documentation-only formatting correction: a blank line after #Requires lets
PowerShell recognize each script's comment help. Host Get-Help now shows default 28000 and
override guidance for setup.ps1 and dsh-impl.ps1. Parser-token comparison confirmed the
executable code was unchanged. Codex did not edit production logic or test assertions.

| Acceptance check | Result |
|---|---|
| Complete bridge Node suites | 30 passed, no failures or skips, DSH sandbox and Codex ordinary |
| Complete Windows suites | Final suites passed independently in DSH and on the host |
| Real tree and restore-manifest boundaries | 28000 accepted by default; 28001 rejected by default with parameter guidance; 28001 accepted with 50000 and with explicit 0 |
| Parameter handling | Default/50000/0 preflight forwarding, MCP schema/omission/exact forwarding and invalid-before-launch rejection passed |
| Demo typecheck/build and full suites | 148 passed, no failures or skips, DSH sandbox and Codex ordinary |
| TypeScript NodeNext helper consumer | Passed in both environments |
| Both copied-kit Windows lifecycle scenarios | Real confinement, no-op repair, unsafe-link refusal and exact rollback passed; only unique host-temp fixtures were repaired |
| Both delivery routes | Complete direct-folder and installed-skill copies and project-local dry runs passed |
| Publication review | Local Markdown links, intended-file scope, sensitive-pattern scan and diff whitespace checks passed |

The lifecycle-tested Windows implementation is unchanged except for the help-block spacing
described above. Original recovery evidence stays local, with ignored indexes under
development/.state/. The initial DSH targeted count check was interrupted while its output
was buffered; it is not treated as a pass. The resumed complete final Windows suite finished
successfully, as did Codex's final suite with the added large-zero assertions.

Full check logs and exit codes are ignored under .dsh-runs/count-28000-checks/final/ and
.dsh-runs/count-28000-review/. Live run evidence remains under
.dsh-runs/count-28000-implementation/ and .dsh-runs/count-28000-rework/. No raw transcripts,
credentials, temporary fixtures or machine-specific backups are included in publication.
Linux/macOS, other DSH versions and other project types remain unverified.

## Windows DSH CLI and API key onboarding — 2026-10-20

**Acceptance: ACCEPTED for documentation only.**

The root README, delivery README and skill entry now explicitly identify the DSH command-line
interface and `dsh headless` invocation. The delivery guide explains the verified Windows
user-level `%USERPROFILE%\.dsh\.env` file, the `DEEPSEEK_API_KEY` entry, preserving existing
settings, saving the exact filename, and starting a new run after editing it. It also covers
an existing DSH_HOME override and inherited API-key environment variables. Windows paths and
commands are explicitly scoped to Windows; they are not Linux/macOS onboarding instructions.

Codex verified the installed DSH 0.2.1-rc.2 launcher's CLI entry point, home-path resolution,
layered environment loading and provider variable name by reading installed runtime code.
No credential file was read, created or edited, and no live authentication request was made.
Examples contain only a placeholder key and symbolic user paths.

Skill validation passed, all 26 local links/section anchors in the three edited guides resolved,
and both direct-folder and installed-skill layout dry runs passed. Diff whitespace checks passed.
Runtime and regression tests are unchanged from accepted commit 715eaed; its complete bridge,
Windows and demo results above remain the code baseline. This documentation update did not
repeat permission repair or model calls. Route-check evidence remains ignored under
.dsh-runs/skill-checks/.

## Reliable one-way reports — 2026-10-20

**Acceptance: ACCEPTED after DSH implementation, same-session rework and independent review.**

[Design 006](design/006-reliable-one-way-reports.md) keeps one non-interactive delegation
followed by one report. The delivery folder now writes a canonical schemaVersion 1 result
JSON and derives the readable report and terminal summary from it. MCP returns the same
validated object as structuredContent. Process outcome, implementer claims, report validity
and independent acceptance are separate: a zero-exit missing/invalid report returns bridge
exit 65, valid BLOCKED/PARTIAL outcomes remain normal results, and acceptance stays PENDING
until independent review is recorded separately.

Designs can declare check IDs, exact commands and working directories. Reports must account
for every declared check, including unrun/blocked checks with reasons. The bridge annotates
check claims and log availability without executing report-supplied commands or treating log
existence as proof of success. Dirty-file fingerprints and index/status observations distinguish
paths modified again during a run from pre-existing changes that remain unchanged; they make
no claim of causal attribution to DSH. Missing/malformed output and capture/inventory problems
remain visible with preserved local artifacts.

Independent review reproduced three defects in the first implementation: command normalization
could accept different arguments, an inventory could hash a file through a parent junction,
and supplied capture errors could leave a zero-exit result VALID. Same-session DSH rework now
trims only command boundaries, inspects link/reparse ancestors before content reads (including
clean-path follow-ups), and invalidates captured-error results while preserving the original
process exit. Four independent host probes pass after these corrections. The MCP junction
fixture now asserts actual creation/refusal at a fresh path and avoids recursive removal there.
No original assertion was removed, and ordinary/sandbox test-file lists remain identical.

DSH used Flash/max, Not Allow, workspace-write confinement and normal Windows preflight for
both rounds. Codex wrote the design, independent probes and acceptance record; production
implementation and corrections stayed with DSH. No dependencies, demo features, Windows
permission algorithms, authentication/profile settings, CI or packaging were added.

| Acceptance check | Actual result |
|---|---|
| Complete bridge sandbox suite | `npm run test:sandbox`: 50 passed, zero failed/skipped |
| Independent ordinary bridge suite | `npm test`: 50 passed, zero failed/skipped; 26 runtime/test/configuration hashes unchanged during the suite and still matching after DSH returned |
| Complete Windows suites | `npm run test:windows` passed in DSH and independently on the host, including real 28000/28001 enumeration/manifest boundaries and ACL regressions |
| Final syntax scans | Passed in both environments; 10 PowerShell and 11 Node files parsed |
| Demo typecheck and build | `npm --prefix demos/pascal-desk run check` and `run build` passed in both environments |
| Complete demo suites | `npm run test:demo:sandbox` and independent `npm run test:demo`: 148 passed each, zero failed/skipped |
| TypeScript consumer | The documented strict NodeNext consumer command passed in both environments |
| Independent report probes | Command slash/backslash exactness, parent-junction hash refusal and capture-error invalidation all passed |
| Copied-kit Windows lifecycle | Both ordinary and temporary-WRITE_OWNER scenarios passed repair, real confinement, repeat repair, alias refusal and exact rollback in unique host-temp fixtures |
| Both delivery routes | Direct-folder and installed-skill layout copies retained complete files, valid skill references and project-local dry-run behavior |
| Actual new-bridge session resume | SUCCEEDED / DONE / VALID / PENDING, COMPLETE coverage of six declared checks, no malformed events or capture errors; four pre-existing paths changed and ten remained unchanged |

The report-only rework did not change Windows implementation/tests, demo source/tests or the
capture-process type interface. Their completed behavioral results were retained, while the
complete bridge suites and syntax scans were rerun on the final source. An exploratory ordinary
worker-suite attempt inside DSH hit the documented spawn EPERM restriction; it is not counted
as acceptance. DSH's complete no-worker suite and Codex's ordinary host suite both passed
without changing confinement or dropping assertions.

Full logs, exit records, independent probes and source hashes stay ignored under
`.dsh-runs/report-review/`, `.dsh-runs/report-checks/` and `.dsh-runs/report-rework-checks/`.
The bootstrap and actual new-bridge runs are under `.dsh-runs/report-implementation/` and
`.dsh-runs/report-rework/`. Delivery-route evidence stays under `.dsh-runs/skill-checks/`.
Lifecycle recovery evidence stays in its original host-temp fixtures with ignored pointers
under `development/.state/`. No raw transcripts, credentials, personal paths, dependencies,
build products or recovery backups are included in publication. Linux/macOS, other DSH
versions and other project types remain unverified.

## Runtime token usage — 2026-10-20

**Accepted.** [Design 007](design/007-run-token-usage.md) places machine-observed token usage
in the canonical result's `execution.usage`, outside the implementer's business `task`.
Markdown execution information, terminal output and MCP present the same data. The bridge
collects only this invocation's `step_end` usage; it never asks the model to estimate counts
or reads private session history. Reusing a session creates another RUN-scoped result,
not an alleged lifetime session total.

Input total now includes uncached input, cache reads and cache writes. Cache miss includes
uncached input plus writes; reasoning, when reported, is a subset of output. Totals sum
across model calls, including repeated/cached context. Missing/invalid counts remain unknown,
and partial capture or failure produces explicit completeness information without changing
task/report acceptance or existing exit rules. Schema version 1 remains compatible with
older results; deprecated `observations.tokens` retains its raw-input/output meaning.

Independent review reproduced invalid-total derivation, contradictory partial/overflow
totals, inadequate subset validation and a malformed-object diagnostic crash. DSH fixed
these in the original session, added maintained regressions, and made MCP always summarize
the validated artifact even when captured stdout resembles a token summary. Real finalization
tests cover failure, timeout, capture errors, malformed events, missing completion and
telemetry-only warnings. A final fixture-only correction bounds recursive cleanup to the
resolved unique host-temp directory.

| Check | Actual result |
|---|---|
| DSH affected no-worker suites | `node dsh-codex-bridge/node/run-tests.mjs development/tests/bridge-usage.test.mjs development/tests/bridge-report.test.mjs`: 39 passed, zero failed/skipped |
| DSH final fixture-only follow-up | The same runner with only `development/tests/bridge-usage.test.mjs`: 18 passed, zero failed/skipped; unchanged report-component results retained |
| Codex independent ordinary suites | `node --test development/tests/bridge-usage.test.mjs development/tests/bridge-report.test.mjs`: 39 passed, zero failed/skipped |
| Tested-source stability | Eight runtime/configuration/test SHA-256 hashes unchanged throughout independent testing |
| Independent boundary probes | Six reproduced edge cases pass after correction |
| Generated-metadata consistency | 2,160 paired field combinations pass the public result-usage validator |
| Real run reconciliation | Each of three invocations (87, 55 and 6 steps) matches its own captured usage fields, totals and rate; same-session resumes do not accumulate earlier runs |
| Syntax and whitespace | Helper syntax check and `git diff --check` pass |
| Repository constraints | Existing report assertions retained; ordinary/sandbox file lists identical; no dependency changes or personal workspace paths in additions |

The user's explicit request limited this change to affected tests. Full bridge, Windows ACL,
demo/build and lifecycle suites were not run or claimed as fresh evidence. This review
covers the current Windows backend and configured DSH version; it adds no platform claims.
DSH retained Flash/max, workspace-write and normal preflight, and left changes uncommitted
for Codex review and publication.

Detailed logs, raw events, result/report artifacts, probes and tested hashes remain ignored
under `.dsh-runs/usage-implementation/`, `.dsh-runs/usage-checks/`,
`.dsh-runs/usage-rework/`, `.dsh-runs/usage-rework-checks/`,
`.dsh-runs/usage-fixture/`, `.dsh-runs/usage-fixture-checks/` and
`.dsh-runs/usage-review/`. They are not part of the delivered folder or Git publication.

## Lightweight session selection guidance — 2026-10-20

**Accepted.** The user approved a short reminder in the
[skill](../dsh-codex-bridge/SKILL.md#choose-a-dsh-session): default to resuming related work,
let Codex choose a new session when appropriate, and record the choice with a brief reason
before each delegation. Passing `-Session` resumes; omitting it starts a new session.
The existing design or delegation notes hold that reason. No separate handoff mechanism,
session ledger, fixed switching thresholds or additional approval step was added.
Current agent instructions and READMEs now refer to this default instead of requiring
same-session rework unconditionally.

Codex checked the skill with `quick_validate.py` using the existing ignored local Python
dependencies: passed. All 30 local links and anchors in the five edited instruction/guide
files resolve, and `git diff --check` passes. Editorial review covered first delegation,
same-task rework and a task that warrants a new session; each can express its choice and
reason using the existing interface. This is documentation validation, not a fresh live
session test. Runtime code and tests are unchanged; no full bridge, Windows or demo suite
was run, consistent with the user's affected-checks-only request.

## Execution ownership and interruption recovery — 2026-10-21

**Accepted.** [Design 008](design/008-worktree-workflow-deferred.md) archives the deferred
worktree discussion; no worktree functionality was added. [Design 009](design/009-run-lifecycle-recovery.md)
implements lifecycle management for the current local delegation path. The default execution
timeout increases from 90 to 180 minutes and remains overridable.

The user clarified that this repository must be maintained directly by their selected Codex
model. Codex stopped the initial DSH delegation before any production edits, retained its local
evidence, and performed implementation, review and verification directly thereafter. Root
maintenance instructions now distinguish this policy from the delivered downstream Codex/DSH
workflow. No additional DSH model run, credentials change, dependency, CI or packaging was used.

Each invocation now acquires repository-wide ownership independently of output directory and
session, and atomically records preparation, execution, finalization and completion. Windows
jobs contain the child at process creation, covering ordinary descendants and preparation/report
helpers. PID plus creation time is used for observation; stale heartbeat alone never proves
death. The former process-name/time-wide cleanup was removed. Normal preflight and DSH
workspace-write configuration remain unchanged.

The new `dsh-run.ps1` provides read-only Status/Scan and explicit Stop/Recover with a run ID
and reason. Recovery refuses live or uncertain writers, preserves code and raw evidence,
reconstructs missing results where facts permit, preserves existing results, and cannot release
a newer owner's record. Unknown interrupted execution becomes FAILED with null original exit,
bridge exit 1 and pending acceptance; usage remains incomplete when capture is incomplete.
Session events distinguish actual observation from requested fallback. Recovery never relaunches
DSH, chooses a session, resets Git or introduces a handoff-document requirement.

Review and failure-driven corrections:

- The initial eight lifecycle scenarios passed, but cleanup exposed a surviving report helper.
  Report/inventory/manifest and preflight helpers now use owned jobs too. The maintained regression
  kills a bridge during finalization and verifies the actual helper PID exits.
- A legacy configuration fixture returned a fixed session ID despite requesting another session.
  The new consistency check correctly rejected it. The fake launcher now echoes the supplied ID;
  all existing forwarding assertions remain intact, with a separate mismatch-rejection regression.
- Recovery interrupted after saving RECOVERED but before removing its active pointer can now
  finish that same release on retry, preserving recovery/result bytes. A later owner remains protected.
- Custom output cannot enter the reserved control tree. Junction escapes and hard-linked ownership
  are refused without altering external sentinels.

| Check | Actual result |
|---|---|
| Ordinary bridge suite, `npm test` | 80 tests executed: 79 passed initially; the one fixture session mismatch above failed. After correcting only the fake response, its unchanged forwarding assertions passed in a focused rerun. |
| Complete no-worker bridge suite, `npm run test:sandbox` | 80 passed, zero failed/skipped. Run directly by Codex. |
| New lifecycle coverage | 11 maintained scenarios passed in both modes: real child trees, concurrent ownership, heartbeat, resume/mismatch/failure, timeout, stop, interruption, recovery, PID reuse/uncertainty, malformed state and path boundaries. |
| Final focused corrections | Recovery/reuse cases: 2 passed in each mode. Reserved-directory/link case: 1 passed in each mode. Existing full-suite results retained for unaffected behavior. |
| Windows suite, `npm run test:windows` | Passed syntax, path/state/link boundaries, 28,000/28,001-object limits and ACL regressions. |
| Real installed Windows sandbox under the new job | Existing copied-folder repair/confinement/repeat-repair/alias-refusal/exact-rollback checks passed for both ordinary and temporary-WRITE_OWNER fixtures, with no live descendants. No model session involved. |
| Demo typecheck and ordinary tests | `npm --prefix demos/pascal-desk run check` passed; `npm run test:demo` built and passed 148 tests, zero failed/skipped. |
| Demo no-worker tests | `npm run test:demo:sandbox` built and passed 148 tests, zero failed/skipped. |
| Type consumer | Strict NodeNext declaration-consumer check passed. |
| Delivery and skill | Both direct-folder and installed-skill copies remained self-contained and passed DryRun; skill validator passed; 47 local links/anchors resolved. |
| Source and manifests | Ordinary/no-worker lists contain the same seven files; no assertions removed; final syntax/whitespace checks passed; no dependency changes. |

The complete checks follow the current repository instructions; the earlier affected-only
exception was recorded for design 007. After the full runs, only checks affected by the final
two corrections were repeated. Detailed logs and final source hashes remain ignored under
`.dsh-runs/lifecycle-*`. Native containment probe source is
`.dsh-runs/lifecycle-contained-setup.ps1`; actual ACL recovery evidence stays in its original
unique host-temp directories, indexed by `development/.state/lifecycle-*.json`. These local
files, raw transcripts, personal paths, credentials and build products are not published.

Verification covers the current Windows host and installed sandbox backend. Managed execution
now explicitly requires Windows; Linux/macOS, other project types, worktrees and a fresh
live-model run are not claimed as verified. Windows containment covers ordinary descendant
processes; external-service-launched processes are outside that guarantee. Read-only scanning
covers this version's control records, not historical runs without them. No automatic restart,
background monitoring or bidirectional messaging was added.

## Skill-only installation and use — 2026-10-21

**Accepted.** [Design 010](design/010-skill-only-usage.md) makes GitHub skill installation and
`$dsh-codex-bridge` invocation the sole documented user entry. Both READMEs, the skill,
agent/contributor/development instructions and Windows/recovery guides now follow that flow.
Manual folder-distribution directions, the downloaded-ZIP unblocking walkthrough and requirements
to preserve two user entries were removed. Older records retain actual test facts with explicit
supersession notices; obsolete onboarding directions were removed.

The installed skill still prepares a project-local runtime as an internal Codex step.
Windows permission operations and recovery evidence require that project boundary.
An existing complete runtime is reused, incomplete contents are inspected, and existing project
files and evidence are preserved. Shared skill installation is never a repair target.

Audit found no production parameter or runtime branch exclusive to manual distribution.
Repo/launcher/configuration overrides, DryRun, MCP forwarding, sandbox setup, token/report
processing and execution recovery all serve skill operation. Maintained fixture copies test
real isolation, confinement and rollback, so their assertions remain intact. The obsolete
direct-folder branch of the ignored local onboarding checker was removed; only the
installed-skill branch remains. No new test suite or dependency was added.

| Check | Actual result |
|---|---|
| Installed-skill project preparation | Passed with a disposable project path containing spaces: complete file hashes, hidden metadata/license, omitted state, explicit target and local DryRun prompt/output. No live DSH session or permission repair. |
| Skill validator | `quick_validate.py` passed using existing ignored Python dependencies. |
| Current documentation | All 49 local links/anchors across 12 current guides resolved; no current manual-distribution or optional-skill entry remained. |
| Runtime/regression stability | All 28 hashes from the accepted lifecycle change are unchanged. No maintained runtime assertions or test files changed. |
| Package metadata | JSON parsed; only the description changed. Dependencies, script commands and lockfile remained unchanged. |
| Diff checks | `git diff --check` passed; only documentation and package description are published. |

This is an onboarding/documentation change. The unchanged runtime retains design 009's
complete bridge, Windows and demo evidence; those suites were not repeated or claimed as
fresh runs. Current checks and the retired local branch remain under ignored
`.dsh-runs/skill-only-*` and `.dsh-runs/skill-checks/`. No model delegation, worktree,
authentication/profile change or additional platform claim was introduced.
