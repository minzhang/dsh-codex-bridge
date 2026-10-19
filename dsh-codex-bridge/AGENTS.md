<!--
Drop-in AGENTS.md protocol for repos where Codex designs and DeepSeek Harness implements.
Both agents read AGENTS.md (Codex natively; dsh via its agent-instructions plugin), so this
file is the shared contract. Delete the HTML comments when adapting.
-->

# Agent roles: design vs implementation

## First run in a new repository

Read this package's `README.md` before delegation. Keep the whole `dsh-codex-bridge` folder
together. All reusable setup/repair code and instructions live here; never assume the originating
project's docs, `.dsh-runs`, source, saved sessions, machine paths, or credentials are available.

On Windows, follow `docs/windows-sandbox.md`: run Check, apply a repository-bounded repair when
authorized and needed, then Verify. Keep DSH in workspace-write mode. Preflight never silently
repairs permissions. Only the setup tool may perform its documented permission changes and own
disposable outside-temp probe; this does not authorize editing unrelated files or disabling either
sandbox. Ordinary Node worker pipes can fail on this backend; use `docs/node-testing.md` to retain
the complete suite and real CLI subprocess assertions. No skipped tests or fake success reports.

Do not run Windows permission scripts on macOS/Linux. Distinguish DSH child confinement from
the host permission needed to launch DSH or provision the approved repository. A blocked setup
must state the exact evidence and recovery path; do not prescribe full-access mode as a shortcut.

Use the user's requested model/effort (Flash/Max in this kit's onboarding example), preserving
existing profile configuration. Report each phase after review and any rework; pause at phase
boundaries when requested. A setup repair is not authorization to start the next development phase.

Work in this repository is split between two agents. Do not blur the roles.

- **Design agent (Codex)** — owns requirements, interface and data design, task
  decomposition, review, and merge decisions. It may write design documents, tests it
  intends to review, and trivial mechanical fixes. It does not implement features.
- **Implementation agent (DeepSeek Harness)** — writes production code, runs the checks,
  and fixes failures within the scope of exactly one design document.

## Delegation protocol

1. The design agent writes the design to `docs/design/<NNN>-<slug>.md` using
   `docs/design/TEMPLATE.md`. A design is ready to delegate only when:
   - the goal and success criteria are stated,
   - every public interface, schema change, and file to touch is named,
   - acceptance checks are written as commands that exit non-zero on failure,
   - out-of-scope work and open questions are explicit.
2. The design agent delegates:

   ```powershell
   pwsh -File dsh-codex-bridge/dsh-impl.ps1 -Spec docs/design/001-example.md
   ```

   For a follow-up round on the same work, pass the `session:` id from the previous run
   with `-Session` and describe the correction with `-Task`.
3. The implementation agent works in the repository, runs the acceptance checks, and
   leaves the changes uncommitted. It reports `STATUS: DONE | BLOCKED | PARTIAL`.
4. The design agent reviews `git diff` plus the run report in `.dsh-runs/`, reruns the
   acceptance checks itself, and then either merges or delegates a corrective round.

## Rules both agents follow

- Never commit, push, tag, or rewrite history unless a human explicitly asks in that turn.
- Keep implementation inside the repository. The explicitly authorized setup probes may use
  their own disposable temp fixtures as documented; no unrelated outside files may be changed.
- Keep diffs focused on the design; no opportunistic refactors, no formatting-only churn,
  no new dependencies the design does not name.
- A `STATUS: BLOCKED` report is a success, not a failure: escalate the exact questions
  rather than guessing at product behavior.
- The design document is the source of truth. If implementation reveals the design is
  wrong, stop and revise the design first.

## Status vocabulary

| Report line | Meaning for the design agent |
|---|---|
| `STATUS: DONE` | Review the diff and run the acceptance checks |
| `STATUS: PARTIAL` | Something was left unfinished; read `FOLLOW-UPS` before continuing |
| `STATUS: BLOCKED` | A material decision is missing; answer in the design doc, then redelegate |

## Notes

- `.dsh-runs/` holds per-run artifacts (prompt, event stream, report). Treat it as local
  scratch space, not as a source of truth.
- One design document should be one reviewable change set, roughly 30–90 minutes of work.
