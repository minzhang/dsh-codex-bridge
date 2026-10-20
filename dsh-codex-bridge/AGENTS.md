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

Use the user's requested model/effort (Flash/Max in this kit's onboarding example). The bridge
reads `bridge.config.json`, an explicit `-Config` file, or `-ReasoningEffort` and applies the
selection through a run-scoped `--patch` overlay. It must not edit user profiles, credentials,
authentication or unrelated settings. Report each phase after review and any rework; pause at
phase boundaries when requested. A setup repair is not authorization to start the next
development phase.

Work in this repository is split between two agents. Do not blur the roles.

- **Design agent (Codex)** — owns requirements, interface and data design, task
  decomposition, review, and merge decisions. It writes design documents. Production code
  and test edits are governed by the Codex review edits policy below; it does not implement
  features.
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
   leaves the changes uncommitted. It returns one JSON implementer report with status
   `DONE`, `BLOCKED` or `PARTIAL`; the bridge writes the canonical result and report.
4. The design agent reviews `git diff` plus the run result/report in `.dsh-runs/`, reruns the
   acceptance checks itself, and then either merges or delegates a corrective round.

## Codex review edits policy

Before making any post-review edit, consult the effective `codexReviewEdits` value: read
`bridge.config.json`, an explicit `-Config`, or the run report/dry-run output. The default is
`Not Allow`.

- **`Not Allow`** — Codex reviews, runs checks, records findings, and delegates production
  fixes and test additions to the same DSH session. It does not edit production code or tests
  itself.
- **`Allow`** — Codex may make only small, localized fixes tied to a recorded review finding,
  plus a few focused regression/acceptance cases for that finding. Codex records what it
  changed and independently runs the relevant checks.

Feature implementation, large refactors, dependency changes and broad test-suite work stay with
DSH under both settings. Never weaken existing assertions, and never count the same self-review
as independent acceptance. This is a collaboration instruction, not an OS/security sandbox; it
does not grant publication or unrelated permissions. Existing explicit user instructions take
priority. Neither setting changes DSH's role or grants DSH commit/publication permission.

## Rules both agents follow

- Never commit, push, tag, or rewrite history unless a human explicitly asks in that turn.
- Keep implementation inside the repository. The explicitly authorized setup probes may use
  their own disposable temp fixtures as documented; no unrelated outside files may be changed.
- Keep diffs focused on the design; no opportunistic refactors, no formatting-only churn,
  no new dependencies the design does not name.
- A valid `BLOCKED` implementer report is a success, not a failure: escalate the exact
  questions rather than guessing at product behavior. A legacy `STATUS:` prose response is
  invalid diagnostic text and is never accepted silently.
- The design document is the source of truth. If implementation reveals the design is
  wrong, stop and revise the design first.

## Status vocabulary

| Result | Meaning for the design agent |
|---|---|
| `task.status: DONE` + `report.validity: VALID` | Review the diff and run the acceptance checks independently |
| `task.status: PARTIAL` | Something was left unfinished; read `followUps` before continuing |
| `task.status: BLOCKED` | A material decision is missing; answer in the design doc, then redelegate |
| `report.validity: INVALID` or `MISSING` | Do not accept the claim; inspect `report.errors` and the raw final artifact |
| `acceptance.status: PENDING` | Always true for a DSH report; independent acceptance has not occurred |

The result file is authoritative over prose: execution outcome, implementer claim, report
validity and acceptance are separate dimensions. A zero process exit does not make the task
accepted.

## Notes

- `.dsh-runs/` holds per-run artifacts (prompt, patch, event stream, result, raw final text,
  report, inventories). Treat it as local scratch space, not as a source of truth.
- One design document should be one reviewable change set, roughly 30–90 minutes of work.
