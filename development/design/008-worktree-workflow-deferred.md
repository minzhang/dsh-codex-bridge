# Worktree delegation discussion (deferred)

Status: DEFERRED by the user on 2026-10-21. This is a discussion archive, not implementation authorization.

## Proposed workflow

Codex would create a task branch and local worktree from an explicit baseline, prepare the
requirements, design, test plan and acceptance criteria, and commit/push those documents to
the task branch on GitHub. DSH would implement and test in that worktree, leaving code and
results uncommitted. Codex would inspect the actual diff, independently verify acceptance,
request rework in the same worktree when needed, then commit, push and merge accepted work.
Necessary local evidence would be preserved before eventual worktree cleanup.

A worktree is a local working directory, not a GitHub object; GitHub receives branch commits.
Same-host shared-directory execution and cross-host branch exchange are different workflows.
The discussion did not resolve which would be required. No worktree was created for this proposal.

## Design considerations retained for future discussion

- Preserve Codex design/review/publication and DSH implementation/fixes ownership. DSH gets
  no GitHub credentials and does not commit or publish.
- Keep requirements, design, tests and acceptance in one useful design document when possible;
  separate files are optional, not a new mandatory handoff ceremony.
- A complex goal may use one worktree across several bounded implementation/test rounds.
  Define module interfaces and integration acceptance before implementation; completion of
  individual modules is not final integration acceptance.
- A task, worktree, DSH session and individual run are distinct identities. Continue the
  lightweight session-selection rule and record a reason; changing sessions does not discard
  working files, and a fresh process does not necessarily mean a new session.
- Keep publishable implementation/review summaries separate from ignored raw events, session
  transcripts, machine paths and operational recovery evidence. Existing runtime token usage
  belongs with execution metadata. Uncommitted work is not backed up on GitHub.
- Codex could checkpoint partial work on the task branch without claiming final acceptance or
  merging to main. Give one writer ownership of a worktree at a time.
- A branch push or report write does not itself wake Codex. Existing completion return could
  serve a first same-host version; remote execution would need an explicit return mechanism.
- Linked worktrees share Git metadata outside their working directory. Windows preflight,
  sandbox read/write boundaries, inventory and result capture need actual validation before
  support is claimed. Worktree isolation does not replace the DSH sandbox.

## Long-running task concerns and decision

The user raised large designs, module/code/test volume, long or repeated agent runs, unexpected
termination and session startup/resume failures. Discussion identified the need for durable
start/finish evidence, exclusive execution ownership, observed liveness distinct from progress,
scanning unfinished runs, and checking actual files/processes before explicit recovery.
Simply increasing the current 90-minute timeout or restarting a session is insufficient.
Never start a second writer while an earlier run may still be alive. Never treat missing final
output as success, or a requested-session fallback as proof of resumed history.

The user decided to defer worktree functionality and address those execution-management gaps
in the existing bridge first. See [design 009](009-run-lifecycle-recovery.md). No worktree
automation, remote worker, GitHub watcher, unattended reboot continuation, or new handoff
document is authorized by this archived proposal. Revisit worktrees only on a future request.
