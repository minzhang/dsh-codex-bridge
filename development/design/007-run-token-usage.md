# Runtime token usage in one-way reports

Status: accepted after independent Codex verification on 2026-10-20.

## Goal and placement

The user requests input total, cache hit, cache miss, output and related token usage
whenever a DSH invocation finishes. Keep one-way reporting. Token accounting is execution
metadata, not a business result or a model-authored claim.

The canonical location is `result.json` -> `execution.usage`. Render the same object in a
separate `Token usage` subsection of the Markdown execution information and a concise
terminal summary. MCP already returns the canonical result; expose the same metadata there.
Do not create a second usage document, modify the implementer's final JSON contract, ask
the model to estimate usage, or add token data to `task`.

Scope is this bridge invocation (`RUN`), associated with existing runId/sessionId. A resumed
session has several runs. Do not claim this is a lifetime session total or scan prior runs
or private session storage. This explicit scope prevents double-counting and incomplete
history from being presented as complete accounting. It includes every reported step in
this invocation, including provider attempts already accumulated by DSH.
These are sums across model calls, so repeated/cached context is counted on each call;
they are not the number of distinct tokens or the context-window size.

The user's latest instruction overrides the usual full-suite rule: **run only affected
tests**. Do not run full bridge, Windows ACL/object-count, demo, build or lifecycle suites.

## Source evidence and normalization

Read only `status` / `phase: step_end` events from this run's captured JSONL. Other events
may also contain usage but must not contribute again. Installed DSH 0.2.1-rc.2:

- `dsh-headless/lib/json-stream-*.js` accumulates attempts per step; missing attempt usage
  suppresses the entire step usage; optional buckets are emitted only when every attempt
  supplied them. Its projection subscribes to this invocation, not session history.
- `dsh-llm-deepseek/lib/index.js` maps input_tokens -> inputTokens,
  cache_read_input_tokens -> cacheReadTokens and cache_creation_input_tokens ->
  cacheWriteTokens. Its total is input + output + cacheRead + cacheWrite.
- `dsh-llm-pi-ai/lib/index.js` folds reasoning into output. Optional cache fields can be
  absent. Therefore absence cannot universally be treated as zero.
- A real captured step reports inputTokens 4888, cacheReadTokens 373888,
  cacheWriteTokens 0, outputTokens 7507, totalTokens 386283. Correct input total is
  378776; the old display counted only 4888.

No production code may depend on an installed source path. No credentials or raw agent
transcripts enter Git.

Add this object to every newly generated result (including unavailable/failed runs):

```json
{
  "scope": "RUN",
  "source": "DSH_STEP_END",
  "status": "COMPLETE | PARTIAL | UNAVAILABLE",
  "stepsObserved": 0,
  "stepsWithUsage": 0,
  "inputTokens": null,
  "inputUncachedTokens": null,
  "inputCacheHitTokens": null,
  "inputCacheMissTokens": null,
  "inputCacheWriteTokens": null,
  "outputTokens": null,
  "reasoningTokens": null,
  "totalTokens": null,
  "cacheHitRate": null,
  "warnings": []
}
```

All token counts are nonnegative safe integers or null. Rate is 0..1 or null (zero input
has no rate). Status and warnings concern telemetry quality, not task acceptance.

Per step:

- inputUncachedTokens = DSH inputTokens, excluding both cache buckets.
- inputCacheHitTokens = cacheReadTokens.
- inputCacheWriteTokens = cacheWriteTokens.
- inputCacheMissTokens = inputUncachedTokens + inputCacheWriteTokens.
- inputTokens = uncached + hit + write.
- outputTokens = DSH outputTokens; reasoningTokens, when supplied, is a subset and must
  never be added a second time.
- totalTokens = inputTokens + outputTokens. If all components are valid, derive missing
  totalTokens. When a valid reported total and output exist but cache components are
  absent, inputTokens may be derived by subtraction; do not invent the missing cache
  breakdown. Never infer a negative value.
- A reported total that contradicts available complete components must generate a warning;
  use null for the contradictory derived input/total/rate instead of choosing an arbitrary
  number. Invalid present values (negative, fractional, strings, unsafe integers, null,
  etc.) stay unknown, generate warnings, and are not repaired by alternative arithmetic.
- Missing optional reasoning is simply null and does not by itself make status PARTIAL.
  Reasoning greater than output is invalid and warned.

Aggregate each metric across step_end events only when that metric is known for *every*
observed step. A missing/invalid step field means null for that aggregate, not an apparently
complete subtotal. Guard sum overflow. Preserve independently known metrics. Missing usage
and an entirely absent stream are not zero usage. An explicitly reported all-zero sample
is valid and distinct from no sample. Compute run hit rate from aggregate hit / input.

COMPLETE requires all core buckets/totals (everything except reasoning/rate for zero input)
known, no accounting warnings, and a fully captured normally completed invocation.
PARTIAL means some usage was reported but required data or execution/capture completeness
is missing. UNAVAILABLE means no usable token counts. For timeouts, failures, capture
errors, malformed events or missing completion, keep available observed counts but label
them PARTIAL and explain that unreported/in-flight usage is unknown. Completion quality
can be finalized using existing facts and turn_end. Do not change exit-code, task/report
validity or acceptance rules just because telemetry is absent or inconsistent.

Compatibility: keep schemaVersion 1 (additive) and preserve `observations.tokens` with its
existing legacy raw-input/output meaning for old consumers and existing assertions. Mark
it deprecated in docs; new human/MCP summaries use execution.usage. Accept old result
records without execution.usage. When present, validate the new object's schema, types,
enum values, counts/rate bounds, warnings and basic consistency before MCP returns it.
Legacy records must render safely with clearly labeled legacy raw-input fallback, without
claiming a cache-inclusive total. Do not silently turn missing new usage into zero.

## Presentation

Markdown and terminal must identify RUN scope, completeness and all requested breakdowns.
Use readable counts; null says `not reported` (rate can say `not available`). Label cache
write as included in cache miss; label reasoning as included in output. Do not add them
again in a human total. Retain artifact pointers and other outcome/diagnostic sections.
Warnings should be visible without overwhelming the normal successful summary.
MCP structuredContent retains execution.usage; textual summary uses the same values.

## Permitted changes

- `dsh-codex-bridge/node/run-report.mjs`: aggregation, canonical record, rendering, validation.
- `dsh-codex-bridge/mcp/dsh-mcp-server.mjs` only if required for consistent presentation.
- `development/tests/bridge-usage.test.mjs`: new focused parser/aggregation/validation tests.
- `development/tests/bridge-report.test.mjs`: focused integration assertions using its real
  PowerShell/Node/Git child fixtures, including Markdown/stdout/MCP propagation.
- `package.json`: add the new test file to both existing normal/sandbox lists identically.
- `dsh-codex-bridge/README.md`: public schema, counting semantics, scope and legacy notes.

Codex owns this design, `development/README.md` indexing and `development/reviews.md`.
No new dependencies, CLI switches, database/ledger, pricing estimates, UI, demo changes,
auth/profile edits, sandbox changes or publication by DSH.

## Acceptance

Preserve existing assertions. New cases must include multiple steps, real captured field
values above, cache writes, cache hits, missing optional cache fields, missing entire step
usage, missing input/output, all-zero vs absent, invalid counters, overflow, inconsistent
totals, optional reasoning without double-counting, failure/timeout/capture quality,
non-step usage ignored, and separate parses for two runs sharing a sessionId without
accumulation. Verify new-result validation and old-result compatibility.

Use affected component suites only:

<!-- dsh-acceptance-start -->
[
  {
    "id": "A1",
    "command": "node dsh-codex-bridge/node/run-tests.mjs development/tests/bridge-usage.test.mjs",
    "cwd": "."
  },
  {
    "id": "A2",
    "command": "node --check dsh-codex-bridge/node/run-report.mjs",
    "cwd": "."
  },
  {
    "id": "A3",
    "command": "git diff --check",
    "cwd": "."
  }
]
<!-- dsh-acceptance-end -->

Final fixture-only follow-up: the implementation and functional rework already passed
the combined no-worker command with both bridge-usage.test.mjs and bridge-report.test.mjs
(39 tests, zero failures/skips), logged in `.dsh-runs/usage-rework-checks/a1.log`.
Only finding 8 remains. For this last DSH follow-up, A1 above is narrowed to the affected
usage test file, since no production or report-integration code may change in this round.
Retain the completed combined result. Codex still runs the final ordinary suite on both
affected files, as stated below. Do not rerun other component/full suites.

Store full command logs locally under `.dsh-runs/usage-checks/`, report actual exit codes
and log paths in the required single JSON final report. Leave all changes uncommitted.
Use Flash/max/workspace-write, normal Windows preflight, no-worker test execution.

Codex independently runs the ordinary Node runner on these same two files and checks the
actual implementation run's final usage against its captured step events. This live
implementation invocation is the live integration evidence; do not launch another task
solely to consume tokens. Review/fix using the same new DSH session. After acceptance,
record results and publish the authorized change to GitHub.

## Independent review findings

Codex's ignored `.dsh-runs/usage-review/edge-probes.mjs` reproduced these issues in the
first implementation draft. Correct them and add maintained regressions without weakening
any existing assertions:

1. Present but invalid `totalTokens: "35"` with otherwise valid 10 uncached, 20 hit,
   0 write, 5 output currently becomes total 35. Invalid present fields must remain null;
   only absent totals may be derived.
2. With uncached 10, absent cache read, write 0, output 5, reported total 2, total 2
   survives. Check known-component lower bounds even when only one cache bucket is
   missing. A total below output or known input/output buckets is contradictory.
3. With uncached MAX_SAFE_INTEGER, hit 1, write 0, output 0, total 1, input becomes null
   for overflow but total 1 survives. Overflow or impossible lower bounds must not leave
   a contradictory total/rate. Prefer safe subtraction comparisons or BigInt internally
   for bounds; do not publish unsafe numeric counters.
4. validateUsageRecord accepts an otherwise complete record with reasoning 6 and output 5.
   Reject this and analogous basic subset contradictions (hit/miss/write vs known parent
   totals) before returning canonical metadata through MCP.
5. The initial failure-quality unit test supplies `invocationComplete: false` directly.
   Also exercise finalization with fully known usage and failure, timeout, malformed
   capture and missing completion facts/events, so the mapping from real run facts to
   PARTIAL is tested. Verify valid task claims/exit rules are unaffected by telemetry-only
   warnings.
6. Always include the canonical usage line in MCP's `[canonical result]` section. Do not
   suppress it just because captured stdout contains a `token usage` prefix; stdout can
   contain raw model text. An old result with such text still needs the explicit legacy
   fallback, and new results should summarize the validated metadata.
7. Malformed JSON counter values must not crash diagnostics. The additional edge probe
   supplies `inputTokens: {"toString": null, "valueOf": null}`; converting it with
   `String(value)` throws. Describe JSON values safely, keep the counter unknown and
   preserve the result/report. Include object/array/boolean invalid-value regressions.
   The public validator must also enforce the known-component total lower bound when
   inputTokens is null (for example uncached 10, hit 20, write 0, output 5, total 5).
   This extends finding 4's subset consistency check to incomplete records.
8. Before executing the new usage test's recursive fixture cleanup, explicitly resolve
   and verify its unique suiteRoot remains under the host temp root, following the
   existing guard in bridge-report.test.mjs. Root instructions require bounded Windows
   deletion. This is a small fixture correction, not Windows setup testing.

## Final acceptance

DSH addressed all findings in the same session, retaining Flash/max, workspace-write and
normal Windows preflight. The combined affected no-worker suite passed 39 tests with no
failures/skips. After the final fixture-only correction, the affected usage suite passed
all 18 tests. The report integration suite and production code were unchanged in that
last round; its earlier completed sandbox result was retained.

Codex independently ran the ordinary Node suite on both affected files on the final
source: 39 passed, zero failures/skips. SHA-256 hashes of eight runtime/configuration/test
files were unchanged across that run. Six independent edge probes and 2,160 combinations
of valid, missing and invalid counters passed. Real result metadata from all three DSH
invocations (87, 55 and 6 steps) matched their captured event counters independently.
The resumed invocations contain only their own usage, not earlier session totals.

Only affected tests were run for this change, as explicitly requested by the user.
No full bridge, Windows, demo or lifecycle suites were run for this acceptance.
Syntax/whitespace checks passed. Evidence remains local and ignored under `.dsh-runs/usage-*`;
the durable acceptance record is in `../reviews.md`.

These are telemetry-only corrections; malformed counters must not invalidate a valid
implementer business report. Re-run only the affected acceptance commands after fixes.
