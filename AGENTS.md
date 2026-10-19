# Working on DSH Codex Bridge

The primary product is `dsh-codex-bridge/`, a self-contained delivery folder copied into new
repositories. `development/` contains maintainer tests, designs and sanitized
history. `demos/pascal-desk/` is the first verification demo. Delivery must not depend on either
supporting directory. Keep future demos under `demos/`.

## Roles and workflow

Codex owns requirements, design, repository organization, documentation, independent review and
publication. DeepSeek Harness (DSH) owns production implementation and fixes. Codex may perform
mechanical moves/path corrections and write independent acceptance tests. Delegate approved
work using a design under `development/design/`; use the same DSH session for rework. DSH leaves
changes uncommitted and reports actual commands/results. Codex independently verifies acceptance.

## Current authorization

The user requested this three-part organization and a public MIT-licensed GitHub repository,
including commits and pushing/merging the code. Codex may complete that publication. DSH must
not commit, publish, access GitHub credentials, or change authentication/profile configuration.
The Pascal Desk feature phases are complete; this task does not authorize new demo features or
claims that untested platforms or project types have been verified.

Distribution is direct folder copy. The user explicitly removed CI and packaging/export tooling
from scope. No build, package or release pipeline is required to deliver the bridge.

## Constraints

- Use DeepSeek Flash with Max effort and DSH workspace-write confinement. Never disable it to
  make checks pass. The bridge's normal Windows preflight remains enabled.
- Preserve all existing assertions and coverage. Location-only test corrections are allowed;
  do not drop or weaken checks. Keep normal and sandbox test-file lists synchronized.
- Keep credentials, machine-specific ACL backups, raw agent transcripts, personal paths,
  dependencies and build products out of Git. Preserve recovery evidence locally and ignored.
- Operational preflight, setup, verification probes and rollback belong in delivery. Maintainer
  regression suites and development history belong outside delivery.
- Windows setup tests may repair only their own unique host-temp disposable fixtures, never this repository or
  unrelated paths. Bound every Windows move/delete to a verified workspace or fixture path.
- Do not add dependencies beyond the current design. Preserve user edits and local evidence.
- Run complete bridge and demo checks. DSH uses no-worker sandbox suites on the affected Windows
  backend; Codex also runs the ordinary suites. Actual child-process checks must remain real.
- Read the root README and development README for commands. After acceptance record the review
  in `development/reviews.md`. Historical designs/reports describe their original layout and
  do not override the current design or instructions.
