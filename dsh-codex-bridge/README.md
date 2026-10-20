# Codex → DeepSeek Harness bridge

Copy this **whole folder** into a project repository. It contains the delegation bridge,
agent instructions, Windows sandbox setup/repair, and Node subprocess helpers. Maintainer tests
are kept outside this delivery folder.
It does not depend on the project in which it was developed.

This same folder is also a Codex skill, through [SKILL.md](SKILL.md). Both delivery routes use
the scripts and instructions here; neither requires a build or packaging step.

Codex designs and reviews; DeepSeek Harness (DSH) implements and runs acceptance checks.
Changes stay uncommitted until the user asks otherwise. A completed agent run is not acceptance:
Codex reviews the implementation and independently verifies the result.

## Optional skill installation from GitHub

The direct copy-folder workflow below remains available without skill installation. To install
this folder as a discoverable skill instead, ask Codex:

```text
Use $skill-installer to install the skill from
https://github.com/minzhang/dsh-codex-bridge/tree/main/dsh-codex-bridge
```

Then, in the target project's chat:

```text
Use $dsh-codex-bridge to design and delegate this project's next phase to DSH.
Use Flash with Max effort and sandbox enabled. Review and rework the result,
report acceptance, and pause before the next phase.
```

The skill reads these instructions and reuses an existing `<repo>/dsh-codex-bridge/`, or copies
the complete bundled folder there if absent, omitting `.state/`. It runs setup and delegation from
that project-local copy. It must not run Windows repair from the shared skill installation or
overwrite an existing bridge's recovery data. DSH installation/authentication are still required.

When you only copy this folder to the project root, ask Codex to read `dsh-codex-bridge/SKILL.md`
directly if you want the skill workflow. That location alone does not register the `$` skill name.

## Start here in a new project

Give the next Codex this instruction:

> Read `dsh-codex-bridge/README.md` and `dsh-codex-bridge/AGENTS.md`. Set up this bridge for
> this repository, keeping DSH in workspace-write mode. On Windows, follow the bundled
> Windows setup guide and verify confinement before delegating development. Use Flash with
> Max effort. Design one phase at a time, delegate to DSH, review/rework and report acceptance,
> then pause before starting the next phase.

1. Keep the folder intact at `<repo>/dsh-codex-bridge`. Do not copy just `dsh-impl.ps1` to `tools/`.
   Merge the collaboration rules in this folder's `AGENTS.md` into the project's instructions
   if needed; do not overwrite existing project rules blindly.
2. Install **PowerShell 7**, **Node 22.14+** (for the bundled Node helpers), and DSH. Configure
   the DSH CLI's API key using [DSH CLI and API key setup (Windows)](#dsh-cli-and-api-key-setup-windows)
   below before the first delegation. Never copy credentials into this package.
3. Check `dsh --version` in a new terminal. The default Windows desktop launcher is
   `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`.
   A downloaded ZIP may mark its scripts as Internet files. If Windows PowerShell refuses a
   reviewed package script as unsigned under `RemoteSigned`, review/trust the copied kit first,
   then remove its download markers from the new repository:

   ```powershell
   Get-ChildItem -LiteralPath ./dsh-codex-bridge -Recurse -File -Filter '*.ps1' | Unblock-File
   ```

   This changes only those scripts' download markers, not system execution policy or DSH's
   sandbox. Organization-enforced signing policy may still require an approved signed package.
4. On **Windows**, run the commands below from the project root. Read
   [the Windows setup guide](docs/windows-sandbox.md) before applying the repair.

   ```powershell
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Check
   # If Check reports missing permissions, with authorization to repair this repository:
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Repair -Apply
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Verify

   # For a larger repository, use the same explicit cap at every stage, for example 50000:
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Check -MaxObjects 50000
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Repair -Apply -MaxObjects 50000
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Verify -MaxObjects 50000
   pwsh -NoProfile -File dsh-codex-bridge/windows/setup.ps1 -Repo . -Action Restore `
     -Backup '<absolute path to the saved backup JSON>' -Apply -MaxObjects 50000
   ```

   `-MaxObjects` defaults to 28000 and counts folders and metadata as well as files. Any
   desired positive Int32 can be supplied; use the same value for all stages and allow
   headroom for repair metadata. `-MaxObjects 0` explicitly disables the cap. Larger trees
   need proportionate time and memory. Preflight reports the active limit; if a scan or
   restore manifest exceeds it, retry with `-MaxObjects` and a larger explicit number.

   Check inspects readiness. Repair saves permission backups before applying the bounded fix.
   Verify launches actual confined processes and checks outside-write denial. These are setup
   checks; they do not replace your project's build/tests. Stop and investigate any failed result.
   Do not run the Windows repair on macOS or Linux.
5. Configure a project test command compatible with the Windows sandbox if your tests spawn
   Node workers or capture child output through pipes. See [Node testing](docs/node-testing.md).
   Run the **complete** project build/test suite through DSH before accepting development work.
6. Copy [the design template](docs/design/TEMPLATE.md) into your project's design directory and
   fill it in. All reusable setup instructions and scripts remain in this package.

The Windows setup was developed against **DSH 0.2.1-rc.2**. Installation/API changes, unusual
permissions, links, or another sandbox policy can require further diagnosis. Preflight is an
early check, not a promise that every repository or future DSH release will work unchanged.

## DSH CLI and API key setup (Windows)

This bridge and its optional Codex skill call the **command-line version of DeepSeek Harness**.
The project-local `dsh-impl.ps1` launches `dsh headless --patch <run-patch.yml> --json` and sends
the design on standard input. The verified Windows desktop installation supplies the `dsh.cmd`
launcher shown above. Open a new terminal after installation and check `dsh --version`; if the
launcher is not on PATH, pass its full path to the bridge's `-Dsh` parameter.

**The following API key file path and commands are Windows-specific. Do not use them as
Linux or macOS configuration instructions.** Those platforms have not been verified by this
project; follow the DSH setup instructions for your platform and installation.

Before the first delegation, configure `DEEPSEEK_API_KEY` in the DSH user environment file:

```text
%USERPROFILE%\.dsh\.env
```

`%USERPROFILE%` is the Windows user-profile directory. The `.dsh` directory under it is the
default DSH home, and its `.env` applies across projects. If you already override `DSH_HOME`,
edit `.env` in that directory instead. The commands below assume the default Windows location:

```powershell
$dshUserHome = Join-Path $env:USERPROFILE '.dsh'
New-Item -ItemType Directory -Force -Path $dshUserHome | Out-Null
notepad.exe (Join-Path $dshUserHome '.env')
```

Add or update this entry with your own DeepSeek API key, preserving any other settings:

```dotenv
DEEPSEEK_API_KEY=your_deepseek_api_key
```

Save the filename as exactly `.env`, not `.env.txt`, then start a new bridge/DSH run so the
CLI loads it. An already supplied `DEEPSEEK_API_KEY` in the launching environment is also
supported. `dsh --version` only checks that the launcher runs; the first successful model
request confirms authentication. Keep the real key in your local user configuration, outside
this repository and the copied skill. Do not commit it, include it in run reports, or paste it
into chat. The skill uses your configured credentials and does not create or replace them.

## Delegate and review

```powershell
pwsh -NoProfile -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-example.md

# After review, continue the same DSH session for corrections:
pwsh -NoProfile -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-example.md `
  -Session session-<id-from-report> -Task 'Apply the reviewer feedback recorded in the design.'
```

The bridge passes the design to `dsh headless --patch <run-patch.yml> --json`, captures the
event stream and final report, and returns DSH's exit code. It writes
`.dsh-runs/<timestamp>-<run-id>-{prompt.md,events.jsonl,report.md,stderr.log,patch.yml}` in the
target repository. These task artifacts are separate from the reusable package; no package
script requires an old `.dsh-runs` folder. Output previews may be truncated, so save complete
test logs and inspect their actual exit status rather than relying on the model's summary alone.

| Parameter | Default | Purpose |
|---|---|---|
| `-Spec` | required | Design path relative to the repository |
| `-Repo` | Git root / cwd | Target repository |
| `-Task` | empty | Additional instructions or reviewer feedback |
| `-Session` | new session | Continue an earlier session in the same repository |
| `-Mode` | `workspace-write` | DSH permission mode |
| `-TimeoutMinutes` | `90` | Run wall-clock limit |
| `-MaxObjects` | `28000` | Windows preflight object cap; `0` disables it, any positive Int32 such as `50000` may be used |
| `-OutDir` | `.dsh-runs` | Run artifacts |
| `-Dsh` | PATH / desktop fallback | Explicit DSH launcher |
| `-Config` | `bridge.config.json` beside the script | Configuration file; explicit relative paths resolve against `-Repo` |
| `-ReasoningEffort` | configuration / `max` | `off`, `low`, `high`, or `max` |
| `-CodexReviewEdits` | configuration / `Not Allow` | `Not Allow` or `Allow` |
| `-DryRun` | off | Print resolved settings, prompt and command without starting DSH or preflight |
| `-SkipWindowsPreflight` | off | Diagnostic opt-out from readiness checks; does not change confinement |

Normal Windows workspace-write runs check readiness before starting the model. The bridge passes
its effective `-MaxObjects` to `setup.ps1 -Action Check` and shows that value in dry-run output and
the run report. Preflight never repairs permissions automatically. Read-only runs, dry runs, and
non-Windows runs do not need this check. For a nondefault desktop installation, use the setup
tool's `-InstallDir`; consult the Windows guide for bridge invocation when automatic installation
discovery does not match your launcher.

## Model, effort, and Codex review policy

The bridge does not edit DSH profiles, credentials, authentication or global settings. For
every normal run and dry run it generates a temporary, run-scoped YAML patch under `OutDir` and
passes it to `dsh headless --patch <absolute-overlay-path>`. The overlay sets only the
`agent-default-model` entry:

```yaml
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
```

This selects the model and effort for that invocation, including a resumed session and rework.
The shipped `bridge.config.json` beside `dsh-impl.ps1` supplies the defaults:

```json
{
  "reasoningEffort": "max",
  "codexReviewEdits": "Not Allow"
}
```

Each setting resolves independently: explicit command-line parameter, then configuration file,
then built-in default (`max` / `Not Allow`). The implicit file is `bridge.config.json` beside
the script; `-Config` selects another file, and an explicit relative path resolves against
`-Repo`. An absent implicit file keeps the built-in defaults, while an explicitly named missing
or invalid file fails before preflight or model launch. Supported effort values are `off`,
`low`, `high`, `max`; the review policy is `Not Allow` or `Allow`. Values are case-insensitive;
effective values are canonicalized to lower-case effort and `Not Allow`/`Allow`.

The tested catalog labels this model alias DeepSeek-V4.1-Flash. Configure authentication using
[DSH CLI and API key setup (Windows)](#dsh-cli-and-api-key-setup-windows) or an existing
`DEEPSEEK_API_KEY` in the launching environment. A missing key/profile is an authentication/setup
problem, not a reason to disable confinement.

`codexReviewEdits` controls what Codex may do after reviewing a DSH run. `Not Allow` is the
default: Codex reviews and runs checks, records findings, and delegates production fixes and
test additions to the same DSH session. `Allow` permits only small, localized fixes tied to a
recorded review finding, plus a few focused regression/acceptance cases for that finding; Codex
records what it changed and independently runs the relevant checks. Feature implementation,
large refactors, dependency changes and broad test-suite work stay with DSH. Codex never
weakens existing assertions or counts the same self-review as independent acceptance. This is a
collaboration instruction, not an OS/security sandbox; it does not grant publication or
unrelated permissions. Existing explicit user instructions take priority. Neither setting
changes DSH's role or grants DSH commit/publication permission.

## Package contents

| Path | Purpose |
|---|---|
| `dsh-impl.ps1` | Design → DSH run → review report |
| `bridge.config.json` | Shipped reasoning effort and Codex post-review edit policy |
| `SKILL.md` | Optional Codex skill entry point for setup, delegation and review |
| `agents/openai.yaml` | Codex skill display metadata |
| `AGENTS.md` | Portable collaboration and onboarding instructions |
| `docs/design/TEMPLATE.md` | Per-phase design skeleton |
| `docs/windows-sandbox.md` | Windows diagnosis, repair, verification and rollback method |
| `windows/` | Portable Windows setup and confined probes |
| `docs/node-testing.md` | Complete-suite test integration and TypeScript example |
| `node/` | File-backed subprocess capture and no-worker test launcher |
| `LICENSE` | MIT license, retained when copying the package |
| `mcp/dsh-mcp-server.mjs` | Optional MCP interface to the bridge |
| `.state/` | Ignored, machine/repository-specific setup evidence and backups |

When distributing the folder, **omit `.state/` and generated test fixtures**. Retain recovery data
at the original repository until no longer needed. There are no project-specific sessions, user
SIDs, credential files, or installed-runtime copies to transfer.

## Optional MCP interface

```powershell
codex mcp add dsh -- node C:\path\to\repo\dsh-codex-bridge\mcp\dsh-mcp-server.mjs
```

The `dsh_implement` tool accepts `spec`, `task`, `session`, `repo`, `mode`, `timeout_minutes`,
`config`, `reasoning_effort`, `codex_review_edits`, and `max_objects`. The configuration/effort/
policy fields map to the bridge's `-Config`, `-ReasoningEffort`, and `-CodexReviewEdits`
parameters, and `max_objects` maps to `-MaxObjects`; omitted values let the project's
configuration and built-in defaults apply. `0` is forwarded as an explicit unlimited opt-out.
Tool-schema defaults are descriptive only and are not injected into project settings. Run
Windows setup before using it. It calls the same bridge and preserves its preflight checks.
Direct PowerShell invocation is the clearest route for setup diagnostics.

## Verify a new project

The bundled Windows `Verify` action is an operational readiness check. Its probes stay in the
copyable package because a new repository needs them to validate setup. Development regression
suites and historical acceptance records are maintained outside this folder.

After setup, write a verification-only design using `docs/design/TEMPLATE.md`. Name the target
project's actual typecheck, build and complete test commands. Delegate it through the bridge,
then have Codex independently inspect the logs and rerun the appropriate checks. Do not assume
an old demo's test count or filesystem layout applies to the new project.

This package has been verified on Windows with a TypeScript terminal application, DSH desktop
0.2.1-rc.2, PowerShell 7 and Node 22.14.0. Linux, macOS, web/backend/native UI projects and other
DSH versions still need separate validation. Skipping Windows preflight on another platform
is not evidence that the whole workflow has been tested there.

## Troubleshooting

- **`grantWrite` Win32 5, nested writes denied, or build output EPERM on Windows:** follow the
  Windows guide. Do not remove deny entries or retry a failed repair blindly.
- **Node `spawn EPERM` with pipe capture inside DSH on Windows:** use the supplied test runner
  and file-backed capture helper. Keep every assertion and every real CLI subprocess.
- **Profile writes denied under `~/.dsh`:** the Codex launcher may need approved execution outside
  its own process sandbox so DSH can initialize its profile. DSH's child sandbox stays enabled.
- **Session refused:** resume from the same repository that created it.
- **Unsupported platform/layout/API or failed confinement probe:** report the evidence and stop;
  never automatically switch to `danger-full-access`.

The Windows-specific mechanisms are described in the
[official DSH Windows backend documentation](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md).

## License

[MIT](LICENSE). Keep the license with redistributed copies.
