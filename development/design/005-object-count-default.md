# Default 28,000-object permission limit and explicit overrides

Status: accepted after DSH implementation, same-session rework and independent Codex
verification, 2026-10-20. Scope was approved by the user's request. This supersedes
only the default-count requirements in design 004; its effort and review-policy work
remains accepted and must be preserved. Publish both pending changes after acceptance.

## Behavior

- Set the default MaxObjects to 28000 in windows/setup.ps1 and New-SetupContext.
  Check, Repair, Verify and Restore must use that default. Keep existing zero-as-unlimited
  compatibility, explicit positive limits, negative-input rejection, and all path/link,
  owner, ACL, backup and rollback checks. Do not skip descendants to meet the cap.
- Make the default and override discoverable in setup comment help, delivery README and
  docs/windows-sandbox.md. Show -MaxObjects 50000 for Check, Repair -Apply, Verify and
  Restore -Backup <manifest> -Apply, explaining that any desired positive integer within
  the existing Int32 range can be supplied and large trees need more time/memory. Object
  count includes folders and metadata, not just files. Use the same chosen limit for all
  stages, with headroom for repair metadata. Zero is an explicit opt-out, not the default.
- Limit-exceeded messages for both tree scans and restore manifests must identify the
  active cap and tell users to retry with -MaxObjects and a larger explicit number, e.g.
  50000. Preserve existing recognizable 'safety limit' wording and error semantics.
- The bridge's normal Windows preflight must also support larger repositories. Add an
  optional -MaxObjects parameter to dsh-impl.ps1, default 28000, validate nonnegative
  Int32 input before artifacts/preflight/launch, and pass the effective value as a separate
  argument to setup.ps1 -Action Check. Explain it in help and the delivery guide. Do not
  skip preflight, change sandbox mode, or put the value in the model configuration JSON.
  Dry-run output and normal reports should identify the selected preflight object limit.
- Expose matching optional MCP max_objects (integer, 0..2147483647). Reject invalid types,
  fractions, negatives and out-of-range values before spawning. Forward an explicit zero
  as well as positive values. Omission must not inject a flag; the bridge owns the default.
  Keep existing effort/policy and subprocess behavior intact.

## Ownership and scope

DSH owns runtime, help, docs and regression test changes. Allowed files:
windows/setup.ps1, windows/lib/setup-lib.ps1, dsh-impl.ps1, mcp/dsh-mcp-server.mjs,
README.md and docs/windows-sandbox.md under dsh-codex-bridge/; development/README.md;
development/tests/setup-object-count.test.ps1 and bridge-config.test.mjs. Other files
only if essential and explained. Codex owns this design and development/reviews.md.
Preserve all pre-existing uncommitted work, assertions and test coverage. Update assertions
whose specified default is superseded, retaining their other checks; do not delete cases.
No new dependencies, demo features, CI, packaging, profile/authentication changes, commits
or publication by DSH. Resume the same DSH session with Flash/max, Not Allow policy,
workspace-write confinement and normal Windows preflight.

## Acceptance

1. Extend the unique disposable object-count fixture to exercise real enumeration AND
   manifest loading at exactly 28000 objects (success), 28001 (default-cap rejection),
   and 28001 with a larger supplied cap such as 50000 (success). Derive the default from
   the real setup context. Verify setup script's public default too, without repairing
   this repository. Keep the existing more-than-10000/every-file assertions, explicit
   zero/unlimited, small finite-limit and negative-before-mutation checks. No ACL repair
   in this regression; cleanup only the verified fixture root.
2. Real bridge/MCP child tests must verify default preflight forwarding, 50000 and zero
   overrides, rejection before preflight/DSH/artifacts for invalid bridge input, MCP schema,
   optional omission and exact forwarding, and invalid MCP input rejection before spawn.
   Preserve existing configuration/default/override/normal-run checks and file-backed stdio.
3. Run the complete required DSH checks, save complete logs and exit codes in ignored
   .dsh-runs/count-28000-checks/:

   ```powershell
   npm run test:sandbox
   npm run test:windows
   npm --prefix demos/pascal-desk run check
   npm --prefix demos/pascal-desk run build
   npm run test:demo:sandbox
   node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts
   ```

Codex independently reviews the final diff, runs ordinary bridge/Windows/demo suites,
typecheck/build and helper consumer, and the two existing host-only copied-kit lifecycle
checks. Those repair only unique host-temp fixtures and preserve original recovery evidence.
Codex records actual results, confirms only intended portable files are staged, commits and
pushes to the existing GitHub main branch without force, then verifies the remote commit.

## Codex review: preserve large explicit-zero coverage

The initial test revision moved explicit-zero tree/manifest checks to a six-object fixture.
That weakens the previously accepted more-than-10000 unlimited assertions and cannot detect
zero incorrectly falling back to the new 28000 default. Add explicit-zero enumeration and
manifest loading of the existing 28001-object fixture before removing its final file. Assert
the exact count, every-file count, and more-than10000 coverage for both paths. Preserve the
small zero/finite checks and all new boundary cases. No production change is requested.
After this test-only correction, run the full Windows suite and record its actual exit/log;
other complete suites need no repeat if their already-tested code remains unchanged.

## Final acceptance

The large explicit-zero checks were restored without removing the small-fixture coverage.
All 30 bridge tests and 148 demo tests passed in both the DSH sandbox runner and Codex's
ordinary runner. Both complete Windows suites passed with the final count regression,
including exact 28000 success, 28001 default rejection, and 28001 success with 50000 or 0.
Demo typecheck/build, the TypeScript consumer, both host copied-kit lifecycle cases and
both delivery-route dry runs passed. The earlier interrupted targeted count run is not
counted as a pass; the completed final suites supersede it.

Codex also corrected documentation formatting by separating the initial #Requires directive
from each script's help block with a blank line. Host Get-Help now displays the MaxObjects
default and override guidance for setup and the bridge. Parser-token comparison confirmed
that this documentation-only change preserved all executable tokens. No production logic
or test assertions were changed by Codex. See ../reviews.md for the evidence summary.
