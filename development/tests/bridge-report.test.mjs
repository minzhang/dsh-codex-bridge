import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { captureProcess } from '../../dsh-codex-bridge/node/capture-process.mjs';
import { finalizeRun } from '../../dsh-codex-bridge/node/run-report.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeSource = join(repoRoot, 'dsh-codex-bridge', 'dsh-impl.ps1');
const helperSource = join(repoRoot, 'dsh-codex-bridge', 'node', 'run-report.mjs');
const configSource = join(repoRoot, 'dsh-codex-bridge', 'bridge.config.json');
const mcpSource = join(repoRoot, 'dsh-codex-bridge', 'mcp', 'dsh-mcp-server.mjs');

const suiteRoot = mkdtempSync(join(tmpdir(), 'bridge-report-tests-'));
const suiteRootResolved = resolve(suiteRoot);
const temporaryRootResolved = resolve(tmpdir());
if (!suiteRootResolved.toLowerCase().startsWith(`${temporaryRootResolved.toLowerCase()}${sep}`)) {
  throw new Error(`test fixture escaped the temporary directory: ${suiteRootResolved}`);
}
const cleanupJunctions = [];
after(() => {
  // rmdir (not recursive rm) removes a directory junction without touching its target.
  for (const junction of cleanupJunctions) {
    try {
      rmdirSync(junction);
    } catch {
      try {
        unlinkSync(junction);
      } catch {}
    }
  }
  rmSync(suiteRootResolved, { recursive: true, force: true });
});

const FAKE_RUN_ID = '20261020-120000-abcdef12';

function caseDirectory(name) {
  const directory = join(suiteRoot, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(repo, args) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    stdio: 'ignore',
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${repo}`);
}

function initGitRepo(repo) {
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'fixture@example.test']);
  git(repo, ['config', 'user.name', 'Fixture']);
}

function commitAll(repo) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', 'fixture']);
}

function writeDesign(repo, { manifest = null, rawManifest = null, extra = '' } = {}) {
  let block = '';
  if (rawManifest !== null) {
    block = `\n<!-- dsh-acceptance-start -->\n${rawManifest}\n<!-- dsh-acceptance-end -->\n`;
  } else if (manifest !== null) {
    block = `\n<!-- dsh-acceptance-start -->\n${JSON.stringify(manifest, null, 2)}\n<!-- dsh-acceptance-end -->\n`;
  }
  writeText(
    join(repo, 'design.md'),
    `# Fixture design\n\nImplement the fixture behavior.\n\n${extra}${block}`,
  );
}

function copyBridgePackage(name) {
  const directory = caseDirectory(name);
  const packageDirectory = join(directory, 'bridge');
  mkdirSync(join(packageDirectory, 'node'), { recursive: true });
  mkdirSync(join(packageDirectory, 'mcp'), { recursive: true });
  copyFileSync(bridgeSource, join(packageDirectory, 'dsh-impl.ps1'));
  copyFileSync(helperSource, join(packageDirectory, 'node', 'run-report.mjs'));
  copyFileSync(configSource, join(packageDirectory, 'bridge.config.json'));
  copyFileSync(mcpSource, join(packageDirectory, 'mcp', 'dsh-mcp-server.mjs'));
  cpSync(join(repoRoot, 'dsh-codex-bridge', 'windows', 'lib'), join(packageDirectory, 'windows', 'lib'), { recursive: true });
  const fakeDir = join(directory, 'fake-dsh');
  mkdirSync(fakeDir, { recursive: true });
  const fakeScript = join(fakeDir, 'fake-dsh.cjs');
  writeText(
    fakeScript,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const { execFileSync, spawnSync } = require('node:child_process');",
      "const scenarioPath = process.env.FAKE_DSH_SCENARIO;",
      "if (!scenarioPath) { process.stderr.write('missing FAKE_DSH_SCENARIO\\n'); process.exit(2); }",
      "const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));",
      "const repo = scenario.repo || process.cwd();",
      "const repoRoot = path.resolve(repo);",
      "const fixtureRoot = path.resolve(scenario.fixtureRoot || repo);",
      "const withinFixture = (relative) => {",
      "  const target = path.resolve(repo, relative);",
      "  if (target !== repoRoot && !target.startsWith(repoRoot + path.sep)) throw new Error('fixture path escaped repo');",
      '  return target;',
      '};',
      "fs.readFileSync(0, 'utf8');",
      'const write = (relative, content) => {',
      '  const target = withinFixture(relative);',
      '  fs.mkdirSync(path.dirname(target), { recursive: true });',
      "  fs.writeFileSync(target, content ?? '');",
      '};',
      'for (const mutation of scenario.mutations || []) {',
      "  if (mutation.op === 'write') write(mutation.path, mutation.content);",
      "  else if (mutation.op === 'delete') fs.rmSync(withinFixture(mutation.path), { force: true });",
      "  else if (mutation.op === 'rename') fs.renameSync(withinFixture(mutation.from), withinFixture(mutation.to));",
      "  else if (mutation.op === 'mkdir') fs.mkdirSync(withinFixture(mutation.path), { recursive: true });",
      "  else if (mutation.op === 'stage') execFileSync('git', ['-C', repo, 'add', '--', mutation.path], { stdio: 'ignore' });",
      "  else if (mutation.op === 'junction') {",
      '    const linkPath = withinFixture(mutation.path);',
      '    const target = path.resolve(mutation.target);',
      "    if (target !== fixtureRoot && !target.startsWith(fixtureRoot + path.sep)) throw new Error('junction target escaped fixture root');",
      '    fs.mkdirSync(path.dirname(linkPath), { recursive: true });',
      "    const created = process.platform === 'win32'",
      "      ? spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { stdio: 'ignore', windowsHide: true })",
      "      : spawnSync('ln', ['-s', target, linkPath], { stdio: 'ignore', windowsHide: true });",
      "    if (!created || created.status !== 0) throw new Error('junction creation failed');",
      "    if (mutation.marker) fs.writeFileSync(mutation.marker, 'created');",
      '  }',
      "  else throw new Error(`unknown mutation: ${mutation.op}`);",
      '}',
      "if (scenario.capturePath) fs.writeFileSync(scenario.capturePath, 'launched');",
      "if (scenario.sessionId) process.stdout.write(JSON.stringify({ type: 'session', sessionId: scenario.sessionId }) + '\\n');",
      'for (const event of scenario.events || []) {',
      "  process.stdout.write((typeof event === 'string' ? event : JSON.stringify(event)) + '\\n');",
      '}',
      'if (!scenario.omitFinal) {',
      "  const text = typeof scenario.final === 'string' ? scenario.final : JSON.stringify(scenario.final ?? '');",
      "  process.stdout.write(JSON.stringify({ type: 'final', text }) + '\\n');",
      '}',
      "if (scenario.error) process.stdout.write(JSON.stringify({ type: 'error', message: scenario.error }) + '\\n');",
      'process.exit(scenario.exitCode ?? 0);',
      '',
    ].join('\n'),
  );
  const nodePath = process.execPath;
  let launcher;
  if (process.platform === 'win32') {
    launcher = join(fakeDir, 'dsh.cmd');
    writeText(
      launcher,
      `@echo off\r\n"${nodePath}" "${fakeScript}" %*\r\nexit /b %ERRORLEVEL%\r\n`,
    );
  } else {
    launcher = join(fakeDir, 'dsh');
    writeText(launcher, `#!/bin/sh\nexec "${nodePath}" "${fakeScript}" "$@"\n`);
    chmodSync(launcher, 0o755);
  }
  return {
    directory,
    packageDirectory,
    bridge: join(packageDirectory, 'dsh-impl.ps1'),
    mcp: join(packageDirectory, 'mcp', 'dsh-mcp-server.mjs'),
    fakeDir,
    launcher,
  };
}

function writeScenario(pkg, scenario) {
  const path = join(pkg.directory, `scenario-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  writeText(path, JSON.stringify({ ...scenario, repo: scenario.repo }));
  return path;
}

function wrapBridgeWithExplicitDsh(pkg) {
  // The DSH Windows sandbox resets PATH for confined descendants. MCP intentionally
  // has no dsh-path argument, so this fixture wrapper keeps the real bridge while
  // pinning the actual subprocess launcher explicitly.
  const realBridge = join(pkg.packageDirectory, 'dsh-impl-real.ps1');
  renameSync(pkg.bridge, realBridge);
  writeText(
    pkg.bridge,
    [
      `& (Join-Path $PSScriptRoot 'dsh-impl-real.ps1') @args -Dsh '${pkg.launcher}'`,
      'exit $LASTEXITCODE',
      '',
    ].join('\n'),
  );
}

async function runBridge(pkg, repo, scenario, extraArgs = [], options = {}) {
  const scenarioPath = writeScenario(pkg, { ...scenario, repo });
  const args = [
    '-Repo',
    repo,
    '-Spec',
    scenario.spec ?? 'design.md',
    '-OutDir',
    '.dsh-runs',
    '-SkipWindowsPreflight',
    ...extraArgs,
  ];
  if (options.launcher !== false) {
    args.push('-Dsh', options.launcher ?? pkg.launcher);
  }
  return captureProcess(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', pkg.bridge, ...args],
    {
      env: { ...process.env, FAKE_DSH_SCENARIO: scenarioPath },
      timeoutMs: 120_000,
    },
  );
}

function summaryPrefix(stdout) {
  return stdout.split(/^--- implementer final message/m)[0];
}

function outputLine(stdout, prefix) {
  const line = summaryPrefix(stdout)
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function readResultFromOutput(repo, stdout) {
  const relativePath = outputLine(stdout, 'result: ');
  assert.ok(relativePath, `missing result: line:\n${stdout}`);
  const resultPath = resolve(repo, relativePath);
  assert.ok(existsSync(resultPath), `result file does not exist: ${resultPath}`);
  return { path: resultPath, result: readJson(resultPath), relativePath };
}

function makeCheck(overrides = {}) {
  return {
    id: 'A1',
    command: 'npm run test:sandbox',
    cwd: '.',
    status: 'PASS',
    exitCode: 0,
    logPath: '.dsh-runs/report-checks/a1.log',
    reason: '',
    ...overrides,
  };
}

function makeReport(overrides = {}) {
  return {
    schemaVersion: 1,
    status: 'DONE',
    summary: 'Fixture result ready for review',
    changes: [],
    checks: [],
    decisions: [],
    followUps: [],
    ...overrides,
  };
}

function makeScenario(report, overrides = {}) {
  return {
    sessionId: 'session-fixture',
    events: [
      { type: 'tool_call', input: { path: 'fixture.txt' } },
      { type: 'tool_result', status: 'error' },
      { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
    ],
    final: report,
    ...overrides,
  };
}

function logMutation(id, relativePath = null) {
  return {
    op: 'write',
    path: relativePath ?? `.dsh-runs/report-checks/${id.toLowerCase()}.log`,
    content: `full log for ${id}\n`,
  };
}

function validResultObject(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: FAKE_RUN_ID,
    sessionId: null,
    sessionProvenance: null,
    design: { path: 'design.md' },
    timestamps: {
      startedAt: '2026-10-20T00:00:00.000Z',
      completedAt: '2026-10-20T00:00:01.000Z',
    },
    execution: {
      status: 'SUCCEEDED',
      originalExitCode: 0,
      bridgeExitCode: 0,
      durationMs: 1000,
      settings: {},
    },
    task: {
      status: 'DONE',
      claimedStatus: 'DONE',
      summary: 'fixture',
      changes: [],
      checks: [],
      decisions: [],
      followUps: [],
    },
    report: {
      validity: 'VALID',
      errors: [],
      warnings: [],
      rawTextArtifact: null,
      legacyStatus: false,
    },
    acceptance: {
      status: 'PENDING',
      coverage: 'NOT_DECLARED',
      expectedCheckIds: [],
      missingCheckIds: [],
      additionalCheckIds: [],
    },
    observations: {
      workingTree: {
        status: 'UNAVAILABLE',
        reason: 'fixture',
        headBefore: null,
        headAfter: null,
        paths: [],
        warnings: [],
      },
      toolCalls: 0,
      toolErrors: 0,
      tokens: null,
      implementerClaimedChanges: [],
    },
    diagnostics: {
      malformedEventLines: { count: 0, lineNumbers: [] },
      lastValidEvent: null,
      turnEnd: null,
      error: null,
      captureErrors: [],
      inventoryErrors: [],
      stderrArtifact: '',
    },
    artifacts: {
      result: `.dsh-runs/${FAKE_RUN_ID}-result.json`,
      report: `.dsh-runs/${FAKE_RUN_ID}-report.md`,
    },
    ...overrides,
  };
}

function runMcpWithFileStdio(serverPath, messages, env, cwd) {
  const directory = mkdtempSync(join(suiteRoot, 'mcp-stdio-'));
  const inputPath = join(directory, 'stdin.jsonl');
  const outputPath = join(directory, 'stdout.jsonl');
  const errorPath = join(directory, 'stderr.log');
  writeText(inputPath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);

  return new Promise((resolvePromise, rejectPromise) => {
    const inputFd = openSync(inputPath, 'r');
    const outputFd = openSync(outputPath, 'w');
    const errorFd = openSync(errorPath, 'w');
    let child;
    try {
      child = spawn(process.execPath, [serverPath], {
        cwd,
        env: { ...process.env, ...env },
        stdio: [inputFd, outputFd, errorFd],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      for (const fd of [inputFd, outputFd, errorFd]) {
        try {
          closeSync(fd);
        } catch {}
      }
      rejectPromise(error);
      return;
    }
    for (const fd of [inputFd, outputFd, errorFd]) {
      try {
        closeSync(fd);
      } catch {}
    }
    let settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      action();
    };
    child.once('error', (error) => settle(() => rejectPromise(error)));
    child.once('close', (code) => {
      let stdout = '';
      let stderr = '';
      try {
        stdout = readFileSync(outputPath, 'utf8');
      } catch {}
      try {
        stderr = readFileSync(errorPath, 'utf8');
      } catch {}
      settle(() => resolvePromise({ code, stdout, stderr }));
    });
  });
}

async function callMcpTool(pkg, repo, cwd, args, envExtra = {}) {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: args },
    },
  ];
  const result = await runMcpWithFileStdio(
    pkg.mcp,
    messages,
    { ...envExtra },
    cwd,
  );
  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  return responses.find((response) => response.id === 2).result;
}

// --------------------------------------------------------------------------- tests

test('a valid DONE report produces one canonical result, Markdown, and terminal dimensions', async () => {
  const pkg = copyBridgePackage('done-valid');
  const repo = caseDirectory('done-valid repo');
  const manifest = [{ id: 'A1', command: 'npm run test:sandbox', cwd: '.' }];
  writeDesign(repo, { manifest });
  const report = makeReport({
    checks: [
      makeCheck(),
      makeCheck({
        id: 'X1',
        command: 'node extra-check.mjs',
        logPath: '.dsh-runs/report-checks/x1.log',
      }),
    ],
    changes: [{ path: 'src/example.js', description: 'added behavior' }],
  });
  const run = await runBridge(pkg, repo, makeScenario(report, {
    mutations: [logMutation('A1'), logMutation('X1')],
  }));
  assert.equal(run.code, 0, run.stderr);
  const { result, path: resultPath } = readResultFromOutput(repo, run.stdout);

  assert.equal(result.schemaVersion, 1);
  assert.match(result.runId, /^\d{8}-\d{6}-[0-9a-f]{8}$/);
  assert.equal(result.sessionId, 'session-fixture');
  assert.equal(result.sessionProvenance, 'EVENT');
  assert.equal(result.design.path, 'design.md');
  assert.ok(result.timestamps.startedAt);
  assert.equal(result.execution.status, 'SUCCEEDED');
  assert.equal(result.execution.originalExitCode, 0);
  assert.equal(result.execution.bridgeExitCode, 0);
  assert.equal(result.execution.settings.model, 'deepseek-official/deepseek-flash');
  assert.equal(result.execution.settings.reasoningEffort, 'high');
  assert.equal(result.execution.settings.codexReviewEdits, 'Not Allow');
  assert.equal(result.execution.settings.preflightObjectLimit, 28000);

  assert.equal(result.task.status, 'DONE');
  assert.equal(result.task.claimedStatus, 'DONE');
  assert.equal(result.task.checks.length, 2);
  const declaredCheck = result.task.checks.find((check) => check.id === 'A1');
  const additionalCheck = result.task.checks.find((check) => check.id === 'X1');
  assert.equal(declaredCheck.source, 'IMPLEMENTER');
  assert.equal(declaredCheck.logAvailability, 'PRESENT');
  assert.equal(declaredCheck.additional, false);
  assert.equal(additionalCheck.source, 'IMPLEMENTER');
  assert.equal(additionalCheck.logAvailability, 'PRESENT');
  assert.equal(additionalCheck.additional, true);
  assert.equal(result.task.changes[0].path, 'src/example.js');

  assert.equal(result.report.validity, 'VALID');
  assert.deepEqual(result.report.errors, []);
  assert.equal(result.acceptance.status, 'PENDING');
  assert.equal(result.acceptance.coverage, 'COMPLETE');
  assert.deepEqual(result.acceptance.expectedCheckIds, ['A1']);
  assert.deepEqual(result.acceptance.missingCheckIds, []);
  assert.deepEqual(result.acceptance.additionalCheckIds, ['X1']);

  assert.equal(result.observations.toolCalls, 1);
  assert.equal(result.observations.toolErrors, 1);
  assert.deepEqual(result.observations.tokens, { input: 10, output: 5 });
  assert.equal(result.diagnostics.malformedEventLines.count, 0);
  assert.equal(result.diagnostics.lastValidEvent.type, 'final');
  assert.equal(result.diagnostics.turnEnd.reason, 'completed');

  for (const artifact of Object.values(result.artifacts)) {
    if (artifact === null) continue;
    assert.ok(existsSync(resolve(repo, artifact)), `missing artifact ${artifact}`);
  }
  assert.ok(existsSync(resultPath));

  const markdown = readFileSync(resolve(repo, result.artifacts.report), 'utf8');
  assert.match(markdown, /\| model \| deepseek-official\/deepseek-flash \|/);
  assert.match(markdown, /\| preflight object limit \| 28000 \|/);
  assert.match(markdown, /\| reasoning effort \| high \(source: .*\) \|/);
  assert.match(markdown, /\| Codex review edits \| Not Allow \(source: .*\) \|/);
  assert.match(markdown, /## Outcome before detail/);
  assert.match(markdown, /## Acceptance coverage/);
  assert.match(markdown, /observed during this run/i);

  assert.ok(outputLine(run.stdout, 'result: '));
  assert.ok(outputLine(run.stdout, 'report: '));
  assert.match(run.stdout, /execution: SUCCEEDED \| task: DONE \(implementer claim\) \| report: VALID \| acceptance: PENDING/);

  const rawFinal = readFileSync(resolve(repo, result.artifacts.finalText), 'utf8');
  assert.deepEqual(JSON.parse(rawFinal), report);
});

test('runtime token usage is canonical in the result, Markdown, stdout, and MCP', async () => {
  const pkg = copyBridgePackage('usage-propagation');
  const repo = caseDirectory('usage-propagation repo');
  writeDesign(repo);
  const usageEvents = [
    {
      type: 'status',
      phase: 'step_end',
      usage: {
        inputTokens: 4888,
        cacheReadTokens: 373888,
        cacheWriteTokens: 0,
        outputTokens: 7507,
        reasoningTokens: 100,
        totalTokens: 386283,
      },
    },
    {
      type: 'status',
      phase: 'step_end',
      usage: {
        inputTokens: 100,
        cacheReadTokens: 50,
        cacheWriteTokens: 25,
        outputTokens: 40,
        reasoningTokens: 10,
        totalTokens: 215,
      },
    },
    { type: 'status', phase: 'turn_end', reason: { kind: 'completed' } },
  ];
  const run = await runBridge(
    pkg,
    repo,
    makeScenario(makeReport(), { events: usageEvents, sessionId: 'session-usage' }),
  );
  assert.equal(run.code, 0, run.stderr);
  const { result } = readResultFromOutput(repo, run.stdout);
  assert.deepEqual(result.execution.usage, {
    scope: 'RUN',
    source: 'DSH_STEP_END',
    status: 'COMPLETE',
    stepsObserved: 2,
    stepsWithUsage: 2,
    inputTokens: 378951,
    inputUncachedTokens: 4988,
    inputCacheHitTokens: 373938,
    inputCacheMissTokens: 5013,
    inputCacheWriteTokens: 25,
    outputTokens: 7547,
    reasoningTokens: 110,
    totalTokens: 386498,
    cacheHitRate: 373938 / 378951,
    warnings: [],
  });
  assert.deepEqual(result.observations.tokens, { input: 4988, output: 7547 });

  const markdown = readFileSync(resolve(repo, result.artifacts.report), 'utf8');
  assert.match(markdown, /### Token usage/);
  assert.match(markdown, /Scope: \*\*RUN\*\* - this bridge invocation only/);
  assert.match(markdown, /\| input total \| 378,951 \|/);
  assert.match(markdown, /\| input uncached \| 4,988 \|/);
  assert.match(markdown, /\| cache hit \| 373,938 \|/);
  assert.match(markdown, /\| cache miss \(includes cache write\) \| 5,013 \|/);
  assert.match(markdown, /\| cache write \(included in cache miss\) \| 25 \|/);
  assert.match(markdown, /\| output \| 7,547 \|/);
  assert.match(markdown, /\| reasoning \(included in output; not added separately\) \| 110 \|/);
  assert.match(markdown, /\| total \(input \+ output\) \| 386,498 \|/);
  assert.match(markdown, /\| cache hit rate \(cache hit \/ input\) \| 98\.68% \|/);
  assert.match(
    run.stdout,
    /token usage \(RUN, DSH_STEP_END, COMPLETE\): steps 2\/2 \| input total 378,951/,
  );

  // MCP must expose the same canonical object and use the same values in its text.
  wrapBridgeWithExplicitDsh(pkg);
  const mcpRepo = caseDirectory('usage-propagation mcp repo');
  writeDesign(mcpRepo);
  const scenarioPath = writeScenario(
    pkg,
    makeScenario(makeReport(), {
      repo: mcpRepo,
      events: usageEvents,
      sessionId: 'session-usage-mcp',
    }),
  );
  const response = await callMcpTool(
    pkg,
    mcpRepo,
    mcpRepo,
    { spec: 'design.md', repo: mcpRepo, skip_windows_preflight: true },
    { FAKE_DSH_SCENARIO: scenarioPath },
  );
  assert.equal(response.isError, false, response.content[0].text);
  assert.deepEqual(response.structuredContent.execution.usage, result.execution.usage);
  assert.match(
    response.content[0].text,
    /token usage \(RUN, DSH_STEP_END, COMPLETE\): steps 2\/2 \| input total 378,951/,
  );
  assert.match(
    response.content[0].text,
    /\[canonical result\][\s\S]*token usage \(RUN, DSH_STEP_END, COMPLETE\): steps 2\/2 \| input total 378,951/,
  );
});

test('valid BLOCKED and PARTIAL reports exit zero and remain normal results', async () => {
  const pkg = copyBridgePackage('blocked-partial');
  const manifest = [{ id: 'A1', command: 'npm run test:sandbox', cwd: '.' }];

  const blockedRepo = caseDirectory('blocked repo');
  writeDesign(blockedRepo, { manifest });
  const blockedReport = makeReport({
    status: 'BLOCKED',
    summary: 'Need a product decision',
    followUps: ['Choose the retry policy'],
    checks: [makeCheck({ status: 'BLOCKED', exitCode: null, logPath: null, reason: 'blocked on decision' })],
  });
  const blockedRun = await runBridge(pkg, blockedRepo, makeScenario(blockedReport));
  assert.equal(blockedRun.code, 0, blockedRun.stderr);
  const blocked = readResultFromOutput(blockedRepo, blockedRun.stdout).result;
  assert.equal(blocked.execution.status, 'SUCCEEDED');
  assert.equal(blocked.task.status, 'BLOCKED');
  assert.equal(blocked.report.validity, 'VALID');
  assert.equal(blocked.acceptance.status, 'PENDING');
  assert.equal(blocked.acceptance.coverage, 'COMPLETE');
  assert.equal(blocked.task.checks[0].status, 'BLOCKED');
  assert.equal(blocked.task.checks[0].logAvailability, 'NOT_PROVIDED');

  const partialRepo = caseDirectory('partial repo');
  writeDesign(partialRepo, { manifest });
  const partialReport = makeReport({
    status: 'PARTIAL',
    summary: 'One leg failed but evidence is complete',
    checks: [makeCheck({ status: 'FAIL', exitCode: 1, reason: 'assertion failed' })],
  });
  const partialRun = await runBridge(pkg, partialRepo, makeScenario(partialReport, {
    mutations: [logMutation('A1')],
  }));
  assert.equal(partialRun.code, 0, partialRun.stderr);
  const partial = readResultFromOutput(partialRepo, partialRun.stdout).result;
  assert.equal(partial.execution.status, 'SUCCEEDED');
  assert.equal(partial.task.status, 'PARTIAL');
  assert.equal(partial.report.validity, 'VALID');
  assert.equal(partial.acceptance.coverage, 'COMPLETE');
  assert.equal(partial.task.checks[0].status, 'FAIL');
  assert.equal(partial.task.checks[0].logAvailability, 'PRESENT');
});

test('legacy prose, malformed, fenced, unsupported, incomplete, and missing finals are invalid', async () => {
  const pkg = copyBridgePackage('invalid-finals');
  const cases = [
    {
      name: 'legacy prose',
      scenario: makeScenario('STATUS: DONE\nCHANGES: fixture.js - changed\nCHECKS: npm test pass'),
      validity: 'INVALID',
      pattern: /legacy STATUS prose/,
    },
    {
      name: 'malformed JSON',
      scenario: makeScenario('{"schemaVersion":1,"status":"DONE"'),
      validity: 'INVALID',
      pattern: /not valid JSON/,
    },
    {
      name: 'fenced JSON',
      scenario: makeScenario('```json\n{"schemaVersion":1}\n```'),
      validity: 'INVALID',
      pattern: /code fences/,
    },
    {
      name: 'unsupported schema version',
      scenario: makeScenario(makeReport({ schemaVersion: 2 })),
      validity: 'INVALID',
      pattern: /unsupported schemaVersion/,
    },
    {
      name: 'missing required key',
      scenario: makeScenario((() => {
        const report = makeReport();
        delete report.followUps;
        return report;
      })()),
      validity: 'INVALID',
      pattern: /missing required key "followUps"/,
    },
    {
      name: 'missing final event',
      scenario: makeScenario(null, { omitFinal: true }),
      validity: 'MISSING',
      pattern: /final message|no final event/,
    },
  ];

  for (const current of cases) {
    const repo = caseDirectory(`invalid-final ${current.name}`);
    writeDesign(repo);
    const run = await runBridge(pkg, repo, current.scenario);
    const combined = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.code, 65, `${current.name} should exit 65:\n${combined}`);
    const { result } = readResultFromOutput(repo, run.stdout);
    assert.equal(result.report.validity, current.validity, current.name);
    assert.equal(result.task.status, 'UNKNOWN', current.name);
    assert.ok(result.report.errors.some((error) => current.pattern.test(error)), current.name);
    assert.ok(existsSync(resolve(repo, result.artifacts.finalText)));
    if (current.name === 'legacy prose') {
      assert.equal(result.report.legacyStatus, true);
      assert.match(
        readFileSync(resolve(repo, result.artifacts.finalText), 'utf8'),
        /STATUS: DONE/,
      );
    }
  }
});

test('a nonzero DSH exit is preserved independently of a valid report', async () => {
  const pkg = copyBridgePackage('nonzero');
  const repo = caseDirectory('nonzero repo');
  writeDesign(repo);
  const run = await runBridge(pkg, repo, makeScenario(makeReport(), { exitCode: 7 }));
  assert.equal(run.code, 7, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.execution.status, 'FAILED');
  assert.equal(result.execution.originalExitCode, 7);
  assert.equal(result.execution.bridgeExitCode, 7);
  assert.equal(result.report.validity, 'VALID');
  assert.equal(result.task.status, 'DONE');
});

test('a timeout reports TIMEOUT, preserves 124, and keeps available artifacts', async () => {
  const pkg = copyBridgePackage('timeout');
  const repo = caseDirectory('timeout repo');
  writeDesign(repo);
  const run = await runBridge(pkg, repo, makeScenario(makeReport()), ['-TimeoutMinutes', '0']);
  assert.equal(run.code, 124, run.stderr);
  const { result } = readResultFromOutput(repo, run.stdout);
  assert.equal(result.execution.status, 'TIMEOUT');
  assert.equal(result.execution.originalExitCode, null);
  assert.equal(result.execution.bridgeExitCode, 124);
  assert.notEqual(result.report.validity, 'VALID');
  assert.ok(existsSync(resolve(repo, result.artifacts.prompt)));
  assert.ok(existsSync(resolve(repo, result.artifacts.events)));
  assert.ok(existsSync(resolve(repo, result.artifacts.stderr)));
});

test('a launch failure is visible, nonzero, and still writes an artifact set', async () => {
  const pkg = copyBridgePackage('launch-failure');
  const repo = caseDirectory('launch-failure repo');
  writeDesign(repo);
  const broken = join(pkg.directory, 'not-an-executable.txt');
  writeText(broken, 'this is not a launcher\n');
  const run = await runBridge(pkg, repo, makeScenario(makeReport()), [], { launcher: broken });
  assert.notEqual(run.code, 0, run.stderr);
  const { result } = readResultFromOutput(repo, run.stdout);
  assert.equal(result.execution.status, 'LAUNCH_FAILED');
  assert.equal(result.execution.originalExitCode, null);
  assert.equal(result.execution.bridgeExitCode, 1);
  assert.equal(result.report.validity, 'MISSING');
  assert.ok(result.diagnostics.captureErrors.length > 0);
  assert.ok(existsSync(resolve(repo, result.artifacts.prompt)));
});

test('malformed event lines are counted, visible, and invalidate a successful run', async () => {
  const pkg = copyBridgePackage('malformed-events');
  const repo = caseDirectory('malformed-events repo');
  writeDesign(repo);
  const scenario = makeScenario(makeReport());
  scenario.events = [
    { type: 'tool_call', input: { path: 'fixture.txt' } },
    '{not valid json',
  ];
  const run = await runBridge(pkg, repo, scenario);
  assert.equal(run.code, 65, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'INVALID');
  assert.equal(result.task.status, 'UNKNOWN');
  assert.equal(result.diagnostics.malformedEventLines.count, 1);
  assert.deepEqual(result.diagnostics.malformedEventLines.lineNumbers, [3]);
  assert.equal(result.diagnostics.lastValidEvent.type, 'final');
  assert.ok(result.report.errors.some((error) => /malformed line/.test(error)));
});

test('a requested session is used as a labeled fallback when no session event arrives', async () => {
  const pkg = copyBridgePackage('session-fallback');
  const repo = caseDirectory('session-fallback repo');
  writeDesign(repo);
  const scenario = makeScenario(makeReport());
  delete scenario.sessionId;
  const run = await runBridge(pkg, repo, scenario, [
    '-Session',
    'requested-session-123',
  ]);
  assert.equal(run.code, 0, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.sessionId, 'requested-session-123');
  assert.equal(result.sessionProvenance, 'REQUESTED_FALLBACK');
});

test('a malformed or duplicate-ID manifest is a design-input error before launch', async () => {
  const pkg = copyBridgePackage('bad-manifests');
  const scenarios = [
    {
      name: 'malformed JSON',
      rawManifest: '[{"id":"A1","command":"npm test","cwd":"."},]',
      pattern: /not valid JSON|acceptance manifest/,
    },
    {
      name: 'duplicate ID',
      rawManifest: JSON.stringify([
        { id: 'A1', command: 'npm test', cwd: '.' },
        { id: 'A1', command: 'npm run build', cwd: '.' },
      ]),
      pattern: /duplicate check id/,
    },
  ];
  for (const current of scenarios) {
    const repo = caseDirectory(`bad-manifest ${current.name}`);
    writeDesign(repo, { rawManifest: current.rawManifest });
    const scenarioPath = writeScenario(pkg, {
      repo,
      capturePath: join(pkg.directory, `capture-${current.name.replaceAll(' ', '-')}.txt`),
      final: makeReport(),
    });
    const run = await captureProcess(
      'pwsh',
      [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        pkg.bridge,
        '-Repo',
        repo,
        '-Spec',
        'design.md',
        '-OutDir',
        '.dsh-runs',
        '-SkipWindowsPreflight',
        '-Dsh',
        pkg.launcher,
        '-DryRun',
      ],
      { env: { ...process.env, FAKE_DSH_SCENARIO: scenarioPath }, timeoutMs: 60_000 },
    );
    const combined = `${run.stdout}\n${run.stderr}`;
    assert.notEqual(run.code, 0, `${current.name} should fail:\n${combined}`);
    assert.match(combined, current.pattern, current.name);
    assert.equal(existsSync(join(repo, '.dsh-runs')), false, `${current.name} wrote artifacts`);
    assert.equal(
      existsSync(join(pkg.directory, `capture-${current.name.replaceAll(' ', '-')}.txt`)),
      false,
      `${current.name} launched DSH`,
    );
  }
});

test('designs without the manifest remain usable with NOT_DECLARED coverage', async () => {
  const pkg = copyBridgePackage('not-declared');
  const repo = caseDirectory('not-declared repo');
  writeDesign(repo);
  const run = await runBridge(pkg, repo, makeScenario(makeReport()));
  assert.equal(run.code, 0, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'VALID');
  assert.equal(result.acceptance.coverage, 'NOT_DECLARED');
  assert.deepEqual(result.acceptance.expectedCheckIds, []);
});

test('declared command and cwd must match; a different command does not satisfy coverage', async () => {
  const pkg = copyBridgePackage('mismatched-checks');
  const manifest = [
    { id: 'A1', command: 'npm run check', cwd: '.' },
    { id: 'A2', command: 'npm run build', cwd: 'demo' },
  ];

  const mismatchRepo = caseDirectory('mismatch repo');
  writeDesign(mismatchRepo, { manifest });
  const mismatch = makeReport({
    checks: [
      makeCheck({ id: 'A1', command: 'npm run test', cwd: '.' }),
      makeCheck({ id: 'A2', command: 'npm run build', cwd: 'other', logPath: '.dsh-runs/report-checks/a2.log' }),
    ],
  });
  const mismatchRun = await runBridge(pkg, mismatchRepo, makeScenario(mismatch, {
    mutations: [logMutation('A1'), logMutation('A2')],
  }));
  assert.equal(mismatchRun.code, 65, mismatchRun.stderr);
  const mismatchResult = readResultFromOutput(mismatchRepo, mismatchRun.stdout).result;
  assert.equal(mismatchResult.report.validity, 'INVALID');
  assert.equal(mismatchResult.acceptance.coverage, 'INCOMPLETE');
  assert.deepEqual(mismatchResult.acceptance.missingCheckIds.sort(), ['A1', 'A2']);
  assert.ok(mismatchResult.report.errors.some((error) => /does not match the manifest/.test(error)));

  const normalizedRepo = caseDirectory('normalized cwd repo');
  writeDesign(normalizedRepo, {
    manifest: [{ id: 'A1', command: 'node ./script.js', cwd: '.\\' }],
  });
  const normalized = makeReport({
    checks: [
      makeCheck({
        command: '  node ./script.js  ',
        cwd: '.',
        logPath: '.dsh-runs/report-checks/a1.log',
      }),
    ],
  });
  const normalizedRun = await runBridge(pkg, normalizedRepo, makeScenario(normalized, {
    mutations: [logMutation('A1')],
  }));
  assert.equal(normalizedRun.code, 0, normalizedRun.stderr);
  const normalizedResult = readResultFromOutput(normalizedRepo, normalizedRun.stdout).result;
  assert.equal(normalizedResult.report.validity, 'VALID');
  assert.equal(normalizedResult.acceptance.coverage, 'COMPLETE');

  const commandCases = [
    {
      name: 'repeated forward slash',
      declared: 'node test.mjs //target',
      reported: 'node test.mjs /target',
    },
    {
      name: 'backslash argument',
      declared: 'node test.mjs C:\\temp\\file',
      reported: 'node test.mjs C:/temp/file',
    },
    {
      name: 'quoted URL',
      declared: 'node test.mjs "https://example.test/a"',
      reported: 'node test.mjs "https://example.test//a"',
    },
  ];
  for (const current of commandCases) {
    const repo = caseDirectory(`exact command ${current.name}`);
    writeDesign(repo, {
      manifest: [{ id: 'A1', command: current.declared, cwd: '.' }],
    });
    const report = makeReport({
      checks: [makeCheck({ command: current.reported })],
    });
    const run = await runBridge(pkg, repo, makeScenario(report, {
      mutations: [logMutation('A1')],
    }));
    assert.equal(run.code, 65, `${current.name} should be rejected:\n${run.stdout}${run.stderr}`);
    const result = readResultFromOutput(repo, run.stdout).result;
    assert.equal(result.report.validity, 'INVALID', current.name);
    assert.equal(result.acceptance.coverage, 'INCOMPLETE', current.name);
    assert.deepEqual(result.acceptance.missingCheckIds, ['A1'], current.name);
    assert.ok(
      result.report.errors.some((error) => /does not match the manifest/.test(error)),
      current.name,
    );
  }
});

test('missing, absent, and unsafe logs are annotated and prevent a trusted DONE', async () => {
  const pkg = copyBridgePackage('log-availability');
  const repo = caseDirectory('log-availability repo');
  writeDesign(repo, {
    manifest: [
      { id: 'A1', command: 'cmd-a', cwd: '.' },
      { id: 'A2', command: 'cmd-b', cwd: '.' },
      { id: 'A3', command: 'cmd-c', cwd: '.' },
    ],
  });
  const report = makeReport({
    changes: [{ path: 'fixture.js', description: 'changed' }],
    checks: [
      makeCheck({ id: 'A1', command: 'cmd-a', logPath: '.dsh-runs/report-checks/missing.log' }),
      makeCheck({ id: 'A2', command: 'cmd-b', logPath: null }),
      makeCheck({ id: 'A3', command: 'cmd-c', logPath: '../outside.log' }),
    ],
  });
  const run = await runBridge(pkg, repo, makeScenario(report));
  assert.equal(run.code, 65, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'INVALID');
  assert.equal(result.task.status, 'UNKNOWN');
  const availability = Object.fromEntries(result.task.checks.map((check) => [check.id, check.logAvailability]));
  assert.deepEqual(availability, {
    A1: 'MISSING',
    A2: 'NOT_PROVIDED',
    A3: 'UNSAFE',
  });
  assert.equal(result.acceptance.coverage, 'COMPLETE');
  assert.ok(result.report.errors.some((error) => /log is MISSING/.test(error)));
  assert.ok(result.report.errors.some((error) => /log is NOT_PROVIDED/.test(error)));
  assert.ok(result.report.errors.some((error) => /log is UNSAFE/.test(error)));
});

test('a claimed check log reached through a link is UNSAFE, not PRESENT', async (t) => {
  const pkg = copyBridgePackage('log-link');
  const repo = caseDirectory('log-link repo');
  const target = caseDirectory('log-link target');
  writeText(join(target, 'a1.log'), 'outside log content');
  const link = join(repo, 'linked-logs');
  let created = false;
  if (process.platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], {
      stdio: 'ignore',
      windowsHide: true,
    });
    created = result.status === 0;
  } else {
    try {
      symlinkSync(target, link, 'dir');
      created = true;
    } catch {}
  }
  if (!created) {
    t.skip('directory link creation is unavailable on this host');
    return;
  }
  cleanupJunctions.push(link);
  writeDesign(repo, {
    manifest: [{ id: 'A1', command: 'cmd-a', cwd: '.' }],
  });
  const report = makeReport({
    checks: [makeCheck({ command: 'cmd-a', logPath: 'linked-logs/a1.log' })],
  });
  const run = await runBridge(pkg, repo, makeScenario(report));
  assert.equal(run.code, 65, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'INVALID');
  assert.equal(result.task.checks[0].logAvailability, 'UNSAFE');
  assert.ok(result.report.errors.some((error) => /log is UNSAFE/.test(error)));
});

test('DONE contradicts failed, blocked, unrun, and log-less checks', async () => {
  const pkg = copyBridgePackage('done-contradictions');
  const repo = caseDirectory('done-contradictions repo');
  writeDesign(repo, {
    manifest: [
      { id: 'A1', command: 'cmd-a', cwd: '.' },
      { id: 'A2', command: 'cmd-b', cwd: '.' },
      { id: 'A3', command: 'cmd-c', cwd: '.' },
    ],
  });
  const report = makeReport({
    checks: [
      makeCheck({ id: 'A1', command: 'cmd-a', status: 'FAIL', exitCode: 1, reason: 'failed' }),
      makeCheck({ id: 'A2', command: 'cmd-b', status: 'BLOCKED', exitCode: null, logPath: null, reason: 'blocked' }),
      makeCheck({ id: 'A3', command: 'cmd-c', status: 'NOT_RUN', exitCode: null, logPath: null, reason: 'not run' }),
    ],
  });
  const run = await runBridge(pkg, repo, makeScenario(report, { mutations: [logMutation('A1')] }));
  assert.equal(run.code, 65, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'INVALID');
  assert.equal(result.task.status, 'UNKNOWN');
  assert.equal(result.acceptance.coverage, 'COMPLETE');
  assert.ok(result.report.errors.some((error) => /DONE status contradicts check "A2"/.test(error)));
  assert.ok(result.report.errors.some((error) => /DONE status contradicts check "A3"/.test(error)));
});

test('working-tree observations classify pre-existing and new changes without causal claims', async () => {
  const pkg = copyBridgePackage('working-tree');
  const repo = caseDirectory('working-tree repo');
  writeText(join(repo, 'a.txt'), 'head-a');
  writeText(join(repo, 'b.txt'), 'head-b');
  writeText(join(repo, 'c.txt'), 'delete-me');
  writeText(join(repo, 'e.txt'), 'head-e');
  writeText(join(repo, 'g.txt'), 'head-g');
  writeText(join(repo, 'odd name.txt'), 'odd');
  writeText(join(repo, 'old.txt'), 'rename-me');
  initGitRepo(repo);
  commitAll(repo);
  writeDesign(repo);

  writeText(join(repo, 'a.txt'), 'dirty-a-before');
  writeText(join(repo, 'b.txt'), 'dirty-b-before');
  writeText(join(repo, 'e.txt'), 'dirty-e-before');

  const report = makeReport({
    changes: [{ path: 'a.txt', description: 'claimed change' }],
  });
  const scenario = makeScenario(report, {
    mutations: [
      { op: 'write', path: 'a.txt', content: 'dirty-a-after' },
      { op: 'write', path: 'new file with spaces.txt', content: 'new-file' },
      { op: 'delete', path: 'c.txt' },
      { op: 'write', path: 'e.txt', content: 'head-e' },
      { op: 'rename', from: 'old.txt', to: 'renamed file.txt' },
      { op: 'write', path: 'g.txt', content: 'staged-g' },
      { op: 'stage', path: 'g.txt' },
    ],
  });
  const run = await runBridge(pkg, repo, scenario);
  assert.equal(run.code, 0, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'VALID');
  const workingTree = result.observations.workingTree;
  assert.equal(workingTree.status, 'OBSERVED');
  assert.equal(workingTree.headBefore, workingTree.headAfter);
  const byPath = new Map(workingTree.paths.map((entry) => [entry.path, entry]));

  assert.equal(byPath.get('a.txt').classification, 'PREEXISTING_CHANGED');
  assert.ok(byPath.get('a.txt').changeKinds.includes('CONTENT_CHANGED'));
  assert.equal(byPath.get('b.txt').classification, 'PREEXISTING_UNCHANGED');
  assert.equal(byPath.get('new file with spaces.txt').classification, 'NEWLY_CHANGED');
  assert.equal(byPath.get('c.txt').classification, 'NEWLY_CHANGED');
  assert.ok(byPath.get('c.txt').changeKinds.includes('DELETED'));
  assert.equal(byPath.get('e.txt').classification, 'PREEXISTING_CHANGED');
  assert.ok(byPath.get('e.txt').changeKinds.includes('RESTORED_TO_HEAD'));
  assert.equal(byPath.get('e.txt').statusAfter, null);
  assert.equal(byPath.get('g.txt').classification, 'NEWLY_CHANGED');
  assert.equal(byPath.get('g.txt').indexStatusAfter, 'M');
  assert.equal(byPath.get('old.txt').classification, 'NEWLY_CHANGED');
  assert.equal(byPath.get('renamed file.txt').classification, 'NEWLY_CHANGED');
  assert.equal(byPath.has('odd name.txt'), false);
  assert.equal(result.observations.implementerClaimedChanges.includes('a.txt'), true);
  assert.equal(result.observations.workingTree.counts.NEWLY_CHANGED >= 4, true);
  assert.equal(result.observations.workingTree.warnings.length, 0);
});

test('inventory refuses content reads through a parent junction on both dirty and follow-up paths', async () => {
  const pkg = copyBridgePackage('inventory-ancestor-link');
  const repo = caseDirectory('inventory-ancestor-link repo');
  writeText(join(repo, 'tracked', 'sample.txt'), 'head content');
  initGitRepo(repo);
  commitAll(repo);
  writeDesign(repo);
  // Pre-existing dirty path: it enters the before inventory and is also re-added to the
  // after inventory as a clean-path follow-up if Git no longer reports it through the link.
  writeText(join(repo, 'tracked', 'sample.txt'), 'dirty before content');

  const outsideDir = caseDirectory('inventory ancestor outside');
  writeText(join(outsideDir, 'sample.txt'), 'outside content that must never be hashed');
  const junctionMarker = join(pkg.directory, 'ancestor-junction-marker.txt');
  const report = makeReport();
  cleanupJunctions.push(join(repo, 'tracked'));
  const run = await runBridge(pkg, repo, makeScenario(report, {
    fixtureRoot: suiteRoot,
    mutations: [
      { op: 'rename', from: 'tracked', to: 'tracked-real' },
      { op: 'junction', path: 'tracked', target: outsideDir, marker: junctionMarker },
    ],
  }));
  assert.equal(run.code, 0, run.stderr);
  assert.equal(existsSync(junctionMarker), true, 'the test junction was not created');
  assert.equal(readFileSync(junctionMarker, 'utf8'), 'created');

  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.report.validity, 'VALID');
  const entry = result.observations.workingTree.paths.find(
    (candidate) => candidate.path === 'tracked/sample.txt',
  );
  assert.ok(entry, 'the tracked path under the junction was not observed');
  assert.equal(entry.classification, 'UNKNOWN');
  assert.equal(entry.changeKinds.includes('UNSAFE_PATH'), true);
  assert.equal(entry.unsafeAfter, true);
  assert.equal(entry.sha256After, null);
  assert.ok(
    result.observations.workingTree.warnings.some((warning) =>
      /link\/reparse ancestor/.test(warning),
    ),
  );
});

test('a non-Git repository reports observation UNAVAILABLE and keeps claims separate', async () => {
  const pkg = copyBridgePackage('non-git');
  const repo = caseDirectory('non-git repo');
  writeDesign(repo);
  const report = makeReport({
    changes: [{ path: 'claimed-only.txt', description: 'claimed but not observed' }],
  });
  const run = await runBridge(pkg, repo, makeScenario(report, {
    mutations: [{ op: 'write', path: 'created-by-child.txt', content: 'x' }],
  }));
  assert.equal(run.code, 0, run.stderr);
  const result = readResultFromOutput(repo, run.stdout).result;
  assert.equal(result.observations.workingTree.status, 'UNAVAILABLE');
  assert.equal(result.observations.workingTree.reason, 'before: not a Git repository; after: not a Git repository');
  assert.deepEqual(result.observations.workingTree.paths, []);
  assert.deepEqual(result.observations.implementerClaimedChanges, ['claimed-only.txt']);
});

test('supplied capture errors invalidate a valid report and force bridge exit 65 while inventory errors stay visible', () => {
  const directory = caseDirectory('capture-error-result');
  const repo = caseDirectory('capture-error repo');
  const runId = '20261020-130000-deadbeef';
  const eventsPath = join(directory, 'events.jsonl');
  const finalText = JSON.stringify(makeReport());
  writeText(
    eventsPath,
    [
      JSON.stringify({ type: 'session', sessionId: 'session-capture' }),
      JSON.stringify({ type: 'final', text: finalText }),
      '',
    ].join('\n'),
  );
  const facts = {
    schemaVersion: 1,
    runId,
    repoRoot: repo,
    designPath: 'design.md',
    startedAt: '2026-10-20T00:00:00.000Z',
    completedAt: '2026-10-20T00:00:01.000Z',
    exitCode: 0,
    timedOut: false,
    launchFailed: false,
    captureErrors: ['injected capture failure'],
    inventoryErrors: ['injected inventory warning'],
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
    artifacts: {
      prompt: join(directory, 'prompt.md'),
      patch: join(directory, 'patch.yml'),
      events: eventsPath,
      stderr: join(directory, 'stderr.log'),
      report: join(directory, 'report.md'),
      result: join(directory, `${runId}-result.json`),
      finalText: join(directory, 'final.txt'),
      inventoryBefore: join(directory, 'before.json'),
      inventoryAfter: join(directory, 'after.json'),
    },
  };
  const outcome = finalizeRun(facts);
  assert.equal(outcome.result.execution.status, 'SUCCEEDED');
  assert.equal(outcome.result.execution.originalExitCode, 0);
  assert.equal(outcome.result.execution.bridgeExitCode, 65);
  assert.equal(outcome.bridgeExitCode, 65);
  assert.equal(outcome.result.report.validity, 'INVALID');
  assert.equal(outcome.result.task.status, 'UNKNOWN');
  assert.ok(outcome.result.report.errors.includes('injected capture failure'));
  assert.ok(outcome.result.diagnostics.captureErrors.includes('injected capture failure'));
  assert.ok(outcome.result.diagnostics.inventoryErrors.includes('injected inventory warning'));
  assert.ok(outcome.result.report.warnings.includes('injected inventory warning'));
});

test('MCP returns matching text and structuredContent for normal DONE, BLOCKED, and PARTIAL outcomes', async () => {
  const pkg = copyBridgePackage('mcp-outcomes');
  wrapBridgeWithExplicitDsh(pkg);
  const manifest = [{ id: 'A1', command: 'npm run test:sandbox', cwd: '.' }];
  const cases = [
    {
      name: 'done',
      report: makeReport({ checks: [makeCheck()] }),
      expectedTask: 'DONE',
      mutations: [logMutation('A1')],
    },
    {
      name: 'blocked',
      report: makeReport({
        status: 'BLOCKED',
        summary: 'Decision needed',
        followUps: ['Decide the retry policy'],
        checks: [makeCheck({ status: 'NOT_RUN', exitCode: null, logPath: null, reason: 'decision needed' })],
      }),
      expectedTask: 'BLOCKED',
      mutations: [],
    },
    {
      name: 'partial',
      report: makeReport({
        status: 'PARTIAL',
        summary: 'Evidence complete; one check failed',
        checks: [makeCheck({ status: 'FAIL', exitCode: 1, reason: 'failed' })],
      }),
      expectedTask: 'PARTIAL',
      mutations: [logMutation('A1')],
    },
  ];

  for (const current of cases) {
    const repo = caseDirectory(`mcp outcome ${current.name}`);
    writeDesign(repo, { manifest });
    const scenarioPath = writeScenario(pkg, makeScenario(current.report, {
      repo,
      mutations: current.mutations,
    }));
    const response = await callMcpTool(
      pkg,
      repo,
      repo,
      { spec: 'design.md', repo, skip_windows_preflight: true },
      {
        FAKE_DSH_SCENARIO: scenarioPath,
      },
    );
    assert.equal(response.isError, false, `${current.name}: ${response.content[0].text}`);
    assert.ok(response.structuredContent, current.name);
    assert.equal(response.structuredContent.schemaVersion, 1, current.name);
    assert.equal(response.structuredContent.execution.status, 'SUCCEEDED', current.name);
    assert.equal(response.structuredContent.task.status, current.expectedTask, current.name);
    assert.equal(response.structuredContent.report.validity, 'VALID', current.name);
    assert.equal(response.structuredContent.acceptance.status, 'PENDING', current.name);
    assert.equal(response.structuredContent.acceptance.coverage, 'COMPLETE', current.name);

    const resultPath = resolve(repo, response.structuredContent.artifacts.result);
    assert.deepEqual(readJson(resultPath), response.structuredContent, current.name);
    assert.match(
      response.content[0].text,
      new RegExp(`execution: SUCCEEDED \\| task: ${current.expectedTask} \\(implementer claim\\) \\| report: VALID \\| acceptance: PENDING`),
      current.name,
    );
    assert.match(response.content[0].text, new RegExp(`result: \\.dsh-runs/.*-result\\.json`), current.name);
  }
});

test('MCP keeps early failures plain and rejects missing, traversing, linked, or inconsistent results', async () => {
  const directory = caseDirectory('mcp-safety');
  const fakeBridge = join(directory, 'fake-bridge.ps1');
  writeText(
    fakeBridge,
    [
      '$scenario = Get-Content -Raw $env:FAKE_BRIDGE_SCENARIO | ConvertFrom-Json',
      '$repo = $scenario.repo',
      '$runId = "20261020-120000-abcdef12"',
      '$resultRelative = ".dsh-runs/$runId-result.json"',
      'if ($scenario.mode -eq "early-failure") { Write-Output "preflight failed: fixture"; exit 1 }',
      'if ($scenario.mode -eq "mismatch") {',
      '  New-Item -ItemType Directory -Force -Path (Join-Path $repo ".dsh-runs") | Out-Null',
      '  Copy-Item -LiteralPath $scenario.resultSource -Destination (Join-Path $repo $resultRelative)',
      '  Write-Output "repo-root: $repo"; Write-Output "result: $resultRelative"; exit 65',
      '}',
      'if ($scenario.mode -eq "missing") {',
      '  Write-Output "repo-root: $repo"; Write-Output "result: $resultRelative"; Write-Output "bridge ok"; exit 0',
      '}',
      'if ($scenario.mode -eq "traversal") {',
      '  Write-Output "repo-root: $repo"; Write-Output "result: ../outside-result.json"; exit 0',
      '}',
      'if ($scenario.mode -eq "junction") {',
      '  # The test creates the junction itself at the fresh .dsh-runs path.',
      '  Write-Output "repo-root: $repo"; Write-Output "result: $resultRelative"; exit 0',
      '}',
      'if ($scenario.mode -eq "stdout-usage") {',
      '  New-Item -ItemType Directory -Force -Path (Join-Path $repo ".dsh-runs") | Out-Null',
      '  Copy-Item -LiteralPath $scenario.resultSource -Destination (Join-Path $repo $resultRelative)',
      '  Write-Output "repo-root: $repo"',
      '  Write-Output "token usage (RUN, DSH_STEP_END, COMPLETE): raw model text"',
      '  Write-Output "result: $resultRelative"',
      '  Write-Output "bridge ok"',
      '  exit 0',
      '}',
      'New-Item -ItemType Directory -Force -Path (Join-Path $repo ".dsh-runs") | Out-Null',
      'Copy-Item -LiteralPath $scenario.resultSource -Destination (Join-Path $repo $resultRelative)',
      'Write-Output "repo-root: $repo"; Write-Output "result: $resultRelative"',
      'Write-Output "bridge ok"',
      'exit 0',
      '',
    ].join('\n'),
  );

  // MCP always launches the bridge beside its own file. Replace the package's
  // dsh-impl.ps1 with the controlled fake bridge so each response mode is exact.
  const bridgePackage = copyBridgePackage('mcp-safety-package');
  copyFileSync(fakeBridge, bridgePackage.bridge);

  async function scenarioCall(name, mode, extra = {}) {
    const repo = extra.repo ? resolve(extra.repo) : caseDirectory(`mcp safety ${name}`);
    const scenario = {
      repo,
      mode,
      resultSource: join(directory, `result-${name}.json`),
      ...extra,
    };
    if (!extra.resultSource) {
      writeText(scenario.resultSource, JSON.stringify(validResultObject()));
    }
    const scenarioPath = writeText(
      join(directory, `scenario-${name}.json`),
      JSON.stringify(scenario),
    );
    return callMcpTool(bridgePackage, repo, repo, {
      spec: 'design.md',
      repo,
      skip_windows_preflight: true,
    }, {
      FAKE_BRIDGE_SCENARIO: scenarioPath,
    });
  }

  const early = await scenarioCall('early', 'early-failure');
  assert.equal(early.isError, true);
  assert.equal(early.structuredContent, undefined);
  assert.match(early.content[0].text, /preflight failed: fixture/);

  const missing = await scenarioCall('missing', 'missing');
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined);
  assert.match(missing.content[0].text, /readable, safe result artifact/);

  const legacy = await scenarioCall('legacy', 'copy');
  assert.equal(legacy.isError, false, legacy.content[0].text);
  assert.equal(legacy.structuredContent.execution.usage, undefined);
  assert.match(legacy.content[0].text, /legacy result without execution\.usage/);
  assert.match(legacy.content[0].text, /no cache-inclusive total is available/);

  const legacyWithStdoutUsage = await scenarioCall('legacy-stdout-usage', 'stdout-usage');
  assert.equal(
    legacyWithStdoutUsage.isError,
    false,
    legacyWithStdoutUsage.content[0].text,
  );
  assert.equal(legacyWithStdoutUsage.structuredContent.execution.usage, undefined);
  assert.match(
    legacyWithStdoutUsage.content[0].text,
    /\[canonical result\][\s\S]*legacy result without execution\.usage/,
  );
  assert.match(
    legacyWithStdoutUsage.content[0].text,
    /no cache-inclusive total is available/,
  );

  const traversal = await scenarioCall('traversal', 'traversal');
  assert.equal(traversal.isError, true);
  assert.equal(traversal.structuredContent, undefined);
  assert.match(traversal.content[0].text, /outside the expected \.dsh-runs artifact location|repository-relative/);

  const invalidSource = join(directory, 'invalid-result.json');
  writeText(invalidSource, JSON.stringify({ schemaVersion: 2 }));
  const invalid = await scenarioCall('invalid', 'copy', { resultSource: invalidSource });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent, undefined);
  assert.match(invalid.content[0].text, /schemaVersion/);

  const mismatchSource = join(directory, 'mismatch-result.json');
  writeText(mismatchSource, JSON.stringify(validResultObject()));
  const mismatch = await scenarioCall('mismatch', 'mismatch', { resultSource: mismatchSource });
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent, undefined);
  assert.match(mismatch.content[0].text, /refusing the inconsistent result/);

  const junctionRepo = caseDirectory('mcp safety junction');
  const outsideDir = caseDirectory('mcp junction outside');
  writeText(join(outsideDir, `${FAKE_RUN_ID}-result.json`), JSON.stringify(validResultObject()));
  const junctionPath = join(junctionRepo, '.dsh-runs');
  let junctionCreated = false;
  if (process.platform === 'win32') {
    const created = spawnSync('cmd', ['/c', 'mklink', '/J', junctionPath, outsideDir], {
      stdio: 'ignore',
      windowsHide: true,
    });
    junctionCreated = created.status === 0;
  } else {
    try {
      symlinkSync(outsideDir, junctionPath, 'dir');
      junctionCreated = true;
    } catch {}
  }
  assert.equal(junctionCreated, true, 'the MCP junction fixture must be created');
  cleanupJunctions.push(junctionPath);
  const junction = await scenarioCall('junction', 'junction', { repo: junctionRepo });
  assert.equal(junction.isError, true);
  assert.equal(junction.structuredContent, undefined);
  assert.match(junction.content[0].text, /symlink or reparse point|escapes the repository/);
});
