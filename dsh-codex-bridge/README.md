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

# After review, normally continue the same DSH session for corrections:
pwsh -NoProfile -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-example.md `
  -Session session-<id-from-report> -Task 'Apply the reviewer feedback recorded in the design.'
```

Follow the [session selection rules](SKILL.md#choose-a-dsh-session): default to resuming related
work, choose a new session when appropriate, and record a brief reason for either choice.

The bridge passes the design to `dsh headless --patch <run-patch.yml> --json`, captures the
event stream and final report, and returns the bridge exit code (preserving a nonzero DSH exit
or timeout 124; 65 means a zero-exit run had a missing/invalid report). It writes
`.dsh-runs/<timestamp>-<run-id>-{prompt.md,patch.yml,events.jsonl,stderr.log,report.md,result.json,final.txt,inventory-before.json,inventory-after.json}`
in the target repository. These task artifacts are separate from the reusable package; no
package script requires an old `.dsh-runs` folder. Output previews may be truncated, so save
complete test logs and inspect their actual exit status rather than relying on the model's
summary alone. Stdout keeps the existing `config:`, `dsh:`, `session:` and `report:` lines,
adds `result:` with the repository-relative result file path, and adds one concise
`token usage (...)` line; the four outcome dimensions and artifact pointers appear before the
raw implementer message.

### Run result contract

Execution ownership and interruption diagnostics live separately in `.dsh-runs/control/`.
One managed run may write to a repository at a time. Use `dsh-run.ps1 -Action Status` or
`-Action Scan` to inspect it, and explicit Stop/Recover when needed. See
[execution status and recovery](docs/run-recovery.md) for commands, states and limitations.
The default DSH execution timeout is 180 minutes; longer tasks can override it.

`<run>-result.json` is the canonical machine-readable result (`schemaVersion: 1`). It keeps
four dimensions separate:

| Dimension | Meaning |
|---|---|
| `execution` | `SUCCEEDED`, `FAILED`, `TIMEOUT`, or `LAUNCH_FAILED`, plus original DSH exit code (nullable), bridge exit code, duration and effective settings |
| `task` | The implementer's claim: `DONE`, `BLOCKED`, `PARTIAL`, or `UNKNOWN`, with summary, changes, checks, decisions and follow-ups. It is never acceptance |
| `report` | `VALID`, `INVALID`, or `MISSING`, with validation errors/warnings and the raw final-message artifact |
| `acceptance` | Always `PENDING` for a DSH report, with coverage `COMPLETE`, `INCOMPLETE`, or `NOT_DECLARED` and expected/missing check IDs |

The result also contains `runId`, nullable `sessionId` plus `sessionProvenance`, the design
path, timestamps, working-tree observations, diagnostics and artifact paths. `execution:
SUCCEEDED` means only that the child exited normally with code zero; it says nothing about the
report or task. A missing or invalid report after a zero exit makes the bridge exit **65**.
Nonzero DSH exits are preserved, and a timeout exits **124**. A valid `BLOCKED` or `PARTIAL`
report with normal execution exits zero and is a normal result. `DONE` with a declared check
missing, failed, blocked, not run, or without a safe log is invalid.

The implemented schema (all keys shown; artifact paths are repository-relative when inside the
repository, otherwise absolute):

```json
{
  "schemaVersion": 1,
  "runId": "yyyyMMdd-HHmmss-xxxxxxxx",
  "sessionId": "string or null",
  "sessionProvenance": "EVENT | REQUESTED_FALLBACK | null",
  "design": { "path": "relative/design.md" },
  "timestamps": { "startedAt": "ISO-8601", "completedAt": "ISO-8601" },
  "execution": {
    "status": "SUCCEEDED | FAILED | TIMEOUT | LAUNCH_FAILED",
    "originalExitCode": "integer or null",
    "bridgeExitCode": "integer",
    "durationMs": "integer",
    "settings": {
      "mode": "string",
      "model": "string",
      "reasoningEffort": "string",
      "reasoningEffortSource": "string",
      "codexReviewEdits": "string",
      "codexReviewEditsSource": "string",
      "configuration": "string",
      "preflightObjectLimit": "integer",
      "timeoutMinutes": "integer"
    },
    "usage": {
      "scope": "RUN",
      "source": "DSH_STEP_END",
      "status": "COMPLETE | PARTIAL | UNAVAILABLE",
      "stepsObserved": "integer",
      "stepsWithUsage": "integer",
      "inputTokens": "integer or null",
      "inputUncachedTokens": "integer or null",
      "inputCacheHitTokens": "integer or null",
      "inputCacheMissTokens": "integer or null",
      "inputCacheWriteTokens": "integer or null",
      "outputTokens": "integer or null",
      "reasoningTokens": "integer or null",
      "totalTokens": "integer or null",
      "cacheHitRate": "number from 0 to 1, or null",
      "warnings": ["string"]
    }
  },
  "task": {
    "status": "DONE | BLOCKED | PARTIAL | UNKNOWN",
    "claimedStatus": "DONE | BLOCKED | PARTIAL | null",
    "summary": "string",
    "changes": [{ "path": "string", "description": "string" }],
    "checks": [{
      "id": "string",
      "command": "string",
      "cwd": "string",
      "status": "PASS | FAIL | NOT_RUN | BLOCKED",
      "exitCode": "integer or null",
      "logPath": "string or null",
      "reason": "string",
      "source": "IMPLEMENTER",
      "logAvailability": "PRESENT | MISSING | NOT_PROVIDED | UNSAFE",
      "additional": "boolean"
    }],
    "decisions": ["string"],
    "followUps": ["string"]
  },
  "report": {
    "validity": "VALID | INVALID | MISSING",
    "errors": ["string"],
    "warnings": ["string"],
    "rawTextArtifact": "string or null",
    "legacyStatus": "boolean"
  },
  "acceptance": {
    "status": "PENDING",
    "coverage": "COMPLETE | INCOMPLETE | NOT_DECLARED",
    "expectedCheckIds": ["string"],
    "missingCheckIds": ["string"],
    "additionalCheckIds": ["string"]
  },
  "observations": {
    "workingTree": {
      "status": "OBSERVED | UNAVAILABLE",
      "reason": "string or null",
      "headBefore": "string or null",
      "headAfter": "string or null",
      "counts": { "NEWLY_CHANGED": 0, "PREEXISTING_CHANGED": 0, "PREEXISTING_UNCHANGED": 0, "UNKNOWN": 0 },
      "paths": [{
        "path": "string",
        "classification": "NEWLY_CHANGED | PREEXISTING_CHANGED | PREEXISTING_UNCHANGED | UNKNOWN",
        "changeKinds": ["string"],
        "statusBefore": "string or null",
        "statusAfter": "string or null",
        "indexStatusBefore": "string or null",
        "indexStatusAfter": "string or null",
        "worktreeStatusBefore": "string or null",
        "worktreeStatusAfter": "string or null",
        "sha256Before": "string or null",
        "sha256After": "string or null",
        "indexShaBefore": "string or null",
        "indexShaAfter": "string or null",
        "indexModeBefore": "string or null",
        "indexModeAfter": "string or null",
        "linkIdentityBefore": "string or null",
        "linkIdentityAfter": "string or null",
        "unsafeBefore": "boolean",
        "unsafeAfter": "boolean",
        "typeBefore": "string or null",
        "typeAfter": "string or null",
        "presentBefore": "boolean or null",
        "presentAfter": "boolean or null"
      }],
      "warnings": ["string"]
    },
    "toolCalls": "integer",
    "toolErrors": "integer",
    "tokens": { "input": "number", "output": "number" },
    "implementerClaimedChanges": ["string"]
  },
  "diagnostics": {
    "malformedEventLines": { "count": "integer", "lineNumbers": ["integer"] },
    "lastValidEvent": { "type": "string", "phase": "string or null" },
    "turnEnd": { "reason": "string or null", "error": "string or null" },
    "error": "string or null",
    "captureErrors": ["string"],
    "inventoryErrors": ["string"],
    "stderrArtifact": "string"
  },
  "artifacts": {
    "prompt": "string",
    "patch": "string",
    "events": "string",
    "stderr": "string",
    "report": "string",
    "result": "string",
    "finalText": "string",
    "inventoryBefore": "string",
    "inventoryAfter": "string"
  }
}
```

`lastValidEvent`/`turnEnd` may be `null`. `workingTree.counts` appears when observation is
`OBSERVED`; `paths` is empty when it is `UNAVAILABLE`.

`observations.tokens` is **deprecated** legacy raw `input`/`output` accounting from
`step_end` events. Its `input` excludes both DSH cache buckets and is not a cache-inclusive
input total. It remains for old consumers and existing assertions; new human, terminal and
MCP summaries use `execution.usage`. It may be `null` when DSH reported no usage, and null is
never treated as zero usage.

### Runtime token usage

`execution.usage` is telemetry for **this bridge invocation** (`scope: RUN`) only. It is not
a lifetime session total: a resumed session has separate runs, and earlier runs or private
session storage are never scanned. `source: DSH_STEP_END` means only `status` /
`phase: step_end` events from this run's captured JSONL contribute; usage on other event
types is ignored so it cannot be counted twice. These are sums across model calls, so
repeated or cached context is counted on each call; they are not the number of distinct
tokens or the context-window size. A missing usage object is not zero. An explicitly
reported all-zero sample is valid and is distinct from no sample.

Per step, DSH's `inputTokens` is uncached input; `cacheReadTokens` is cache hit;
`cacheWriteTokens` is cache write. The bridge normalizes:

| Metric | Formula |
|---|---|
| `inputUncachedTokens` | DSH `inputTokens` |
| `inputCacheHitTokens` | DSH `cacheReadTokens` |
| `inputCacheWriteTokens` | DSH `cacheWriteTokens` |
| `inputCacheMissTokens` | uncached + cache write |
| `inputTokens` | uncached + cache hit + cache write |
| `outputTokens` | DSH `outputTokens` |
| `totalTokens` | input total + output |
| `cacheHitRate` | run cache hit / run input total (null for zero input) |

`reasoningTokens`, when supplied, is a subset of output and is never added to the total a
second time. Cache absence is not treated as zero. When cache buckets are absent but a valid
reported total and output exist, the input total may be derived by subtraction while the
missing cache breakdown stays null. A reported total that contradicts complete components is
warned and the contradictory derived input/total/rate become null rather than an arbitrary
number. Invalid present values (negative, fractional, string, null, unsafe integer), sum
overflow, and reasoning greater than output stay unknown and generate warnings.

Each metric is aggregated only when it is known for every observed `step_end` event; a
missing or invalid step value makes that aggregate null instead of an apparently complete
subtotal. Independent known metrics are preserved. `COMPLETE` requires all core buckets and
totals known, no accounting warnings, usage on every observed step, and a fully captured
normally completed invocation. `PARTIAL` means some usage was reported but required data or
execution/capture completeness is missing; timeouts, failures, capture errors, malformed
events and missing completion keep available counts but explain that unreported or
in-flight usage is unknown. `UNAVAILABLE` means no usable counts. Telemetry status and
warnings do not change execution status, task/report validity or acceptance.

Markdown execution information includes a separate `Token usage` subsection, and the
terminal summary has one concise token line. Both identify RUN scope, completeness and all
breakdowns, label cache write as included in cache miss and reasoning as included in output,
and say `not reported` for unknown counts (`not available` for an unknown rate). MCP returns
the same object in `structuredContent` and uses the same values in its text summary. New
results validate `execution.usage` before MCP returns them. Older results without it remain
readable and render a clearly labeled deprecated raw-input/output fallback that never claims
a cache-inclusive total.

The bridge asks DSH for one JSON object as its final message; legacy `STATUS:` prose is
retained as raw diagnostic text but marked invalid. The bridge never executes commands named
by that report and never treats log existence as proof that a command passed. Check entries
are annotated `source: IMPLEMENTER` and `logAvailability: PRESENT | MISSING | NOT_PROVIDED |
UNSAFE`. PASS/FAIL requires a safe, existing log file for a declared acceptance check; null
logs stay explicitly `NOT_PROVIDED`. Log contents are not read automatically.

### Declared acceptance checks

A design may declare the expected command set between the exact markers below. Each entry
needs a unique `id` plus `command` and `cwd` strings:

```markdown
<!-- dsh-acceptance-start -->
[
  {"id": "A1", "command": "npm run test:sandbox", "cwd": "."},
  {"id": "A2", "command": "npm --prefix app run build", "cwd": "."}
]
<!-- dsh-acceptance-end -->
```

Malformed JSON or duplicate IDs stop the run before it writes artifacts or starts DSH. Designs
without markers remain usable with coverage `NOT_DECLARED`. For a declared manifest, every ID
must appear in the implementer checks, including `NOT_RUN`/`BLOCKED` entries with a reason.
Coverage is ID coverage, not test success. A reported command must match the manifest after
trimming surrounding whitespace only; arguments, quoted text, URLs and separators are not
rewritten. `cwd` may additionally normalize slash separators. A different command does not
satisfy an ID. Extra checks are allowed and marked additional.

### Working-tree observations

Before and after the run the bridge inventories relevant Git-tracked and untracked
nonignored paths with NUL-safe status names, staged/index state, content SHA-256, type and
presence. It classifies paths as `NEWLY_CHANGED`, `PREEXISTING_CHANGED`,
`PREEXISTING_UNCHANGED`, or `UNKNOWN`, and includes additions, deletions, two-path renames,
restoration to HEAD and staged-only changes. A file that was already dirty and changed again
is `PREEXISTING_CHANGED`, even when porcelain status looks unchanged. These are observations
during the run, not causal attribution to DSH; the implementer's changed-file claims remain
separate. Before reading or hashing any path, every parent directory is checked with `lstat`;
a link/reparse ancestor makes the path `UNKNOWN` with `unsafeBefore`/`unsafeAfter` set and a
visible warning, and its content is never read or followed. Non-Git repositories report
observation `UNAVAILABLE`; inventory failures are visible warnings. No file contents or
snapshots are published.

| Parameter | Default | Purpose |
|---|---|---|
| `-Spec` | required | Design path relative to the repository |
| `-Repo` | Git root / cwd | Target repository |
| `-Task` | empty | Additional instructions or reviewer feedback |
| `-Session` | new session | Continue an earlier session in the same repository |
| `-Mode` | `workspace-write` | DSH permission mode |
| `-TimeoutMinutes` | `180` | DSH execution wall-clock limit in minutes; zero times out immediately |
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
test additions to DSH, following [session selection](SKILL.md#choose-a-dsh-session).
`Allow` permits only small, localized fixes tied to a
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
| `dsh-run.ps1` | Read-only status/scan and explicit owned-run stop/recovery |
| `bridge.config.json` | Shipped reasoning effort and Codex post-review edit policy |
| `SKILL.md` | Optional Codex skill entry point for setup, delegation and review |
| `agents/openai.yaml` | Codex skill display metadata |
| `AGENTS.md` | Portable collaboration and onboarding instructions |
| `docs/design/TEMPLATE.md` | Per-phase design skeleton |
| `docs/windows-sandbox.md` | Windows diagnosis, repair, verification and rollback method |
| `windows/` | Portable Windows setup and confined probes |
| `docs/node-testing.md` | Complete-suite test integration and TypeScript example |
| `node/` | File-backed subprocess capture, no-worker test launcher, and canonical run-report helper |
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

For a launched run, the MCP tool returns the validated result object in `structuredContent`
and a readable text summary (including the four dimensions and artifact pointers) in
`content`. `isError` follows the bridge exit code. Only the exact
`<repo>/.dsh-runs/<run>-result.json` artifact is read; paths outside that location and
symlink/reparse escapes are rejected. A missing or invalid result after a normal bridge run
is an error. Early argument, configuration or preflight failures keep their existing plain
diagnostic response and do not fabricate a structured result. Dry runs do not create one.

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
