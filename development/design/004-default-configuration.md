# Default configuration and unrestricted folder object count

Status: accepted after DSH implementation, same-session rework and independent Codex
verification, 2026-10-19. Scope was authorized by the user's three requested changes.

The user's 2026-10-20 follow-up supersedes this document's unlimited default with a
28,000-object default and explicit higher overrides; see [design 005](005-object-count-default.md).
The original implementation and review history below are retained for traceability.
Onboarding now follows the installed skill under [design 010](010-skill-only-usage.md);
past verification of retired distribution paths is historical evidence only.

## Goal

Expose DeepSeek V4.1 Flash effort with MAX as the real runtime default; make Codex's
post-review minor fixes and limited test additions an explicit opt-in defaulting to
`Not Allow`; remove the default 10,000-object permission-handling limit. Preserve
the installed-skill workflow, one runtime, Windows preflight and workspace-write confinement.

## Configuration and interfaces

Ship `dsh-codex-bridge/bridge.config.json` containing:

```json
{
  "reasoningEffort": "max",
  "codexReviewEdits": "Not Allow"
}
```

`dsh-impl.ps1` gains `-Config <path>`, `-ReasoningEffort off|low|high|max`, and
`-CodexReviewEdits 'Not Allow'|'Allow'`. Resolve each setting independently using
explicit parameter > configuration file > built-in default. The implicit configuration
is the file beside the project-local bridge script; absent implicit files retain safe
built-in defaults. Explicit relative Config paths resolve against Repo; an explicit
missing file fails. Parse and validate before preflight/model launch. Reject invalid
JSON, non-object roots, unknown keys, null/non-string setting values and unsupported
values; errors must name the setting without echoing arbitrary file contents. Values
may be case-insensitive but canonical effective values are lower-case effort and
`Not Allow`/`Allow`. Omitted fields retain built-in defaults. Explicit invalid input
must fail even when another source would override it.

Every normal run AND dry run generates an ignored, per-run YAML patch beside its
prompt under OutDir. It sets only the `agent-default-model` entry's provider
`deepseek-official`, model `deepseek-flash`, and resolved reasoningEffort. Invoke
`dsh headless --patch <absolute-overlay-path> --json ... -` using separate argument
elements. Preserve session resume and permission-mode handling. This applies the
selection for this invocation, including rework; do not edit user profiles, credentials,
runtime packages, authentication or settings. Do not invent unsupported headless flags.
Use unique per-run filenames (including when two runs start in the same second) so
overlays/prompts cannot overwrite one another. The dry run shows the resolved settings
and command without launching DSH or preflight. Reports include model, effort, effective
Codex policy and configuration source. Include the policy in the generated prompt.

The MCP tool gains optional `config`, `reasoning_effort` and `codex_review_edits`
arguments with the same enums and maps them to the exact PowerShell parameters.
Validate types/enums for these fields at runtime before spawning the bridge; schema
defaults describe behavior but must not override project settings by injecting values.
All existing MCP behavior remains intact. There is no new dependency or separate runtime.

## Codex review policy

Update portable AGENTS.md, SKILL.md, README and design template to consult the effective
configuration before post-review edits. `Not Allow` is the default: Codex reviews and
runs checks, records findings, and delegates production fixes and test additions to
the same DSH session. `Allow` permits only small, localized fixes tied to a recorded
review finding, and a few focused regression/acceptance cases for that finding; record
what Codex changed and independently run the relevant checks. Feature implementation,
large refactors, dependency changes and broad test-suite work stay with DSH. Never
weaken existing assertions or count the same self-review as independent acceptance.
This is a collaboration instruction, not an OS/security sandbox; it does not grant
publication or unrelated permissions. Existing explicit user instructions take priority.
Neither setting changes DSH's role or grants DSH commit/publication permission.

Keep the supplied file at `Not Allow` and use MAX for implementing this very change.
Codex's maintainer acceptance responsibilities remain governed by root AGENTS.md.

## Permission object count

Change `windows/setup.ps1` and `windows/lib/setup-lib.ps1`: MaxObjects defaults to 0,
meaning no object-count cap, consistently across Check, Repair, Verify, Restore and
the bridge's normal preflight. An explicitly positive MaxObjects remains an optional
user-selected limit for backward compatibility and the existing finite-limit assertions.
Reject negative values. Tree enumeration and restore-manifest validation apply their
count guard only when MaxObjects > 0. No hidden 10,000 cap or replacement high cap.
Keep all canonical-root, containment, reparse/junction/hard-link, owner, DACL/SACL,
backup completeness and exact-restore checks. Scan every descendant as before; do not
skip dependencies or .git as a way to reduce the count. Existing manifest compatibility
must remain intact. Clarify that large scans need proportionate time/memory.

## Permitted files

- Runtime: `dsh-codex-bridge/dsh-impl.ps1`, new `bridge.config.json`,
  `mcp/dsh-mcp-server.mjs`, `windows/setup.ps1`, `windows/lib/setup-lib.ps1`.
- Documentation: root README.md, development/README.md; delivery README.md, AGENTS.md,
  SKILL.md, docs/design/TEMPLATE.md and docs/windows-sandbox.md.
- Tests: new `development/tests/bridge-config.test.mjs`, new
  `development/tests/setup-object-count.test.ps1`; additive cases in existing tests
  only if needed. Root package.json scripts to include the new tests; keep ordinary
  and sandbox Node test lists identical. No dependency or package-lock changes needed.
- Do not edit this design, development/reviews.md, reviewer-lifecycle.ps1, demo code,
  unrelated user files, stored recovery evidence or any global profile/authentication.

## Acceptance

DSH must save complete logs and actual exit codes under ignored `.dsh-runs/config-checks/`.
Run all of these in workspace-write with normal preflight:

```powershell
npm run test:sandbox
npm run test:windows
npm --prefix demos/pascal-desk run check
npm --prefix demos/pascal-desk run build
npm run test:demo:sandbox
node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts
```

Regression tests exercise observable behavior through real PowerShell/Node children,
using file-backed stdio as needed on this Windows backend. A bounded fake DSH executable
may capture argv/environment to verify forwarding without live API calls, but it does
not replace the existing real CLI child checks or later live DSH rework verification.
Cover defaults with missing config, shipped config, partial/explicit config, independent
CLI overrides, all supported effort values, Not Allow/Allow prompt policy, malformed and
invalid config/parameter values, paths with spaces, session and sandbox preservation,
unique artifacts, MCP schema and actual argument forwarding/invalid input rejection.
Do not assert only that source text contains the intended implementation.

Object-count tests must exercise real tree enumeration AND real restore-manifest loading
of more than 10,000 objects with default unlimited behavior; ensure actual returned counts
match and explicit finite-limit rejection still works. Use a unique disposable host-temp
fixture (or DSH's own writable temp inside its sandbox), never repair this repository.
These tests only create/read/remove their own files; do not perform ACL repair in the DSH
sandbox. Keep all existing boundary assertions. Validate every recursive cleanup target
under its unique fixture root. Negative-limit checks must fail before mutation.

Codex independently runs ordinary `npm test`, `npm run test:windows`, demo check/build and
ordinary `npm run test:demo`, the TypeScript consumer, skill validation, and both existing
host-only lifecycle cases from development/README.md. Host lifecycle tests repair only
their unique host-temp copied repositories. Review diffs and complete logs. Resume the
same DSH session using the modified bridge to verify live MAX/Not Allow configuration
delivery and workspace-write preflight. Record acceptance in development/reviews.md.

## Local API evidence

Read-only inspection of installed DSH 0.2.1-rc.2 confirms: the launcher supports repeatable
`--patch` YAML overlays after bundle/profile/home layers; agent-default-model accepts
provider/model/reasoningEffort; the DeepSeek adapter accepts off/low/high/max; its default
catalog names deepseek-flash as DeepSeek-V4.1-Flash. Headless currentSelection is applied
for new and resumed sessions. This is installed-version evidence, not a portability claim.
No public internet lookup, profile edit or credential inspection is needed for implementation.

## Out of scope

No new demo features, CI, packaging/export system, dependency additions, unrelated permission
changes, new platform claims or authentication changes. DSH must leave all changes uncommitted.

## Codex review round 1

Core configuration and count-limit behavior is consistent with the design. Independent
ordinary bridge tests (27), Windows regressions including 10,001 files, demo build/tests
(148), TypeScript consumer, both copied-kit host lifecycle cases, skill validation and
both delivery-route dry runs pass. Complete these focused corrections in this same DSH
session, retaining all existing assertions:

1. Portable AGENTS.md still unconditionally says Codex may write tests and trivial fixes
   in its introductory role description. Make that description explicitly defer production
   and test edits to the review-edit policy below, so the default is unambiguous.
2. The configuration test named "override each config setting independently" overrides
   both fields together. Add cases that override only effort while retaining a nondefault
   Allow policy from the file, and only policy while retaining a nondefault effort from the
   file. Preserve the existing combined-override and case-normalization checks.
3. Add an actual MCP call with only spec (new options omitted); assert no Config,
   ReasoningEffort or CodexReviewEdits flag is sent. The schema currently has no injected
   defaults, but the subprocess test should also verify this observable behavior.
4. The new MCP test helper creates another temp root and recursively deletes it in multiple
   event handlers without the fixture containment check used by the suite. Put its temporary
   files under the already verified unique suite root and let the suite's bounded cleanup
   own their removal (or use an equivalently explicit checked cleanup helper). This also
   avoids the error/close handlers deleting and then reading the same paths twice.

Run the complete sandbox checks again after these corrections, saving distinct rework logs
with exit codes. This resumed run is also live acceptance of the modified bridge: normal
Windows preflight, same DSH session, DeepSeek Flash/max overlay and Not Allow policy must
remain active. No production algorithm change is requested in this review round.

### Final coverage correction

The independent-override test now covers each flag separately, but replaced the initial
combined-override assertions. Restore that combined case additively in the same test:
with a file containing off/Allow, pass both `-ReasoningEffort MAX` and
`-CodexReviewEdits 'not allow'`; assert max/Not Allow, both sources are command line,
the patch contains max, and the prompt contains Not Allow. Retain both single-override
cases and every other assertion. This is a test-only correction; run the complete Node
sandbox suite once afterward and save its log/exit. Previously passing Windows/demo
checks need no repetition because their code and tests are unchanged.

## Final acceptance

All review items are resolved. The final bridge suite passes all 28 tests in both DSH's
confined no-worker runner and Codex's ordinary worker runner, with no skips. Complete
Windows checks, the 10,001-file scan/manifest test, demo typecheck/build and 148 tests,
TypeScript consumer, both host lifecycle cases, skill validation and both delivery-route
dry runs passed. Live rework through the modified bridge resumed the same session with
Flash/max, Not Allow, workspace-write and normal Windows readiness preflight. See
`../reviews.md` for the acceptance record and local evidence locations.
