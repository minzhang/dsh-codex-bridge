---
name: dsh-codex-bridge
description: Delegate implementation and testing to DeepSeek Harness (DSH) while Codex owns design, review, and rework. Use when the user requests Codex/DSH collaboration or asks to set up this bridge in a project.
---

# Codex and DSH collaboration

Codex defines the work and accepts the result; DSH implements, tests, and fixes review findings.
Use this project's existing conventions and the user's scope, model/effort choices, and phase
boundaries. Loading this skill does not authorize unrelated work or publication.

## Locate the project and bridge

Resolve the target project root from the user's task and working directory. Paths in the links
below are relative to this skill folder; command examples run from the target project root.

After the user installs and invokes this skill, prepare its project-local runtime:
inspect `<project>/dsh-codex-bridge/` and reuse an existing complete runtime. If absent,
initialize that directory from the installed skill's bundled files, including hidden `.gitignore`,
docs, scripts and LICENSE, but excluding `.state/` and generated local evidence. Use real files,
not links. Codex performs this preparation; the user does not need to distribute folders.
Preserve existing project files and recovery data. If the directory is incomplete, inspect it
and resolve the missing files without overwriting unrelated content or evidence.

Read the project instructions plus the project-local bridge's [README.md](README.md) and
[AGENTS.md](AGENTS.md). Preserve existing project rules. Keep `.dsh-runs/` ignored in the target
project; the bridge's `.gitignore` already excludes its `.state/` recovery data.

Always run setup and delegation from the **project-local bridge**, with `-Repo` set to the target
project. Windows setup requires the bridge to be inside that repository. Never run Repair against
the shared skill installation or treat the skills directory as the target project.

## Prepare DSH

This skill invokes the **DSH command-line interface**: the project-local `dsh-impl.ps1` runs
`dsh headless`. Check the launcher and authentication using **DSH CLI and API key setup (Windows)**
in [README.md](README.md). On the verified Windows installation, the default user environment
file is `%USERPROFILE%\.dsh\.env`, containing `DEEPSEEK_API_KEY`; an existing `DSH_HOME` override
changes that location. These Windows paths and setup steps do not apply to Linux or macOS.
Have the user configure any missing key locally; do not request its value in chat.

Use the README's **Model, effort, and Codex review policy** section. The bridge selects
DeepSeek Flash and the requested effort for
each invocation through a run-scoped `--patch` overlay; its shipped `bridge.config.json`
defaults to `reasoningEffort: high` and `codexReviewEdits: Not Allow`. `-Config`,
`-ReasoningEffort`, and `-CodexReviewEdits` override the file per setting. Do not edit global
profiles, credentials or unrelated settings, and never print or copy credentials into the
project.

Keep DSH's `workspace-write` sandbox and normal Windows preflight enabled. On Windows, read
[docs/windows-sandbox.md](docs/windows-sandbox.md), run Check, perform the documented bounded
repair only when needed and authorized, and Verify a new setup before development. Stop on failed
confinement or unresolved setup; do not bypass preflight or switch to full access to proceed.

For Node subprocess/worker limitations on Windows, consult
[docs/node-testing.md](docs/node-testing.md). Keep the complete suite and real subprocess assertions.
Windows with a TypeScript terminal application is the verified environment. Linux/macOS and other
project types need separate validation; do not run Windows ACL repair there.

## Choose a DSH session

For related work in the same repository, default to resuming the existing DSH session,
including implementation, testing and rework. Pass `-Session <id-from-report>` to resume;
omit `-Session` to start a new session. A new process or run report does not mean a new session.

Codex decides when a new session better fits the task. Before each delegation, record the
choice and a brief reason in the existing design or delegation notes, for example:
`Session: RESUME <id> — same task rework` or `Session: NEW — independent task`.

## Delegate, review, and rework

The default execution timeout is 180 minutes; increase `-TimeoutMinutes` for longer work.
After an interruption or an occupied-repository error, use `dsh-run.ps1 -Action Scan`.
See [execution status and recovery](docs/run-recovery.md) for inspection and explicit Stop/Recover.
Recovery preserves evidence and never starts another session automatically.

1. Define a reviewable phase in the project's design directory using
   [docs/design/TEMPLATE.md](docs/design/TEMPLATE.md). Specify scope, interfaces, permitted files,
   constraints, and the project's actual build/test commands. Resolve material product decisions
   before delegation. Do not impose the Pascal demo's phase count or test commands on another project.
2. Run the bridge from the target project root, replacing the example spec with that design.
   This example starts a new session; add `-Session` when resuming:

   ```powershell
   pwsh -NoProfile -File ./dsh-codex-bridge/dsh-impl.ps1 -Repo . -Mode workspace-write -Spec docs/design/001-example.md
   ```

   DSH implements and runs the complete acceptance checks, leaving changes uncommitted. Capture
   complete test logs and exit codes; truncated event previews are not test evidence.
3. Inspect the run result, report and actual diff, including newly created files. A valid
   `task.status: DONE` means ready for review. The canonical `.dsh-runs/<run>-result.json`
   keeps process outcome, implementer claim, report validity and pending independent
   acceptance separate; a zero exit is not acceptance. Independently run the acceptance checks
   and inspect actual counts/failures.
   On the affected Windows backend, DSH uses the complete sandbox-compatible suite and Codex also
   runs the ordinary suite on a compatible host. Before any post-review edit, read the effective
   `codexReviewEdits` from `bridge.config.json`, an explicit `-Config`, or the run report. The
   default `Not Allow` means Codex records findings and delegates production fixes and test
   additions to DSH, following the session choice above. `Allow` permits only small, localized
   fixes tied to a recorded finding and a few focused regression/acceptance cases; record those changes and
   independently run the relevant checks. Feature work, large refactors, dependency changes and
   broad test-suite work stay with DSH. Never weaken assertions or treat the same self-review as
   independent acceptance. This collaboration policy is not an OS/security sandbox and grants no
   publication or unrelated permissions; explicit user instructions take priority.
4. Record actionable review findings in the design. Normally resume for corrections, using the
   **session ID from that run's report** and the **same target repository**:

   ```powershell
   pwsh -NoProfile -File ./dsh-codex-bridge/dsh-impl.ps1 -Repo . -Mode workspace-write -Spec docs/design/001-example.md -Session session-<id-from-report> -Task 'Apply the reviewer feedback recorded in the design and rerun the acceptance checks.'
   ```

   Review and verify the rework before accepting it. For a valid `PARTIAL` or `BLOCKED` result,
   inspect the exact cause, revise the design or resolve setup as appropriate, and ask only for
   genuinely missing decisions. Do not blindly repeat a failed run or silently take over
   production implementation. Legacy `STATUS:` prose results are invalid diagnostic text.
5. Report accepted behavior, DSH and Codex checks, rework, and remaining limitations. Honor requested
   pauses before the next phase. Commit or publish only within the user's existing authorization.
