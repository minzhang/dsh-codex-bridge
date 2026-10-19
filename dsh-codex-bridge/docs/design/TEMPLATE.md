<!--
Design document template. The design agent fills this in; the implementation agent treats
it as authoritative and read-only. Keep it decision-complete: the implementer should never
have to make a product decision.
-->

# NNN — <feature name>

**Status:** draft | approved | implementing | reviewing | accepted
**Owner (design):** Codex
**Implementer:** DeepSeek Harness
**Branch / base:** `<branch>` @ `<commit>`

## 1. Goal

One paragraph: what changes for the user or the system, and why now.

## 2. Success criteria

Observable outcomes. Each one must be checkable by a command or a review step.

- [ ] …
- [ ] …

## 3. Acceptance checks

Exact commands the implementer must run before reporting done. Each must return nonzero
on failure. Include regression coverage for changed behavior where appropriate.

```powershell
# Replace these examples with this project's real commands.
npm run check
npm run build
npm run test:sandbox # Windows DSH: complete suite, not a smoke subset
# Codex independently runs the ordinary suite on a compatible host:
npm test
```

For Node on Windows, read the bridge's `docs/node-testing.md` before choosing commands.
Keep the complete test-file list and real CLI assertions. State the expected test count,
where full logs are saved, and any platform-specific checks. Setup verification is not a
substitute for these project checks. Do not disable confinement to make a test pass.

## 4. Scope

### In scope

- …

### Out of scope

- …

## 5. Design

### Public interfaces

Signatures, routes, CLI flags, events, config keys. State what stays stable.

```ts
// new or changed API
```

### Data and schema

Tables, migrations, persisted shapes, backward compatibility. Say "none" explicitly.

### Flow

Step-by-step behavior for the main path, then each failure path.

### Edge cases

Empty input, concurrent callers, retries, timeouts, partial failure, permissions.

## 6. Implementation plan

File-by-file. This is the checklist the implementer executes.

| File | Change |
|---|---|
| `path/to/file.ts` | … |

Order of work, if it matters:

1. …

## 7. Constraints

- Existing patterns to follow: …
- Patterns to avoid: …
- Dependencies: allowed / not allowed (name them)
- Performance or size budgets: …

## 8. Open questions

Blocking questions only. A non-empty list here means the design is **not** ready to
delegate — resolve it or decide it first.

- [ ] …

## 9. Review notes

Filled in by the design agent after each implementation round: what was accepted, what is
being sent back, and why.

Record actual commands, exit codes, test totals/skips, independent review, and the final
acceptance decision. After requested rework passes, report the phase result to the user.
If the user requested phase pauses, stop here until they authorize the next phase.
