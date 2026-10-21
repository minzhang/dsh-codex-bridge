# Skill-only installation and use

Status: implemented and verified by Codex on 2026-10-21; see development/reviews.md.
Owner: Codex, using the user's selected model. Baseline: 476b310.

## Scope

Make installation and invocation as `$dsh-codex-bridge` the only documented user entry.
Remove the manual folder-distribution instructions from both READMEs, agent instructions,
contributor/development guides and other onboarding text. Remove the downloaded-ZIP script
unblocking walkthrough that belonged to that route. Retire its dedicated verification branch.
No installer, dependency, new execution mode, model delegation or sandbox change is requested.

## Shared runtime and project preparation

The installed skill still prepares its runtime inside the target repository. Current Windows
setup requires that location so permission operations and recovery evidence stay with that
repository and never mutate the shared skill installation. Codex reuses an existing complete
project runtime, or initializes it from the installed skill when absent, excluding generated
state. Existing files and recovery evidence must not be overwritten. This is internal skill
preparation, not a second user installation method.

Audit parameters, features and tests by purpose. Repo, Dsh, InstallDir, configuration overrides,
DryRun, preflight, MCP forwarding, report/usage processing and lifecycle management all serve
the skill workflow. Disposable test fixtures use filesystem copies for isolation and sandbox
verification; those assertions do not belong exclusively to manual distribution and remain.
The local two-route onboarding check has one obsolete direct-folder branch; remove that branch
and retain installed-skill preparation and project-local output checks.

## Historical records

Remove obsolete user onboarding directions and superseded requirements to preserve two routes.
Keep dated facts about past tests and implementations accurate, with a visible supersession
notice pointing here where necessary. Historical verification of a removed route is not a
current usage method. Do not rewrite old results to claim they tested a different workflow.

## Acceptance

Validate the skill and its local references. Check every current guide for a single installed
skill entry, and verify the remaining installed-skill preparation path with a disposable target
project, including intact runtime files, omitted state and project-local DryRun output.
Check package metadata and whitespace. Inspect the final diff to confirm there are no dedicated
manual-distribution runtime branches or parameters left and no shared runtime assertion removed.

If runtime and maintained regression sources remain byte-identical to the accepted baseline,
retain design 009's complete bridge/Windows/demo verification and repeat only onboarding,
documentation and metadata checks affected here. Record actual scope and results in reviews.
