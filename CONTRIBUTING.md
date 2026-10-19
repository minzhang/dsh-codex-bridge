# Contributing

The copyable `dsh-codex-bridge/` folder is the product. Keep its operational scripts and
instructions self-contained; put regression tests in `development/`.
Add future example projects under `demos/` with their own README, dependencies and tests.

## Local checks

Use PowerShell 7 and Node.js 22.14+ on Windows for the currently verified environment:

```powershell
npm ci --ignore-scripts
npm --prefix demos/pascal-desk ci --ignore-scripts
npm test
npm run test:windows
npm --prefix demos/pascal-desk run check
npm run test:demo
```

See [development/README.md](development/README.md) for the declaration check, sandbox commands
and host-only copied-folder lifecycle verification. The delivery folder is copied directly;
there is no build or packaging step for bridge users.

## Changes and review

Open a focused issue or pull request describing the problem, final behavior and checks actually
run. For Codex/DSH work, follow [AGENTS.md](AGENTS.md): Codex writes the design; DSH implements,
tests and reworks; Codex reviews and reruns acceptance checks. Keep failures and platform limits
visible. Never weaken assertions or disable confinement to make a run pass.

When adding a delivery file, keep it self-contained and verify it from a copied folder.
Keep normal and sandbox suites equivalent. Do not commit run transcripts, credentials, local
profiles, `.state/` recovery data, dependencies or build output. Report setup failures with
sanitized summaries; inspect logs for secrets and personal paths before sharing them.

Linux/macOS and web/backend/native UI workflows need independent verification before claiming
support. Changes that introduce platform-specific behavior should include an appropriate demo
or focused fixture and reproducible acceptance evidence. Existing Windows results do not establish
support for another backend or application type.

Contributions are made under this repository's [MIT license](LICENSE).
