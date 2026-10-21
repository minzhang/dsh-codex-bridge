# Working on DSH Codex Bridge

The primary product is the self-contained Codex skill in `dsh-codex-bridge/`.
`development/` contains maintainer tests, designs and sanitized
history. `demos/pascal-desk/` is the first verification demo. Delivery must not depend on either
supporting directory. Keep future demos under `demos/`.

## Roles and workflow

For this bridge repository, Codex uses the user's selected Codex model throughout requirements,
design, implementation, fixes, tests, review, documentation and publication. Do not delegate this
repository's development to DSH or switch to another model. The Codex/DSH delegation workflow
shipped in `dsh-codex-bridge/` is for development tasks in other projects; its implementation-role
instructions do not override this repository's maintenance policy. Use real controlled child
processes to test the bridge without delegating the implementation to a DSH agent.
Record approved designs under `development/design/` and actual verification evidence in reviews.

## Current authorization

The user requested this three-part organization and a public MIT-licensed GitHub repository,
including commits and pushing/merging the code. Codex may complete that publication. DSH must
not commit, publish, access GitHub credentials, or change authentication/profile configuration.
The Pascal Desk feature phases are complete; this task does not authorize new demo features or
claims that untested platforms or project types have been verified.

Users install the skill from GitHub and invoke `$dsh-codex-bridge` in their target project.
The user removed CI and packaging/export tooling from scope. No build, package or release
pipeline is required.

Maintain one skill entry point and one canonical runtime. During onboarding, Codex prepares
the project-local runtime from the installed skill or reuses a complete existing runtime.
Never run Windows repair against the shared skill installation or overwrite recovery evidence.

## Constraints

- The delivered bridge uses DeepSeek Flash with Max effort and DSH workspace-write confinement.
  Never disable confinement to make checks pass. Normal Windows preflight remains enabled.
- Preserve all existing assertions and coverage. Location-only test corrections are allowed;
  do not drop or weaken checks. Keep normal and sandbox test-file lists synchronized.
- Keep credentials, machine-specific ACL backups, raw agent transcripts, personal paths,
  dependencies and build products out of Git. Preserve recovery evidence locally and ignored.
- Operational preflight, setup, verification probes and rollback belong in delivery. Maintainer
  regression suites and development history belong outside delivery.
- Windows setup tests may repair only their own unique host-temp disposable fixtures, never this repository or
  unrelated paths. Bound every Windows move/delete to a verified workspace or fixture path.
- Do not add dependencies beyond the current design. Preserve user edits and local evidence.
- Run complete bridge and demo checks with Codex. Validate both ordinary and no-worker bridge
  runners as appropriate; the latter supports DSH use in downstream projects. Actual child-process
  checks must remain real. Do not launch a DSH agent to perform this repository's implementation.
- Read the root README and development README for commands. After acceptance record the review
  in `development/reviews.md`. Historical designs/reports describe their original layout and
  do not override the current design or instructions.
