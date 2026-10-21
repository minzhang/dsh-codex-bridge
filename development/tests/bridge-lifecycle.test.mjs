import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = join(project, 'dsh-codex-bridge');
const suite = mkdtempSync(join(tmpdir(), 'bridge-lifecycle-'));
const processes = new Set();
let captureIndex = 0;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const put = (path, value) => writeFileSync(path, JSON.stringify(value), 'utf8');

after(async () => {
  // Only our own launchers are signalled; their owned jobs reap descendants.
  for (const handle of processes) if (handle.child.exitCode === null) handle.child.kill();
  await Promise.allSettled([...processes].map(handle => handle.done));
  const target = resolve(suite);
  assert.ok(target.startsWith(resolve(tmpdir()) + sep));
  assert.ok(target.includes(sep + 'bridge-lifecycle-'));
  rmSync(target, { recursive: true, force: true });
});

function fixture(name) {
  const repo = join(suite, name);
  mkdirSync(repo, { recursive: true });
  const bridge = join(repo, 'dsh-codex-bridge');
  cpSync(source, bridge, { recursive: true, filter: path => !path.split(/[\\/]/).includes('.state') });
  // Exercise a real preflight subprocess with a fixture-only readiness response.
  writeFileSync(join(bridge, 'windows', 'setup.ps1'), "Write-Output 'RESULT: READY'\n");
  writeFileSync(join(repo, 'design.md'), '# Disposable lifecycle acceptance fixture\n');
  const program = join(repo, 'fixture.cjs');
  writeFileSync(program, [
    "const fs = require('node:fs'); const cp = require('node:child_process');",
    "fs.readFileSync(0, 'utf8');",
    "fs.appendFileSync('launches.log', String(process.pid) + '\\n');",
    "if (process.env.LIFECYCLE_FAIL === '1') { process.stderr.write('session restore failed\\n'); process.exit(23); }",
    "const requested = process.argv.indexOf('--session-id');",
    "const sessionId = process.env.LIFECYCLE_SESSION || (requested >= 0 ? process.argv[requested + 1] : 'session-fixture');",
    "const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');",
    "emit({type: 'session', sessionId});",
    "emit({type: 'status', phase: 'step_end', usage: {inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 35}});",
    "fs.writeFileSync('work.txt', 'partial code preserved\\n');",
    "if (process.env.LIFECYCLE_HOLD === '1') {",
    "  const descendant = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', windowsHide: true});",
    "  fs.writeFileSync('writers.json', JSON.stringify({parent: process.pid, child: descendant.pid}));",
    "  setInterval(() => fs.appendFileSync('activity.log', 'tick\\n'), 100);",
    "} else {",
    "  emit({type: 'final', text: JSON.stringify({schemaVersion: 1, status: 'DONE', summary: 'fixture', changes: [], checks: [], decisions: [], followUps: []})});",
    "  emit({type: 'status', phase: 'turn_end', reason: {kind: 'completed'}});",
    "}",
  ].join('\n'));
  const launcher = join(repo, 'fixture.cmd');
  writeFileSync(launcher, '@echo off\r\n"' + process.execPath + '" "' + program + '" %*\r\nexit /b %ERRORLEVEL%\r\n');
  return { repo, bridge, launcher, control: join(repo, '.dsh-runs', 'control') };
}

function launch(script, args, env = {}) {
  const prefix = join(suite, 'capture-' + captureIndex++);
  const out = prefix + '.out', err = prefix + '.err';
  const descriptors = [openSync(out, 'w'), openSync(err, 'w')];
  const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', ...descriptors], windowsHide: true,
  });
  descriptors.forEach(closeSync);
  const handle = { child, done: null };
  handle.done = new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', code => resolvePromise({
      code, stdout: readFileSync(out, 'utf8'), stderr: readFileSync(err, 'utf8'),
    }));
  });
  processes.add(handle);
  return handle;
}

function run(f, args = [], env = {}) {
  return launch(join(f.bridge, 'dsh-impl.ps1'), ['-Repo', f.repo, '-Spec', 'design.md', '-Dsh', f.launcher, ...args], env);
}
async function manage(f, action, args = []) {
  const outcome = await launch(join(f.bridge, 'dsh-run.ps1'), ['-Repo', f.repo, '-Action', action, ...args]).done;
  let value;
  try { value = JSON.parse(outcome.stdout); } catch { assert.fail(outcome.stdout + '\n' + outcome.stderr); }
  return { ...outcome, value };
}
async function until(condition, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = condition();
    if (value) return value;
    await delay(100);
  }
  assert.fail('Timed out waiting for ' + label);
}
function record(f, id) { return json(join(f.control, 'runs', id + '.json')); }
function active(f) {
  const path = join(f.control, 'active.json');
  return existsSync(path) ? json(path).runId : null;
}
async function writers(f) {
  return until(() => existsSync(join(f.repo, 'writers.json')) && json(join(f.repo, 'writers.json')), 'real fixture writers');
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function result(f, id) { return json(record(f, id).artifacts.result); }
function mutationArgs(id) { return ['-RunId', id, '-Apply', '-Reason', 'controlled regression test']; }

test('read-only status and DryRun create no ownership; default timeout is three hours', async () => {
  const f = fixture('read only');
  const before = readdirSync(f.repo);
  const status = await manage(f, 'Status');
  assert.equal(status.code, 0);
  assert.deepEqual(status.value.runs, []);
  assert.deepEqual(readdirSync(f.repo), before);
  const dry = await run(f, ['-DryRun']).done;
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /timeout minutes: 180/);
  assert.equal(existsSync(f.control), false);
  const negative = await run(f, ['-TimeoutMinutes', '-1']).done;
  assert.notEqual(negative.code, 0);
  assert.equal(existsSync(f.control), false);
});

test('normal execution and resume preserve reports, session confirmation and per-run usage', async () => {
  const f = fixture('normal and resume');
  for (const args of [[], ['-Session', 'session-fixture']]) {
    const outcome = await run(f, args).done;
    assert.equal(outcome.code, 0, outcome.stderr + outcome.stdout);
    const status = await manage(f, 'Status');
    const observed = status.value.runs[0];
    assert.equal(observed.state, 'FINISHED');
    assert.equal(observed.observedSession, 'session-fixture');
    assert.equal(observed.sessionProvenance, 'EVENT');
    assert.equal(status.value.activeRunId, null);
    const canonical = result(f, observed.runId);
    assert.equal(canonical.execution.settings.timeoutMinutes, 180);
    assert.equal(canonical.execution.usage.totalTokens, 35);
    assert.equal(canonical.acceptance.status, 'PENDING');
    assert.equal(canonical.report.validity, 'VALID');
  }
  const mismatch = await run(f, ['-Session', 'session-other'], { LIFECYCLE_SESSION: 'session-fixture' }).done;
  assert.notEqual(mismatch.code, 0);
  const latest = (await manage(f, 'Status')).value.runs[0];
  assert.equal(result(f, latest.runId).task.status, 'UNKNOWN');
  assert.match(result(f, latest.runId).report.errors.join(' '), /session differs/);
  const resumeFailure = await run(f, ['-Session', 'session-fixture'], { LIFECYCLE_FAIL: '1' }).done;
  assert.equal(resumeFailure.code, 23);
  const failedResume = (await manage(f, 'Status')).value.runs[0];
  assert.equal(failedResume.observedSession, null);
  assert.equal(failedResume.sessionProvenance, 'REQUESTED_FALLBACK');
  assert.equal(result(f, failedResume.runId).execution.originalExitCode, 23);
  writeFileSync(join(f.bridge, 'windows', 'setup.ps1'), "Write-Output 'RESULT: NOT READY'; exit 1\n");
  const preflight = await run(f).done;
  assert.notEqual(preflight.code, 0);
  const failed = (await manage(f, 'Status')).value.runs[0];
  assert.match(failed.diagnostic, /preflight failed/);
  assert.equal(failed.state, 'FINISHED');
});

test('one repository has one writer across output directories; mutations must be explicit', async () => {
  const f = fixture('exclusive');
  const first = run(f, ['-OutDir', '.dsh-runs/custom'], { LIFECYCLE_HOLD: '1' });
  const ids = await writers(f);
  const id = active(f);
  const firstBeat = record(f, id).heartbeatAt;
  await until(() => record(f, id).heartbeatAt !== firstBeat, 'heartbeat update');
  assert.equal((await manage(f, 'Status')).value.runs[0].state, 'ACTIVE');
  const duplicate = await run(f, ['-OutDir', 'different-output']).done;
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /occupied/);
  assert.equal(existsSync(join(f.repo, 'different-output')), false);
  const original = readFileSync(join(f.control, 'active.json'), 'utf8');
  assert.equal((await manage(f, 'Recover', ['-RunId', id])).value.applied, false);
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal(readFileSync(join(f.control, 'active.json'), 'utf8'), original);
  assert.equal((await manage(f, 'Stop', ['-RunId', id])).value.applied, false);
  assert.ok(alive(ids.parent) && alive(ids.child));
  const stopped = await manage(f, 'Stop', mutationArgs(id));
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.notEqual((await first.done).code, 0);
  await until(() => !alive(ids.parent) && !alive(ids.child), 'owned tree stopped');
  assert.equal(active(f), null);
  assert.equal(record(f, id).stop.reason, 'controlled regression test');
  assert.notEqual(result(f, id).execution.usage.status, 'COMPLETE');
});

test('hard timeout kills its real child tree while another repository continues', async () => {
  const timed = fixture('timed'), other = fixture('unrelated');
  const protectedRun = run(other, [], { LIFECYCLE_HOLD: '1' });
  const protectedWriters = await writers(other);
  const timedRun = run(timed, ['-TimeoutMinutes', '1'], { LIFECYCLE_HOLD: '1' });
  const timedWriters = await writers(timed);
  const timedId = active(timed);
  const outcome = await timedRun.done;
  assert.equal(outcome.code, 124, outcome.stderr);
  assert.equal(result(timed, timedId).execution.status, 'TIMEOUT');
  assert.notEqual(result(timed, timedId).execution.usage.status, 'COMPLETE');
  await until(() => !alive(timedWriters.parent) && !alive(timedWriters.child), 'timed tree exited');
  assert.ok(alive(protectedWriters.parent) && alive(protectedWriters.child));
  assert.equal((await manage(other, 'Stop', mutationArgs(active(other)))).code, 0);
  await protectedRun.done;
});

test('killed launcher retains evidence until explicit recovery and then permits continuation', async () => {
  const f = fixture('interruption');
  const handle = run(f, [], { LIFECYCLE_HOLD: '1' });
  const ids = await writers(f), id = active(f);
  const eventPath = record(f, id).artifacts.events;
  const savedCode = readFileSync(join(f.repo, 'work.txt'), 'utf8');
  handle.child.kill();
  await handle.done;
  await until(() => !alive(ids.parent) && !alive(ids.child), 'job close after launcher death');
  assert.equal((await manage(f, 'Scan')).value.runs[0].state, 'INTERRUPTED');
  const capturedEvents = readFileSync(eventPath, 'utf8');
  assert.notEqual((await run(f).done).code, 0);
  assert.equal(active(f), id);
  assert.equal((await manage(f, 'Recover', ['-RunId', id])).value.applied, false);
  assert.equal(active(f), id);
  const recovered = await manage(f, 'Recover', mutationArgs(id));
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(active(f), null);
  assert.equal(readFileSync(eventPath, 'utf8'), capturedEvents);
  assert.equal(readFileSync(join(f.repo, 'work.txt'), 'utf8'), savedCode);
  const recoveredResult = result(f, id);
  assert.equal(recoveredResult.execution.status, 'FAILED');
  assert.equal(recoveredResult.execution.originalExitCode, null);
  assert.equal(recoveredResult.execution.bridgeExitCode, 1);
  assert.equal(recoveredResult.acceptance.status, 'PENDING');
  assert.equal(recoveredResult.execution.usage.status, 'PARTIAL');
  const second = await manage(f, 'Recover', mutationArgs(id));
  assert.equal(second.code, 0);
  assert.equal(second.value.alreadyRecovered, true);
  // Crash boundary: recovery was saved, but its active pointer was not removed.
  const recoveryEvidence = record(f, id).recovery;
  const canonicalEvidence = readFileSync(record(f, id).artifacts.result, 'utf8');
  put(join(f.control, 'active.json'), { runId: id });
  const releasePending = await manage(f, 'Recover', mutationArgs(id));
  assert.equal(releasePending.code, 0, releasePending.stderr);
  assert.equal(releasePending.value.alreadyRecovered, true);
  assert.equal(releasePending.value.applied, true);
  assert.equal(active(f), null);
  assert.deepEqual(record(f, id).recovery, recoveryEvidence);
  assert.equal(readFileSync(record(f, id).artifacts.result, 'utf8'), canonicalEvidence);
  assert.equal((await run(f, ['-Session', 'session-fixture']).done).code, 0);
});

test('interrupted finalization retains recorded exit and preserves an existing canonical result', async () => {
  const f = fixture('finalization');
  const helper = join(f.bridge, 'node', 'run-report.mjs');
  const clean = readFileSync(helper, 'utf8'), signal = join(f.repo, 'finalizing.marker');
  writeFileSync(helper, clean.replace('export function finalizeRun(facts) {',
    'export function finalizeRun(facts) { writeFileSync(' + JSON.stringify(signal) + ", String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);"));
  const handle = run(f);
  await until(() => existsSync(signal), 'finalization marker');
  const id = active(f);
  assert.equal(record(f, id).exitKnown, true);
  const finalizerPid = Number(readFileSync(signal, 'utf8'));
  assert.ok(alive(finalizerPid));
  handle.child.kill();
  await handle.done;
  await until(() => !alive(finalizerPid), 'finalizer stopped with bridge');
  writeFileSync(helper, clean);
  const recovered = await manage(f, 'Recover', mutationArgs(id));
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.equal(result(f, id).execution.status, 'SUCCEEDED');
  assert.equal(result(f, id).acceptance.status, 'PENDING');
  const path = record(f, id).artifacts.result, original = readFileSync(path, 'utf8');
  const earlier = record(f, id);
  earlier.stage = 'FINALIZING'; earlier.recovery = null;
  put(join(f.control, 'runs', id + '.json'), earlier);
  put(join(f.control, 'active.json'), { runId: id });
  const again = await manage(f, 'Recover', mutationArgs(id));
  assert.equal(again.code, 0, again.stderr);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('malformed ownership and unsafe recovery paths fail closed and preserve evidence', async () => {
  const f = fixture('unsafe state');
  assert.equal((await run(f).done).code, 0);
  const id = (await manage(f, 'Status')).value.runs[0].runId;
  writeFileSync(join(f.control, 'active.json'), '{broken');
  assert.notEqual((await run(f).done).code, 0);
  assert.ok((await manage(f, 'Scan')).value.errors.length > 0);
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal(readFileSync(join(f.control, 'active.json'), 'utf8'), '{broken');
  const saved = record(f, id);
  saved.stage = 'FINALIZING';
  put(join(f.control, 'runs', id + '.json'), saved);
  put(join(f.control, 'active.json'), { runId: id });
  const facts = json(saved.factsPath), sentinel = join(suite, 'outside-sentinel');
  writeFileSync(sentinel, 'preserve');
  facts.artifacts.result = sentinel;
  put(saved.factsPath, facts);
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve');
  assert.equal(active(f), id);
  writeFileSync(join(f.control, 'runs', id + '.json'), '{}');
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal((await manage(f, 'Scan')).value.runs[0].state, 'UNKNOWN');
});

test('stale PID identity never kills its current occupant; racing recovery is idempotent', async () => {
  const f = fixture('pid identity');
  assert.equal((await run(f).done).code, 0);
  const id = (await manage(f, 'Status')).value.runs[0].runId, saved = record(f, id);
  saved.stage = 'FINALIZING';
  saved.owner = { pid: process.pid, createdUtc: '2000-01-01T00:00:00.0000000Z' };
  put(join(f.control, 'runs', id + '.json'), saved);
  put(join(f.control, 'active.json'), { runId: id });
  const outcomes = await Promise.all([manage(f, 'Recover', mutationArgs(id)), manage(f, 'Recover', mutationArgs(id))]);
  for (const outcome of outcomes) assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcomes.filter(item => item.value.applied).length, 1);
  assert.equal(active(f), null);
  assert.ok(alive(process.pid));
  // A delayed recovery must not clear ownership acquired by a later run.
  const next = run(f, [], { LIFECYCLE_HOLD: '1' });
  await writers(f);
  const nextId = active(f);
  assert.notEqual(nextId, id);
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal(active(f), nextId);
  assert.equal((await manage(f, 'Stop', mutationArgs(nextId))).code, 0);
  await next.done;
});

test('simultaneous launchers start only one task and uncertain identity prevents recovery', async () => {
  const f = fixture('simultaneous starts');
  const attempts = [run(f, [], { LIFECYCLE_HOLD: '1' }), run(f, ['-OutDir', 'alternate'], { LIFECYCLE_HOLD: '1' })];
  await writers(f);
  const id = active(f), owner = record(f, id).owner.pid;
  const winner = attempts.find(handle => handle.child.pid === owner);
  assert.ok(winner);
  const loser = attempts.find(handle => handle !== winner);
  assert.notEqual((await loser.done).code, 0);
  assert.equal(readFileSync(join(f.repo, 'launches.log'), 'utf8').trim().split('\n').length, 1);
  assert.equal((await manage(f, 'Stop', mutationArgs(id))).code, 0);
  await winner.done;
  // Inject an access-denied observation into this disposable copied observer only.
  const lifecycle = join(f.bridge, 'windows', 'lib', 'run-lifecycle.ps1');
  writeFileSync(lifecycle, readFileSync(lifecycle, 'utf8').replace(
    'try {\n        $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)',
    "try {\n        throw [UnauthorizedAccessException]::new('fixture inaccessible process')\n        $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)",
  ).replace(
    'try {\r\n        $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)',
    "try {\r\n        throw [UnauthorizedAccessException]::new('fixture inaccessible process')\r\n        $process = [Diagnostics.Process]::GetProcessById([int]$Identity.pid)",
  ));
  const saved = record(f, id);
  saved.stage = 'FINALIZING';
  put(join(f.control, 'runs', id + '.json'), saved);
  put(join(f.control, 'active.json'), { runId: id });
  assert.equal((await manage(f, 'Scan')).value.runs[0].state, 'UNKNOWN');
  assert.notEqual((await manage(f, 'Recover', mutationArgs(id))).code, 0);
  assert.equal(active(f), id);
});

test('preparation is contained and stoppable before a DSH task starts', async () => {
  const f = fixture('preparation stop');
  writeFileSync(join(f.bridge, 'windows', 'setup.ps1'),
    "[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../../preparing.pid'), [string]$PID)\nStart-Sleep -Seconds 60\n");
  const handle = run(f);
  const marker = join(f.repo, 'preparing.pid');
  await until(() => existsSync(marker), 'preflight started');
  const preflightPid = Number(readFileSync(marker, 'utf8')), id = active(f);
  assert.equal(record(f, id).stage, 'PREPARING');
  assert.equal((await manage(f, 'Stop', mutationArgs(id))).code, 0);
  assert.notEqual((await handle.done).code, 0);
  await until(() => !alive(preflightPid), 'contained preflight stopped');
  assert.equal(existsSync(join(f.repo, 'launches.log')), false);
  assert.equal(active(f), null);
  assert.equal(record(f, id).outcome, 'LAUNCH_FAILED');
});

test('junction output escapes and hard-linked ownership files are refused', async () => {
  const f = fixture('path boundaries'), outside = join(suite, 'outside output');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'preserve');
  const alias = join(f.repo, 'linked-output');
  symlinkSync(outside, alias, 'junction');
  const outcome = await run(f, ['-OutDir', alias]).done;
  assert.notEqual(outcome.code, 0);
  assert.equal(existsSync(join(f.repo, 'launches.log')), false);
  assert.deepEqual(readdirSync(outside), ['sentinel']);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'preserve');
  const reserved = await run(f, ['-OutDir', '.dsh-runs/control/runs']).done;
  assert.notEqual(reserved.code, 0);
  assert.match(reserved.stderr, /reserved/);
  assert.equal(active(f), null);
  assert.ok((await manage(f, 'Scan')).value.runs.every(item => item.state === 'FINISHED'));
  const external = join(suite, 'external-owner.json');
  writeFileSync(external, '{"runId":"20260101-000000-abcdef12"}');
  linkSync(external, join(f.control, 'active.json'));
  assert.notEqual((await run(f).done).code, 0);
  assert.match((await manage(f, 'Scan')).value.errors.join(' '), /Hard-linked/);
  assert.equal(readFileSync(external, 'utf8'), '{"runId":"20260101-000000-abcdef12"}');
});
