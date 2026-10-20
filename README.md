# DSH Codex Bridge

A copyable bridge for collaboration between **Codex** and **DeepSeek Harness (DSH)**.
Codex designs a phase and delegates it; DSH implements and tests; Codex reviews, requests
rework when needed, and independently verifies the result before accepting it.

The primary product is the **[`dsh-codex-bridge/`](dsh-codex-bridge/README.md) delivery folder**.
It includes delegation, agent instructions, Windows sandbox readiness/repair/verification,
and Node subprocess helpers. Copy it into another project to use the workflow.
No build, packaging or npm install is needed for the bridge itself.

## Use the bridge

Choose either route. Both use the same `dsh-codex-bridge/` files and require your own DSH setup.

### Option 1: copy the folder

1. Copy `dsh-codex-bridge/` into your project's root. Omit any locally generated `.state/`.
   A clean Git clone contains no machine-specific state or credentials.
2. Install PowerShell 7, Node.js 22.14+ and DeepSeek Harness. Configure your own DSH
   authentication using the [onboarding guide](dsh-codex-bridge/README.md). The bridge selects
   DeepSeek Flash, Max effort, and the Codex review policy per run from `bridge.config.json`.
3. Give Codex this instruction:

   > Read `dsh-codex-bridge/README.md` and `dsh-codex-bridge/AGENTS.md`. Set up the bridge for
   > this repository with DSH's workspace-write sandbox enabled. Use DeepSeek Flash with Max
   > effort. Design one phase, delegate implementation and testing to DSH, review and rework,
   > independently verify acceptance, report the result, and pause before the next phase.

On Windows, begin with the bundled readiness check and follow the
[setup guide](dsh-codex-bridge/docs/windows-sandbox.md) if repair is needed:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Check
```

Windows permission checks default to a limit of **28,000 objects**, including files and
folders. For larger trees, supply a higher value such as `-MaxObjects 50000` to setup and
to `dsh-impl.ps1` so its automatic preflight uses the same limit. See the setup guide for
Check, Repair, Verify and Restore examples.

Once setup is verified and Codex has written a design:

```powershell
pwsh -NoProfile -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-example.md
```

The normal bridge invocation includes Windows preflight. Repair is explicit and saves recovery
information. DSH stays confined to workspace-write. Run reports are local, ignored artifacts;
a successful model response alone is never acceptance.

The shipped `bridge.config.json` defaults to `reasoningEffort: "max"` and
`codexReviewEdits: "Not Allow"`. The bridge applies the selected model/effort to that invocation
through a temporary `--patch` overlay instead of editing DSH profiles. `Not Allow` means Codex
reviews and runs checks but delegates production fixes and test additions to the same DSH
session; `Allow` permits only small, recorded review fixes and focused regression cases. See the
[delivery guide](dsh-codex-bridge/README.md) for resolution order and overrides.

### Option 2: install as a Codex skill from GitHub

Ask Codex:

```text
Use $skill-installer to install the skill from
https://github.com/minzhang/dsh-codex-bridge/tree/main/dsh-codex-bridge
```

After installation, invoke it in your project:

```text
Use $dsh-codex-bridge for this project. Use DeepSeek Flash with Max effort and
sandbox enabled. Delegate implementation and testing to DSH, review and rework,
then report acceptance and pause after each phase.
```

The [skill entry point](dsh-codex-bridge/SKILL.md) teaches the same workflow. It reuses the project's
existing bridge or copies its bundled folder into the project root when absent. Setup and recovery
data stay in that project; the installed skill remains reusable. No installer script, build or
packaging pipeline is required in this repository. The original copy-folder route remains available
without installing a skill. A folder placed only in the project root is loaded by asking Codex to
read its `SKILL.md`; it is not automatically registered as an installed `$dsh-codex-bridge` skill.

## Repository layout

| Directory | Role |
|---|---|
| [`dsh-codex-bridge/`](dsh-codex-bridge/README.md) | Delivery: everything a new project needs to run the bridge, including operational setup probes |
| [`development/`](development/README.md) | Bridge regression tests, designs and review records |
| [`demos/pascal-desk/`](demos/pascal-desk/README.md) | First verification project: a TypeScript Turbo Pascal inspired terminal editor |

The delivery folder has no dependency on the other two directories. Maintainer tests and
historical development records are outside it. Future verification projects belong under `demos/`.

## What has been verified

| Environment / project | Status |
|---|---|
| Windows, DSH desktop 0.2.1-rc.2, PowerShell 7, Node 22.14.0 | Verified locally: copied-folder setup, confinement, delegation, review/rework and recovery |
| DeepSeek Flash, Max effort, workspace-write sandbox | Default bridge configuration; used for implementation and complete sandbox test runs |
| Codex post-review edits `Not Allow` | Default configuration; fixes and test additions stay with the same DSH session |
| TypeScript terminal application (Pascal Desk) | Verified: build, typecheck, 148 tests and interactive Windows use |
| Linux and macOS | **Not yet verified**; Windows ACL repair does not apply there |
| Web, backend and native UI applications | **Not yet verified** |
| Other DSH versions and unusual filesystem layouts | Require their own validation |

Verification is performed locally. See the
[publication review](development/reviews.md) for exact commands and results, and the
[development guide](development/README.md) for future validation work.

## Try the demo

From the repository root:

```powershell
npm --prefix demos/pascal-desk ci --ignore-scripts
npm run demo
```

Pascal Desk edits and saves text with a retro terminal interface. It has no Pascal compiler or
debugger. Press **F1** for help and **Ctrl+Q** to quit.

## Develop and verify locally

These commands are for maintainers working on the bridge and demo:

```powershell
npm ci --ignore-scripts
npm --prefix demos/pascal-desk ci --ignore-scripts
npm test
npm run test:windows
npm run test:demo
```

Distribute `dsh-codex-bridge/` directly from a clean checkout. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the review workflow.

## License

[MIT](LICENSE), including the bridge, maintainer tools and demo. The copyable bridge contains
its own license. This is an independent integration project; Codex and DeepSeek Harness are
separate products with their own terms and licenses.
