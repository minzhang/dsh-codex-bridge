# Bridge development and verification

`../dsh-codex-bridge/` is the canonical runtime implementation and self-contained delivery.
This directory holds its maintainer tests, packaging tools and development records. Do not
create a second runtime copy here. `../demos/pascal-desk/` is the first end-to-end verification
project; future project types belong in separate `demos/` directories.

## Prerequisites

The verified local environment is Windows, PowerShell 7, Node 22.14.0 and DSH desktop
0.2.1-rc.2. Root packaging and tests have no npm dependencies. The demo supplies the pinned
TypeScript development toolchain. From the repository root:

```powershell
npm ci --ignore-scripts
npm --prefix demos/pascal-desk ci --ignore-scripts
```

DSH integration additionally needs your own configured installation/authentication. See the
[delivery onboarding guide](../dsh-codex-bridge/README.md). Credentials and profiles are not
part of the repository or CI.

## Maintainer checks

```powershell
npm test
npm run test:windows
npm --prefix demos/pascal-desk run check
npm run test:demo
node demos/pascal-desk/node_modules/typescript/bin/tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --typeRoots demos/pascal-desk/node_modules/@types development/tests/types-consumer.mts
```

DSH's affected Windows backend blocks Node worker pipes. Run the same suites inside DSH with:

```powershell
npm run test:sandbox
npm run test:demo:sandbox
```

These retain every assertion and actual CLI subprocess. Codex separately runs the ordinary
worker-isolated suites. Passing the lightweight setup probe alone does not establish acceptance.

For full Windows setup/rollback integration, run from the host:

```powershell
pwsh -NoProfile -File development/tests/reviewer-lifecycle.ps1
pwsh -NoProfile -File development/tests/reviewer-lifecycle.ps1 -RequireTemporaryWriteOwner
```

These create fresh copied-folder Git fixtures with spaces in their paths under a unique host-temp
directory, exercise repair and real confinement, check repeat repair and unsafe aliases,
and verify exact restoration. Full recovery evidence stays in that temp fixture; an index under
`development/.state/` points to it. Keeping restored fixture trees outside the project prevents
their deliberately Medium integrity labels from blocking later preflight. They never repair the containing
repository. The temporary-WRITE_OWNER case prepares its own outer temporary container with an
inheritable Modify grant so the copied repository lacks that permission. The test retains the
assertion that WRITE_OWNER is absent before repair, and fails if preparation cannot establish it.

CI runs the ordinary Node suites, Windows non-DSH checks, demo typecheck/tests, declaration consumer
and packaging on Windows. Actual DSH lifecycle checks run separately on a configured host.

## Delivery export

```powershell
npm run package
```

The allowlist in `delivery-files.json` defines the export; `scripts/package.mjs` copies exact bytes
to `.artifacts/dsh-codex-bridge/` and writes `.artifacts/SHA256SUMS.txt`. The exported folder includes
its own MIT license and operational setup probes. Local `.state/`, development/tests/history,
demos and credentials are excluded. Missing/unexpected files and redirected paths cause failure.
An existing export is never overwritten; preserve it if needed before removing generated output.

Tests use disposable fixtures. Real setup evidence and publication logs stay ignored in `.state/`
and `.dsh-runs/`. Keep permission backups where they were created; never distribute a backup to a
new repository or restore it against another tree.

## Design and acceptance records

- [Publication design](design/003-public-repository.md) and [current review](reviews.md).
- Earlier bridge designs in `design/001-*` and `design/002-*` record the original implementation.
- `history/` contains sanitized historical reports. Paths/test counts there describe the layout
  and product stage at the time; follow current READMEs for commands.
- [Pascal Desk records](../demos/pascal-desk/docs/reviews.md) document the demo's phased acceptance.

## Future validation

Linux and macOS need their own DSH backend setup, copied-kit delegation and full-suite evidence.
Web, backend and native UI projects need representative demos and end-to-end review/rework runs.
Until those checks exist, keep them marked unverified. New platform work must preserve Windows
confinement, rollback and current test coverage.
