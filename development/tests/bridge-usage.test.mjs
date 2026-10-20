import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test, { after } from 'node:test';

import {
  computeRunUsage,
  finalizeRun,
  normalizeStepUsage,
  parseEventStream,
  usageTerminalLine,
  validateResultRecord,
  validateUsageRecord,
} from '../../dsh-codex-bridge/node/run-report.mjs';

const suiteRoot = mkdtempSync(join(tmpdir(), 'bridge-usage-tests-'));
const suiteRootResolved = resolve(suiteRoot);
const temporaryRootResolved = resolve(tmpdir());
if (!suiteRootResolved.toLowerCase().startsWith(`${temporaryRootResolved.toLowerCase()}${sep}`)) {
  throw new Error(`test fixture escaped the temporary directory: ${suiteRootResolved}`);
}
after(() => {
  rmSync(suiteRootResolved, { recursive: true, force: true });
});

let fileCounter = 0;

function writeEvents(events) {
  const path = join(suiteRoot, `events-${fileCounter++}.jsonl`);
  writeFileSync(
    path,
    `${events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event))).join('\n')}\n`,
    'utf8',
  );
  return path;
}

function step(usage) {
  return { type: 'status', phase: 'step_end', usage };
}

function completedTurn() {
  return { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } };
}

function parsedUsage(events, options = {}) {
  const parsed = parseEventStream(writeEvents(events), '');
  return {
    parsed,
    usage: computeRunUsage(parsed.events, { invocationComplete: true, ...options }),
  };
}

function completeUsage(overrides = {}) {
  return {
    scope: 'RUN',
    source: 'DSH_STEP_END',
    status: 'COMPLETE',
    stepsObserved: 1,
    stepsWithUsage: 1,
    inputTokens: 10,
    inputUncachedTokens: 4,
    inputCacheHitTokens: 6,
    inputCacheMissTokens: 4,
    inputCacheWriteTokens: 0,
    outputTokens: 5,
    reasoningTokens: null,
    totalTokens: 15,
    cacheHitRate: 0.6,
    warnings: [],
    ...overrides,
  };
}

function finalReportFixture() {
  return {
    schemaVersion: 1,
    status: 'DONE',
    summary: 'Fixture result',
    changes: [],
    checks: [],
    decisions: [],
    followUps: [],
  };
}

let finalizeCounter = 0;

function finalizeUsageScenario(name, options = {}) {
  const {
    usage = {
      inputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 2,
      totalTokens: 17,
    },
    exitCode = 0,
    timedOut = false,
    launchFailed = false,
    captureErrors = [],
    includeTurnEnd = true,
    includeFinal = true,
    malformedEvent = false,
  } = options;
  const stem = `finalize-${finalizeCounter++}-${name.replace(/[^a-z0-9-]/gi, '-')}`;
  const eventsPath = join(suiteRoot, `${stem}-events.jsonl`);
  const eventList = [
    { type: 'session', sessionId: `session-${name}` },
    step(usage),
  ];
  if (malformedEvent) eventList.push('{not valid json');
  if (includeTurnEnd) eventList.push(completedTurn());
  if (includeFinal) eventList.push({ type: 'final', text: JSON.stringify(finalReportFixture()) });
  writeFileSync(
    eventsPath,
    `${eventList.map((event) => (typeof event === 'string' ? event : JSON.stringify(event))).join('\n')}\n`,
    'utf8',
  );

  const artifacts = {
    prompt: join(suiteRoot, `${stem}-prompt.md`),
    patch: join(suiteRoot, `${stem}-patch.yml`),
    events: eventsPath,
    stderr: join(suiteRoot, `${stem}-stderr.log`),
    report: join(suiteRoot, `${stem}-report.md`),
    result: join(suiteRoot, `${stem}-result.json`),
    finalText: join(suiteRoot, `${stem}-final.txt`),
    inventoryBefore: join(suiteRoot, `${stem}-inventory-before.json`),
    inventoryAfter: join(suiteRoot, `${stem}-inventory-after.json`),
  };
  const emptyInventory = {
    schemaVersion: 1,
    status: 'OBSERVED',
    reason: null,
    head: null,
    paths: [],
    warnings: [],
  };
  writeFileSync(artifacts.inventoryBefore, JSON.stringify(emptyInventory), 'utf8');
  writeFileSync(artifacts.inventoryAfter, JSON.stringify(emptyInventory), 'utf8');

  return finalizeRun({
    schemaVersion: 1,
    runId: '20261020-120000-abcdef12',
    repoRoot: suiteRoot,
    designPath: 'design.md',
    startedAt: '2026-10-20T00:00:00.000Z',
    completedAt: '2026-10-20T00:00:01.000Z',
    exitCode,
    timedOut,
    launchFailed,
    captureErrors,
    inventoryErrors: [],
    requestedSession: '',
    manifest: { declared: false, checks: [] },
    settings: {
      mode: 'workspace-write',
      model: 'deepseek-official/deepseek-flash',
      reasoningEffort: 'max',
      reasoningEffortSource: 'fixture',
      codexReviewEdits: 'Not Allow',
      codexReviewEditsSource: 'fixture',
      configuration: 'fixture',
      preflightObjectLimit: 28000,
      timeoutMinutes: 90,
    },
    artifacts,
  });
}

function resultWithUsage(usage) {
  return {
    schemaVersion: 1,
    runId: '20261020-120000-abcdef12',
    sessionId: null,
    execution: {
      status: 'SUCCEEDED',
      bridgeExitCode: 0,
      originalExitCode: 0,
      durationMs: 1,
      settings: {},
      usage,
    },
    task: { status: 'DONE' },
    report: { validity: 'VALID', errors: [], warnings: [] },
    acceptance: {
      status: 'PENDING',
      coverage: 'NOT_DECLARED',
      expectedCheckIds: [],
      missingCheckIds: [],
      additionalCheckIds: [],
    },
    observations: { workingTree: {}, tokens: null },
    diagnostics: {},
    artifacts: { result: '.dsh-runs/20261020-120000-abcdef12-result.json' },
  };
}

test('real captured step values use the cache-inclusive input total', () => {
  const { parsed, usage } = parsedUsage([
    { type: 'session', sessionId: 'session-real' },
    step({
      inputTokens: 4888,
      cacheReadTokens: 373888,
      cacheWriteTokens: 0,
      outputTokens: 7507,
      totalTokens: 386283,
    }),
    completedTurn(),
  ]);
  assert.deepEqual(parsed.tokens, { input: 4888, output: 7507 });
  assert.equal(usage.scope, 'RUN');
  assert.equal(usage.source, 'DSH_STEP_END');
  assert.equal(usage.status, 'COMPLETE');
  assert.equal(usage.stepsObserved, 1);
  assert.equal(usage.stepsWithUsage, 1);
  assert.equal(usage.inputTokens, 378776);
  assert.equal(usage.inputUncachedTokens, 4888);
  assert.equal(usage.inputCacheHitTokens, 373888);
  assert.equal(usage.inputCacheMissTokens, 4888);
  assert.equal(usage.inputCacheWriteTokens, 0);
  assert.equal(usage.outputTokens, 7507);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.totalTokens, 386283);
  assert.equal(usage.cacheHitRate, 373888 / 378776);
  assert.deepEqual(usage.warnings, []);
});

test('multiple steps aggregate cache writes, cache hits, and optional reasoning without double counting', () => {
  const { usage } = parsedUsage([
    step({
      inputTokens: 4888,
      cacheReadTokens: 373888,
      cacheWriteTokens: 0,
      outputTokens: 7507,
      reasoningTokens: 100,
      totalTokens: 386283,
    }),
    step({
      inputTokens: 100,
      cacheReadTokens: 50,
      cacheWriteTokens: 25,
      outputTokens: 40,
      reasoningTokens: 10,
      totalTokens: 215,
    }),
    completedTurn(),
  ]);
  assert.equal(usage.status, 'COMPLETE');
  assert.equal(usage.stepsObserved, 2);
  assert.equal(usage.stepsWithUsage, 2);
  assert.equal(usage.inputTokens, 378951);
  assert.equal(usage.inputUncachedTokens, 4988);
  assert.equal(usage.inputCacheHitTokens, 373938);
  assert.equal(usage.inputCacheMissTokens, 5013);
  assert.equal(usage.inputCacheWriteTokens, 25);
  assert.equal(usage.outputTokens, 7547);
  assert.equal(usage.reasoningTokens, 110);
  assert.equal(usage.totalTokens, 386498);
  assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens);
  assert.equal(usage.cacheHitRate, 373938 / 378951);
  assert.deepEqual(usage.warnings, []);
});

test('missing optional cache fields are not invented and use reported-total subtraction', () => {
  const { usage } = parsedUsage([
    step({ inputTokens: 100, outputTokens: 20, totalTokens: 150 }),
    completedTurn(),
  ]);
  assert.equal(usage.status, 'PARTIAL');
  assert.equal(usage.stepsWithUsage, 1);
  assert.equal(usage.inputTokens, 130);
  assert.equal(usage.inputUncachedTokens, 100);
  assert.equal(usage.inputCacheHitTokens, null);
  assert.equal(usage.inputCacheMissTokens, null);
  assert.equal(usage.inputCacheWriteTokens, null);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.reasoningTokens, null);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.cacheHitRate, null);
  assert.equal(usage.warnings.some((warning) => /reasoning/.test(warning)), false);

  const partialCache = parsedUsage([
    step({ inputTokens: 100, cacheReadTokens: 30, outputTokens: 20, totalTokens: 150 }),
    completedTurn(),
  ]).usage;
  assert.equal(partialCache.status, 'PARTIAL');
  assert.equal(partialCache.inputTokens, null);
  assert.equal(partialCache.inputCacheHitTokens, 30);
  assert.equal(partialCache.inputCacheMissTokens, null);
  assert.equal(partialCache.inputCacheWriteTokens, null);
  assert.equal(partialCache.totalTokens, 150);

  const negativeInput = parsedUsage([
    step({ inputTokens: 10, outputTokens: 20, totalTokens: 15 }),
    completedTurn(),
  ]).usage;
  assert.equal(negativeInput.status, 'PARTIAL');
  assert.equal(negativeInput.inputTokens, null);
  assert.equal(negativeInput.totalTokens, null);
  assert.ok(
    negativeInput.warnings.some((warning) => /below the known input\/output components/.test(warning)),
  );

  const impliedNegativeCache = parsedUsage([
    step({ inputTokens: 200, outputTokens: 20, totalTokens: 150 }),
    completedTurn(),
  ]).usage;
  assert.equal(impliedNegativeCache.status, 'PARTIAL');
  assert.equal(impliedNegativeCache.inputTokens, null);
  assert.equal(impliedNegativeCache.totalTokens, null);
  assert.ok(
    impliedNegativeCache.warnings.some(
      (warning) => /below the known input\/output components/.test(warning),
    ),
  );
});

test('a step_end without usage makes all core aggregates unknown, not a subtotal', () => {
  const { parsed, usage } = parsedUsage([
    step({
      inputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 2,
      totalTokens: 17,
    }),
    { type: 'status', phase: 'step_end' },
    completedTurn(),
  ]);
  assert.deepEqual(parsed.tokens, { input: 10, output: 2 });
  assert.equal(usage.status, 'PARTIAL');
  assert.equal(usage.stepsObserved, 2);
  assert.equal(usage.stepsWithUsage, 1);
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.inputUncachedTokens, null);
  assert.equal(usage.inputCacheHitTokens, null);
  assert.equal(usage.inputCacheMissTokens, null);
  assert.equal(usage.inputCacheWriteTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.cacheHitRate, null);
  assert.ok(usage.warnings.some((warning) => /1 of 2 step_end events/.test(warning)));
  assert.ok(usage.warnings.some((warning) => /incomplete/.test(warning)));
});

test('missing input or output leaves independently unknown metrics null', () => {
  const missingInput = parsedUsage([
    step({
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 10,
      totalTokens: 15,
    }),
    completedTurn(),
  ]).usage;
  assert.equal(missingInput.status, 'PARTIAL');
  assert.equal(missingInput.inputTokens, null);
  assert.equal(missingInput.inputUncachedTokens, null);
  assert.equal(missingInput.inputCacheHitTokens, 5);
  assert.equal(missingInput.inputCacheMissTokens, null);
  assert.equal(missingInput.outputTokens, 10);
  assert.equal(missingInput.totalTokens, 15);

  const missingOutput = parsedUsage([
    step({ inputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 }),
    completedTurn(),
  ]).usage;
  assert.equal(missingOutput.status, 'PARTIAL');
  assert.equal(missingOutput.inputTokens, 10);
  assert.equal(missingOutput.inputUncachedTokens, 7);
  assert.equal(missingOutput.inputCacheHitTokens, 3);
  assert.equal(missingOutput.inputCacheMissTokens, 7);
  assert.equal(missingOutput.outputTokens, null);
  assert.equal(missingOutput.totalTokens, null);
});

test('an explicitly reported all-zero sample is valid and distinct from absent usage', () => {
  const zero = parsedUsage([
    step({
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    }),
    completedTurn(),
  ]).usage;
  assert.equal(zero.status, 'COMPLETE');
  assert.equal(zero.stepsWithUsage, 1);
  assert.equal(zero.inputTokens, 0);
  assert.equal(zero.inputUncachedTokens, 0);
  assert.equal(zero.inputCacheHitTokens, 0);
  assert.equal(zero.inputCacheMissTokens, 0);
  assert.equal(zero.inputCacheWriteTokens, 0);
  assert.equal(zero.outputTokens, 0);
  assert.equal(zero.totalTokens, 0);
  assert.equal(zero.cacheHitRate, null);
  assert.deepEqual(zero.warnings, []);

  const absent = parsedUsage([{ type: 'status', phase: 'step_end' }, completedTurn()]).usage;
  assert.equal(absent.status, 'UNAVAILABLE');
  assert.equal(absent.stepsObserved, 1);
  assert.equal(absent.stepsWithUsage, 0);
  assert.equal(absent.inputTokens, null);
  assert.equal(absent.outputTokens, null);
  assert.equal(absent.totalTokens, null);
  assert.equal(absent.cacheHitRate, null);

  const emptyUsage = parsedUsage([step({}), completedTurn()]).usage;
  assert.equal(emptyUsage.status, 'UNAVAILABLE');
  assert.equal(emptyUsage.stepsWithUsage, 0);
});

test('invalid counters stay unknown and generate warnings instead of being repaired', () => {
  const cases = [
    { field: 'inputTokens', value: -1 },
    { field: 'outputTokens', value: 1.5 },
    { field: 'cacheReadTokens', value: '10' },
    { field: 'cacheWriteTokens', value: Number.MAX_SAFE_INTEGER + 1 },
    { field: 'totalTokens', value: null },
    { field: 'reasoningTokens', value: Number.NaN },
  ];
  for (const current of cases) {
    const normalized = normalizeStepUsage({ [current.field]: current.value });
    assert.equal(normalized.usable, false, current.field);
    assert.equal(normalized.metrics[current.field === 'cacheReadTokens'
      ? 'inputCacheHitTokens'
      : current.field === 'cacheWriteTokens'
        ? 'inputCacheWriteTokens'
        : current.field], null, current.field);
    assert.ok(
      normalized.warnings.some((warning) => warning.includes(`usage.${current.field}`)),
      `${current.field} should warn: ${normalized.warnings.join('; ')}`,
    );
  }

  const mixed = normalizeStepUsage({
    inputTokens: -1,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    outputTokens: 1,
    totalTokens: 3,
  });
  assert.equal(mixed.usable, true);
  assert.equal(mixed.metrics.inputUncachedTokens, null);
  assert.equal(mixed.metrics.inputCacheHitTokens, 2);
  assert.equal(mixed.metrics.inputTokens, null);
  assert.equal(mixed.metrics.totalTokens, 3);
  assert.ok(mixed.warnings.some((warning) => /usage\.inputTokens/.test(warning)));
});

test('sum overflow is guarded per step and across steps', () => {
  const stepOverflow = normalizeStepUsage({
    inputTokens: Number.MAX_SAFE_INTEGER,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    outputTokens: 1,
    totalTokens: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(stepOverflow.metrics.inputTokens, null);
  assert.equal(stepOverflow.metrics.inputUncachedTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(stepOverflow.metrics.inputCacheMissTokens, Number.MAX_SAFE_INTEGER);
  assert.ok(stepOverflow.warnings.some((warning) => /safe integer range/.test(warning)));

  const totalOverflow = computeRunUsage(
    [
      step({
        inputTokens: Number.MAX_SAFE_INTEGER - 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: Number.MAX_SAFE_INTEGER,
        totalTokens: Number.MAX_SAFE_INTEGER,
      }),
      completedTurn(),
    ],
    { invocationComplete: true },
  );
  assert.equal(totalOverflow.status, 'PARTIAL');
  assert.equal(totalOverflow.inputTokens, null);
  assert.equal(totalOverflow.outputTokens, Number.MAX_SAFE_INTEGER);
  assert.equal(totalOverflow.totalTokens, null);
  assert.equal(validateUsageRecord(totalOverflow), null);
  assert.ok(
    totalOverflow.warnings.some((warning) => /below the known input\/output components/.test(warning)),
  );

  const aggregateOverflow = computeRunUsage(
    [
      step({
        inputTokens: Number.MAX_SAFE_INTEGER,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: Number.MAX_SAFE_INTEGER,
      }),
      step({
        inputTokens: Number.MAX_SAFE_INTEGER,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        totalTokens: Number.MAX_SAFE_INTEGER,
      }),
      completedTurn(),
    ],
    { invocationComplete: true },
  );
  assert.equal(aggregateOverflow.status, 'PARTIAL');
  assert.equal(aggregateOverflow.inputTokens, null);
  assert.equal(aggregateOverflow.inputUncachedTokens, null);
  assert.equal(aggregateOverflow.totalTokens, null);
  assert.equal(aggregateOverflow.outputTokens, 0);
  assert.ok(
    aggregateOverflow.warnings.some((warning) => /sum exceeds the safe integer range/.test(warning)),
  );
});

test('a reported total that contradicts complete components is warned and nulled', () => {
  const { usage } = parsedUsage([
    step({
      inputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 2,
      totalTokens: 999,
    }),
    completedTurn(),
  ]);
  assert.equal(usage.status, 'PARTIAL');
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.cacheHitRate, null);
  assert.equal(usage.inputUncachedTokens, 10);
  assert.equal(usage.inputCacheHitTokens, 5);
  assert.equal(usage.inputCacheMissTokens, 10);
  assert.equal(usage.outputTokens, 2);
  assert.ok(usage.warnings.some((warning) => /contradicts the complete/.test(warning)));
});

test('review regressions: invalid totals, known lower bounds, and subset contradictions stay unknown', () => {
  const invalidReportedTotal = normalizeStepUsage({
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalTokens: '35',
  });
  assert.equal(invalidReportedTotal.metrics.inputTokens, 30);
  assert.equal(invalidReportedTotal.metrics.outputTokens, 5);
  assert.equal(invalidReportedTotal.metrics.totalTokens, null);
  assert.ok(invalidReportedTotal.warnings.some((warning) => /usage\.totalTokens/.test(warning)));

  const oneCacheMissing = normalizeStepUsage({
    inputTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalTokens: 2,
  });
  assert.equal(oneCacheMissing.metrics.inputTokens, null);
  assert.equal(oneCacheMissing.metrics.totalTokens, null);
  assert.ok(oneCacheMissing.warnings.some((warning) => /below the known input\/output/.test(warning)));

  const overflowLowerBound = normalizeStepUsage({
    inputTokens: Number.MAX_SAFE_INTEGER,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 1,
  });
  assert.equal(overflowLowerBound.metrics.inputTokens, null);
  assert.equal(overflowLowerBound.metrics.totalTokens, null);
  assert.ok(overflowLowerBound.warnings.some((warning) => /below the known input\/output/.test(warning)));

  const belowKnownInput = normalizeStepUsage({
    inputTokens: 10,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    totalTokens: 14,
  });
  assert.equal(belowKnownInput.metrics.inputTokens, null);
  assert.equal(belowKnownInput.metrics.totalTokens, null);
  assert.ok(belowKnownInput.warnings.some((warning) => /below the known input\/output/.test(warning)));

  const validPartialTotal = normalizeStepUsage({
    inputTokens: 10,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalTokens: 20,
  });
  assert.equal(validPartialTotal.metrics.inputTokens, null);
  assert.equal(validPartialTotal.metrics.totalTokens, 20);

  const reasoningAboveOutput = { ...completeUsage(), reasoningTokens: 6 };
  assert.match(validateUsageRecord(reasoningAboveOutput), /reasoningTokens/);

  const hitAboveInput = {
    ...completeUsage(),
    status: 'PARTIAL',
    warnings: ['fixture'],
    inputUncachedTokens: null,
    inputCacheHitTokens: 15,
    inputCacheWriteTokens: null,
    inputCacheMissTokens: null,
    outputTokens: 5,
    totalTokens: 20,
    cacheHitRate: null,
  };
  assert.match(validateUsageRecord(hitAboveInput), /inputCacheHitTokens must not exceed/);

  const missAboveInput = {
    ...completeUsage(),
    status: 'PARTIAL',
    warnings: ['fixture'],
    inputUncachedTokens: null,
    inputCacheHitTokens: null,
    inputCacheWriteTokens: null,
    inputCacheMissTokens: 15,
    outputTokens: 5,
    totalTokens: 20,
    cacheHitRate: null,
  };
  assert.match(validateUsageRecord(missAboveInput), /inputCacheMissTokens must not exceed/);

  const writeAboveInput = {
    ...completeUsage(),
    status: 'PARTIAL',
    warnings: ['fixture'],
    inputUncachedTokens: null,
    inputCacheHitTokens: null,
    inputCacheWriteTokens: 15,
    inputCacheMissTokens: null,
    outputTokens: 5,
    totalTokens: 20,
    cacheHitRate: null,
  };
  assert.match(validateUsageRecord(writeAboveInput), /inputCacheWriteTokens must not exceed/);

  const hitMissMismatch = {
    ...completeUsage(),
    status: 'PARTIAL',
    warnings: ['fixture'],
    inputUncachedTokens: null,
    inputCacheHitTokens: 6,
    inputCacheWriteTokens: null,
    inputCacheMissTokens: 6,
    outputTokens: 5,
    totalTokens: 15,
    cacheHitRate: null,
  };
  assert.match(validateUsageRecord(hitMissMismatch), /cache hit plus cache miss/);

  const totalBelowOutput = { ...completeUsage(), totalTokens: 4 };
  assert.match(validateUsageRecord(totalBelowOutput), /totalTokens must not be smaller than outputTokens/);

  const totalBelowInput = { ...completeUsage(), totalTokens: 9 };
  assert.match(validateUsageRecord(totalBelowInput), /totalTokens must not be smaller than inputTokens/);

  const totalBelowKnownBuckets = {
    ...completeUsage(),
    status: 'PARTIAL',
    warnings: ['fixture'],
    inputTokens: null,
    cacheHitRate: null,
    totalTokens: 5,
  };
  assert.match(
    validateUsageRecord(totalBelowKnownBuckets),
    /totalTokens must not be smaller than known input\/output components/,
  );
});

test('hostile token-field objects warn without crashing aggregation', () => {
  const normalized = normalizeStepUsage({
    inputTokens: JSON.parse('{"toString":null,"valueOf":null}'),
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 5,
    totalTokens: 35,
  });
  assert.equal(normalized.metrics.inputUncachedTokens, null);
  assert.ok(normalized.warnings.some((warning) => /usage\.inputTokens/.test(warning)));

  const usage = computeRunUsage([
    step({
      inputTokens: JSON.parse('{"toString":null,"valueOf":null}'),
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
      outputTokens: 5,
      totalTokens: 35,
    }),
  ]);
  assert.equal(usage.status, 'PARTIAL');
  assert.equal(validateUsageRecord(usage), null);
});

test('reasoning is a subset of output and is never added a second time', () => {
  const valid = parsedUsage([
    step({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 15,
      totalTokens: 30,
    }),
    completedTurn(),
  ]).usage;
  assert.equal(valid.status, 'COMPLETE');
  assert.equal(valid.totalTokens, 30);
  assert.equal(valid.totalTokens, valid.inputTokens + valid.outputTokens);
  assert.equal(valid.reasoningTokens, 15);

  const invalid = parsedUsage([
    step({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: 6,
      totalTokens: 15,
    }),
    completedTurn(),
  ]).usage;
  assert.equal(invalid.status, 'PARTIAL');
  assert.equal(invalid.reasoningTokens, null);
  assert.ok(invalid.warnings.some((warning) => /exceeds outputTokens/.test(warning)));
});

test('failed, timed-out, and capture-incomplete invocations keep counts but stay partial', () => {
  const usage = computeRunUsage(
    [
      step({
        inputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 0,
        outputTokens: 2,
        totalTokens: 17,
      }),
    ],
    {
      invocationComplete: false,
      completenessWarnings: [
        'execution timed out; unreported or in-flight token usage is unknown',
      ],
    },
  );
  assert.equal(usage.status, 'PARTIAL');
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.totalTokens, 17);
  assert.ok(usage.warnings.some((warning) => /timed out/.test(warning)));

  const unavailable = computeRunUsage([], {
    invocationComplete: false,
    completenessWarnings: ['event capture was incomplete; unreported or in-flight token usage is unknown'],
  });
  assert.equal(unavailable.status, 'UNAVAILABLE');
  assert.equal(unavailable.stepsObserved, 0);
  assert.ok(unavailable.warnings.some((warning) => /capture/.test(warning)));
});

test('finalizeRun maps failure, timeout, capture, and missing completion facts to PARTIAL usage', () => {
  const cases = [
    {
      name: 'failure',
      options: { exitCode: 7 },
      expected: {
        executionStatus: 'FAILED',
        bridgeExitCode: 7,
        reportValidity: 'VALID',
        taskStatus: 'DONE',
      },
    },
    {
      name: 'timeout',
      options: { exitCode: null, timedOut: true },
      expected: {
        executionStatus: 'TIMEOUT',
        bridgeExitCode: 124,
        reportValidity: 'VALID',
        taskStatus: 'DONE',
      },
    },
    {
      name: 'capture-error',
      options: { captureErrors: ['injected capture error'] },
      expected: {
        executionStatus: 'SUCCEEDED',
        bridgeExitCode: 65,
        reportValidity: 'INVALID',
        taskStatus: 'UNKNOWN',
      },
    },
    {
      name: 'malformed-event',
      options: { malformedEvent: true },
      expected: {
        executionStatus: 'SUCCEEDED',
        bridgeExitCode: 65,
        reportValidity: 'INVALID',
        taskStatus: 'UNKNOWN',
      },
    },
    {
      name: 'missing-completion',
      options: { includeTurnEnd: false, includeFinal: false },
      expected: {
        executionStatus: 'SUCCEEDED',
        bridgeExitCode: 65,
        reportValidity: 'MISSING',
        taskStatus: 'UNKNOWN',
      },
    },
    {
      name: 'telemetry-only-warning',
      options: {
        usage: {
          inputTokens: 10,
          cacheReadTokens: 5,
          cacheWriteTokens: 0,
          outputTokens: 2,
          totalTokens: '17',
        },
      },
      expected: {
        executionStatus: 'SUCCEEDED',
        bridgeExitCode: 0,
        reportValidity: 'VALID',
        taskStatus: 'DONE',
      },
      expectedTotal: null,
    },
  ];

  for (const current of cases) {
    const outcome = finalizeUsageScenario(current.name, current.options);
    assert.equal(
      outcome.result.execution.status,
      current.expected.executionStatus,
      current.name,
    );
    assert.equal(
      outcome.result.execution.bridgeExitCode,
      current.expected.bridgeExitCode,
      current.name,
    );
    assert.equal(outcome.bridgeExitCode, current.expected.bridgeExitCode, current.name);
    assert.equal(outcome.result.report.validity, current.expected.reportValidity, current.name);
    assert.equal(outcome.result.task.status, current.expected.taskStatus, current.name);
    assert.equal(outcome.result.execution.usage.status, 'PARTIAL', current.name);
    assert.equal(outcome.result.execution.usage.stepsObserved, 1, current.name);
    assert.equal(outcome.result.execution.usage.stepsWithUsage, 1, current.name);
    assert.equal(outcome.result.execution.usage.inputTokens, 15, current.name);
    assert.equal(outcome.result.execution.usage.outputTokens, 2, current.name);
    assert.equal(
      outcome.result.execution.usage.totalTokens,
      Object.hasOwn(current, 'expectedTotal') ? current.expectedTotal : 17,
      current.name,
    );
    assert.ok(outcome.result.execution.usage.warnings.length > 0, current.name);
    assert.equal(validateUsageRecord(outcome.result.execution.usage), null, current.name);
    for (const warning of outcome.result.execution.usage.warnings) {
      assert.equal(
        outcome.result.report.warnings.includes(warning),
        false,
        `${current.name}: telemetry warning leaked into report warnings`,
      );
    }
  }
});

test('usage on non-step_end events is ignored and does not contribute twice', () => {
  const { usage } = parsedUsage([
    { type: 'status', phase: 'step_start', usage: { inputTokens: 999, outputTokens: 999 } },
    { type: 'text', usage: { inputTokens: 999, outputTokens: 999 } },
    step({
      inputTokens: 10,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      outputTokens: 2,
      totalTokens: 17,
    }),
    { type: 'status', phase: 'turn_end', usage: { inputTokens: 999, outputTokens: 999 } },
  ]);
  assert.equal(usage.stepsObserved, 1);
  assert.equal(usage.inputTokens, 15);
  assert.equal(usage.inputUncachedTokens, 10);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.totalTokens, 17);
});

test('two runs sharing a sessionId are parsed separately without accumulation', () => {
  const first = parsedUsage([
    { type: 'session', sessionId: 'shared-session' },
    step({
      inputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      totalTokens: 15,
    }),
    completedTurn(),
  ]);
  const second = parsedUsage([
    { type: 'session', sessionId: 'shared-session' },
    step({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 50,
      totalTokens: 150,
    }),
    completedTurn(),
  ]);
  assert.equal(first.parsed.sessionId, 'shared-session');
  assert.equal(second.parsed.sessionId, 'shared-session');
  assert.equal(first.usage.inputTokens, 10);
  assert.equal(second.usage.inputTokens, 100);
  assert.equal(first.usage.outputTokens, 5);
  assert.equal(second.usage.outputTokens, 50);
  assert.equal(first.usage.totalTokens, 15);
  assert.equal(second.usage.totalTokens, 150);
});

test('new results validate and legacy results without execution.usage stay readable', () => {
  const usage = completeUsage();
  assert.equal(validateUsageRecord(usage), null);
  assert.equal(validateResultRecord(resultWithUsage(usage)), null);

  const legacy = resultWithUsage(undefined);
  delete legacy.execution.usage;
  assert.equal(validateResultRecord(legacy), null);

  const invalidCases = [
    { mutate: (value) => { value.status = 'UNKNOWN'; }, pattern: /status must be one of/ },
    { mutate: (value) => { value.scope = 'SESSION'; }, pattern: /scope must be "RUN"/ },
    { mutate: (value) => { value.source = 'OTHER'; }, pattern: /source must be "DSH_STEP_END"/ },
    { mutate: (value) => { value.stepsObserved = 1.5; }, pattern: /stepsObserved/ },
    { mutate: (value) => { value.stepsWithUsage = 2; }, pattern: /stepsWithUsage must not exceed/ },
    { mutate: (value) => { value.inputTokens = -1; }, pattern: /inputTokens/ },
    { mutate: (value) => { value.cacheHitRate = 1.5; }, pattern: /cacheHitRate/ },
    { mutate: (value) => { value.warnings = ['ok', 1]; }, pattern: /warnings/ },
    {
      mutate: (value) => {
        value.status = 'COMPLETE';
        value.inputTokens = null;
      },
      pattern: /COMPLETE requires inputTokens/,
    },
    {
      mutate: (value) => {
        value.status = 'COMPLETE';
        value.warnings = ['inconsistent'];
      },
      pattern: /COMPLETE requires no warnings/,
    },
    {
      mutate: (value) => {
        value.status = 'UNAVAILABLE';
        value.stepsWithUsage = 0;
      },
      pattern: /UNAVAILABLE requires null token metrics/,
    },
    {
      mutate: (value) => { value.totalTokens = value.inputTokens + value.outputTokens + 1; },
      pattern: /totalTokens does not match/,
    },
    {
      mutate: (value) => { value.inputCacheHitTokens = 7; },
      pattern: /totalTokens must not be smaller|inputTokens (does not match|is smaller)/,
    },
    {
      mutate: (value) => { value.cacheHitRate = 0.5; },
      pattern: /cacheHitRate does not match/,
    },
  ];
  for (const current of invalidCases) {
    const record = resultWithUsage(completeUsage());
    current.mutate(record.execution.usage);
    assert.match(validateResultRecord(record), current.pattern);
  }
});

test('terminal rendering uses canonical values and labels the legacy fallback', () => {
  const canonical = usageTerminalLine({
    execution: { usage: completeUsage() },
    observations: { tokens: { input: 4, output: 5 } },
  });
  assert.match(canonical, /^token usage \(RUN, DSH_STEP_END, COMPLETE\)/);
  assert.match(
    canonical,
    /input total 10 \(uncached 4, cache hit 6, cache miss 4 including write 0\)/,
  );
  assert.match(
    canonical,
    /output 5 \(reasoning not reported; included in output when reported, never added again\)/,
  );
  assert.match(canonical, /total 15/);
  assert.match(canonical, /cache hit rate 60\.00%/);

  const legacy = usageTerminalLine({ observations: { tokens: { input: 10, output: 5 } } });
  assert.match(legacy, /^token usage: legacy result without execution\.usage/);
  assert.match(legacy, /raw input\/output: 10 in \/ 5 out tokens/);
  assert.match(legacy, /deprecated/);
  assert.match(legacy, /no cache-inclusive total is available/);

  const legacyMissing = usageTerminalLine({ observations: { tokens: null } });
  assert.match(legacyMissing, /raw input\/output not reported/);
  assert.match(legacyMissing, /no cache-inclusive total/);
});
