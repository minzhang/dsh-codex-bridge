# DSH Codex Bridge

A Codex skill for collaboration between **Codex** and **DeepSeek Harness (DSH)**.
Codex designs a phase and delegates it; DSH implements and tests; Codex reviews,
requests rework when needed, and verifies the result before accepting it.

The skill in [`dsh-codex-bridge/`](dsh-codex-bridge/README.md) includes delegation,
Windows sandbox setup, execution recovery and report/usage processing.
It needs no build, packaging or npm install.

## Install the skill

Use **Windows**, PowerShell 7, Node.js 22.14+ and an installed DeepSeek Harness.
Configure your own DSH CLI authentication before the first delegation using the
[Windows API key guide](dsh-codex-bridge/README.md#dsh-cli-and-api-key-setup-windows).
Linux and macOS have not been verified; managed execution currently requires Windows.

Ask Codex:

```text
Use $skill-installer to install the skill from
https://github.com/minzhang/dsh-codex-bridge/tree/main/dsh-codex-bridge
```

## Use the skill in a project

Open the target project in Codex and ask:

```text
Use $dsh-codex-bridge for this project. Use DeepSeek Flash with Max effort and
sandbox enabled. Delegate implementation and testing to DSH, review and rework,
then report acceptance and pause after each phase.
```

Codex follows [SKILL.md](dsh-codex-bridge/SKILL.md) to prepare the project's runtime,
check Windows sandbox readiness, write a design, delegate work, and verify the result.
Project setup and recovery evidence stay in the target repository; the shared skill
installation remains reusable. Existing project files and recovery evidence are preserved.

The skill invokes `dsh headless` with workspace-write confinement and normal preflight.
Defaults are **Flash / Max**, **180 minutes per execution**, and `codexReviewEdits: Not Allow`.
Related work normally resumes the same DSH session; Codex records a reason for retaining or
changing it. After interruption, Codex can inspect, scan, stop or recover a specific run.

Each invocation writes local, ignored artifacts including a canonical `<run>-result.json`.
It separates execution outcome, the implementer's claim, report validity and pending
acceptance. Token usage lives in execution metadata. A completed model response or zero
exit alone is never acceptance.

For configuration and operational details used by Codex, see the
[skill guide](dsh-codex-bridge/README.md),
[Windows setup guide](dsh-codex-bridge/docs/windows-sandbox.md), and
[execution recovery guide](dsh-codex-bridge/docs/run-recovery.md).

## Repository layout

| Directory | Role |
|---|---|
| [`dsh-codex-bridge/`](dsh-codex-bridge/README.md) | Installable Codex skill, bundled runtime and operational setup probes |
| [`development/`](development/README.md) | Bridge regression tests, designs and review records |
| [`demos/pascal-desk/`](demos/pascal-desk/README.md) | First verification project: a TypeScript Turbo Pascal inspired terminal editor |

The skill has no dependency on the other two directories. Maintainer tests and
historical development records are outside it. Future verification projects belong under `demos/`.

## What has been verified

| Environment / project | Status |
|---|---|
| Windows, DSH desktop 0.2.1-rc.2, PowerShell 7, Node 22.14.0 | Verified locally: project setup, confinement, delegation, review/rework and recovery |
| DeepSeek Flash, Max effort, workspace-write sandbox | Default bridge configuration; used for implementation and complete sandbox test runs |
| Codex post-review edits `Not Allow` | Default configuration; fixes and test additions stay with DSH, resuming the same session by default |
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

This repository is maintained directly by Codex using the user's selected model, including
implementation and fixes. Its own development is not delegated to DSH; the delivered
Codex/DSH workflow is intended for projects adopting the bridge.

These commands are for maintainers working on the bridge and demo:

```powershell
npm ci --ignore-scripts
npm --prefix demos/pascal-desk ci --ignore-scripts
npm test
npm run test:windows
npm run test:demo
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the review workflow.

## License

[MIT](LICENSE), including the bridge, maintainer tools and demo. The installable skill contains
its own license. This is an independent integration project; Codex and DeepSeek Harness are
separate products with their own terms and licenses.
