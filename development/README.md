# Bridge development and verification

`../dsh-codex-bridge/` is the installable Codex skill and canonical runtime implementation.
This directory holds its maintainer tests and development records. Do not
create a second runtime copy here. `../demos/pascal-desk/` is the first end-to-end verification
project; future project types belong in separate `demos/` directories.

## Prerequisites

The verified local environment is Windows, PowerShell 7, Node 22.14.0 and DSH desktop
0.2.1-rc.2. Root tests have no npm dependencies. The demo supplies the pinned
TypeScript development toolchain. From the repository root:

```powershell
npm ci --ignore-scripts
npm --prefix demos/pascal-desk ci --ignore-scripts
```

DSH integration additionally needs your own configured installation/authentication. See the
[delivery onboarding guide](../dsh-codex-bridge/README.md). Credentials and profiles are not
part of the repository.

## Maintainer checks

```powershell
npm test
npm run test:windows
npm --prefix demos/pascal-desk run check
npm run test:demo
node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts
```

DSH's affected Windows backend blocks Node worker pipes. Codex also verifies the same
no-worker suites directly; maintaining this repository does not launch a DSH agent:

```powershell
npm run test:sandbox
npm run test:demo:sandbox
```

These retain every assertion and actual CLI subprocess. Codex also runs the ordinary
worker-isolated suites. Passing the lightweight setup probe alone does not establish acceptance.

`bridge-config.test.mjs` runs the bridge and MCP server through real PowerShell/Node children
with file-backed capture, covering configuration defaults and overrides, generated patches,
prompt policy, preflight object-limit forwarding, and subprocess forwarding.
`bridge-report.test.mjs` covers the canonical JSON result, DONE/BLOCKED/PARTIAL validation,
bridge exit semantics for invalid, missing, nonzero, timeout and launch-failure runs, declared
acceptance manifest coverage, check-log availability and traversal/link refusal, real Git
working-tree observations (dirty-again, unchanged dirty, new, deleted, renamed, restored and
staged-only paths), non-Git fallback, and MCP text/`structuredContent` with safe artifact
reading. It also uses disposable fixtures only.
`bridge-lifecycle.test.mjs` uses isolated project runtimes and controlled real child processes
to cover ownership, heartbeat, timeout, interruption, explicit stop/recovery and evidence
preservation. These fixtures do not invoke a DSH model.
`setup-object-count.test.ps1` creates a unique disposable fixture and exercises real tree
enumeration and restore-manifest loading at exactly 28,000 objects, at 28,001 with default-cap
rejection, and at 28,001 with a 50,000 explicit cap, plus explicit zero/unlimited, small finite
limits, and negative-before-mutation behavior. It does not repair the repository or any ACL.

For full Windows setup/rollback integration, run from the host:

```powershell
pwsh -NoProfile -File development/tests/reviewer-lifecycle.ps1
pwsh -NoProfile -File development/tests/reviewer-lifecycle.ps1 -RequireTemporaryWriteOwner
```

These create fresh Git fixtures with project runtimes and spaces in their paths under a unique host-temp
directory, exercise repair and real confinement, check repeat repair and unsafe aliases,
and verify exact restoration. Full recovery evidence stays in that temp fixture; an index under
`development/.state/` points to it. Keeping restored fixture trees outside the project prevents
their deliberately Medium integrity labels from blocking later preflight. They never repair the containing
repository. The temporary-WRITE_OWNER case prepares its own outer temporary container with an
inheritable Modify grant so the fixture repository lacks that permission. The test retains the
assertion that WRITE_OWNER is absent before repair, and fails if preparation cannot establish it.

All checks are run manually. Actual DSH lifecycle checks need a configured Windows host.

## Skill installation and project preparation

Users install the skill from GitHub and invoke `$dsh-codex-bridge` as described in the
[root README](../README.md). Keep `SKILL.md` and `agents/openai.yaml` connected to one canonical
runtime. No build, export or packaging step is required.

Check skill frontmatter and local references when editing it. Verify preparation from an
installed-skill layout into a target project, including complete runtime files and exclusion of
generated `.state/` evidence. Codex reuses an existing complete project runtime and preserves
project files and recovery data. Setup runs there, never against the shared skill installation.
Disposable fixture copies in shared runtime tests remain necessary to verify isolation and
permission rollback; they are not a user installation interface.

Tests use disposable fixtures. Real setup evidence and publication logs stay ignored in `.state/`
and `.dsh-runs/`. Keep permission backups where they were created; never distribute a backup to a
new repository or restore it against another tree.

## Design and acceptance records

- [Publication design](design/003-public-repository.md) and [current review](reviews.md).
- [Configurable defaults](design/004-default-configuration.md) and the superseding
  [28,000-object default and overrides](design/005-object-count-default.md).
- [Reliable one-way reports](design/006-reliable-one-way-reports.md): canonical results,
  declared check coverage, working-tree observations and report validation.
- [Runtime token usage](design/007-run-token-usage.md): per-run execution metadata,
  cache accounting and affected-component verification.
- [Deferred worktree discussion](design/008-worktree-workflow-deferred.md): archived proposal;
  no worktree functionality is currently being implemented.
- [Execution lifecycle and recovery](design/009-run-lifecycle-recovery.md): repository ownership,
  observed run state, bounded termination and explicit interruption recovery.
- [Skill-only usage](design/010-skill-only-usage.md): the current installation and onboarding
  contract, superseding older distribution directions.
- Earlier bridge designs in `design/001-*` and `design/002-*` record the original implementation.
- `history/` contains sanitized historical reports. Paths/test counts there describe the layout
  and product stage at the time; follow current READMEs for commands.
- [Pascal Desk records](../demos/pascal-desk/docs/reviews.md) document the demo's phased acceptance.

## Future validation

Linux and macOS need their own DSH backend setup, skill integration and full-suite evidence.
Web, backend and native UI projects need representative demos and end-to-end review/rework runs.
Until those checks exist, keep them marked unverified. New platform work must preserve Windows
confinement, rollback and current test coverage.
