# 003 — Public repository organization

Status: accepted final scope, 2026-10-19. This document incorporates the owner's clarification
that delivery is a direct folder copy. It supersedes the earlier CI and export proposal.

## Goal and scope

Make the copyable bridge the primary product, with maintainer assets and demo projects separate.
Preserve accepted behavior. No new platform support or Pascal Desk features.

- `dsh-codex-bridge/`: self-contained operational delivery, including instructions, setup probes
  and MIT license. No development regression suite or history.
- `development/`: bridge tests, designs and sanitized acceptance history.
- `demos/pascal-desk/`: accepted editor source and all 148 tests.

Users copy the delivery folder into their project's root. There is no build, package, export,
release artifact or CI requirement. Local `.state/` recovery evidence must not be distributed.

## Ownership

Codex owns repository organization, documentation, independent acceptance and publication. DSH
owns implementation and rework, leaves changes uncommitted, and reports actual commands/results.
Use DeepSeek Flash with Max effort, workspace-write confinement and normal Windows preflight.
Do not read credentials, change authentication profiles or repair this repository for a test.

## Implementation

1. Relocate bridge regression tests to `development/tests/`, importing canonical delivery files.
   Preserve original assertions. Include delivery and development tests in syntax checks. Compile
   the TypeScript consumer against the canonical helper.
2. Move the operational Node probe to `dsh-codex-bridge/windows/lib/verify-node.mjs` and update
   its setup reference. Preserve its bytes and real confined behavior; it belongs in delivery.
3. Provide root dependency-free npm commands for normal/sandbox bridge tests, Windows checks,
   normal/sandbox demo tests and demo launch. Add MIT metadata without changing demo dependencies.
4. Keep lifecycle fixtures under unique host-temp directories outside the project. Store only
   evidence pointers under ignored `development/.state/`. Preserve original bridge recovery data.
5. Publish source, instructions, maintainer tests and the demo under MIT. Keep credentials, raw
   transcripts, machine paths, ACL backups, dependencies and generated output out of Git.

## Review corrections retained

The ordinary runner exposed fixture interference: capture tests now scope their own temporary
directory and restore the environment, and standalone runner children receive a copied environment
without NODE_TEST_CONTEXT. All cleanup, output, marker and exit assertions remain intact.

Windows argument-validation checks use a bounded synthetic DSH install. Live lifecycle checks
still use the actual installation and real confined PowerShell/Node children.

Restored Medium-label fixture trees cannot remain inside the workspace because preflight correctly
detects them. Lifecycle fixtures now remain in host temp. The temporary-WRITE_OWNER scenario
prepares only its unique outer container with an inheritable Modify grant, preserving other
principals, denies, owner and integrity label. The copied repository keeps an unprotected DACL.
The assertion that WRITE_OWNER is absent before repair and exact rollback checks remain required.
Codex made the final reviewer-owned fixture correction; no delivery permission algorithm changed.

## Acceptance

DSH runs the complete sandbox bridge suite, Windows checks, demo typecheck/build and all 148 demo
tests, plus the strict NodeNext TypeScript consumer. Codex runs ordinary worker-isolated suites,
reviews changes and checks both copied-folder lifecycle scenarios on the host. After lifecycle
checks the main repository's normal preflight must remain READY without permission changes.

Commands and results belong in `../reviews.md`; raw logs and recovery evidence stay local and
ignored. Linux/macOS and web/backend/native UI projects remain explicitly unverified.

The initial implementation included an exporter, seven exporter tests and Windows CI. The owner
removed those from scope before final handoff. They were removed together; all 12 original bridge
Node tests and 148 demo tests remain. No replacement delivery tooling is needed.
