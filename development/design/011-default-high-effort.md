# High effort by default

Status: implemented and verified by Codex on 2026-10-22; see development/reviews.md.
Owner: Codex, using the user's selected model. Baseline: 8e3a783.

## Scope

Change the default DSH session model effort from Max to High. This supersedes the effort
default in design 004 and older onboarding examples. Keep DeepSeek Flash, workspace-write
confinement, normal Windows preflight, the 28,000-object limit, the 180-minute timeout and
the Not Allow review-edit policy unchanged.

## Resolution and compatibility

Set both the shipped `bridge.config.json` and the PowerShell built-in fallback to `high`.
Retain the independent precedence for each setting: explicit parameter, selected configuration,
then built-in fallback. Missing implicit configuration and omitted effort fields use High.
Explicit `max` remains supported in configuration, CLI and MCP; existing project configurations
are not migrated or overwritten. Every run's model overlay applies the effective effort to
new and resumed sessions. Do not modify the DSH user profile or authentication.

Update current skill instructions, parameter help, MCP descriptions and examples. Preserve
historical Max verification records and distinguish them from controlled High forwarding checks.

## Verification

Keep all existing assertions and supported-value coverage, updating only superseded default
expectations. Check shipped, missing, partial and empty configuration, explicit Max overrides,
the generated overlay, resumed-session child arguments and JSON/Markdown report settings.
Use controlled real PowerShell/Node children; do not launch a DSH model for repository maintenance.

Run the ordinary and no-worker bridge suites, Windows suite, demo typecheck/build and both demo
suites, plus the strict type consumer. Validate the skill and installed-skill project preparation,
current documentation links and the final diff. Record actual results in development/reviews.md
before the already-authorized commit and push. No new platform or live High-model claim follows
from these checks.
