import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

import { captureProcess } from '../../dsh-codex-bridge/node/capture-process.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgeScript = join(repoRoot, 'dsh-codex-bridge', 'dsh-impl.ps1');
const shippedConfig = join(repoRoot, 'dsh-codex-bridge', 'bridge.config.json');
const mcpServerSource = join(repoRoot, 'dsh-codex-bridge', 'mcp', 'dsh-mcp-server.mjs');

const suiteRoot = mkdtempSync(join(tmpdir(), 'bridge-config-tests-'));
const suiteRootResolved = resolve(suiteRoot);
const temporaryRootResolved = resolve(tmpdir());
if (!suiteRootResolved.toLowerCase().startsWith(`${temporaryRootResolved.toLowerCase()}${sep}`)) {
  throw new Error(`test fixture escaped the temporary directory: ${suiteRootResolved}`);
}
after(() => {
  // Only the exact unique suite directory created above is removed.
  rmSync(suiteRootResolved, { recursive: true, force: true });
});

function caseDirectory(name) {
  const directory = join(suiteRoot, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeFixtureRepo(name) {
  const repo = join(suiteRoot, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'design.md'), '# Fixture design\n\nImplement the fixture behavior.\n', 'utf8');
  return repo;
}

function writeConfig(repo, relativePath, body) {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

async function runBridge(script, args, env = {}) {
  return await captureProcess(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-File', script, ...args],
    {
      env: { ...process.env, ...env },
      timeoutMs: 60_000,
    },
  );
}

function parseResolved(output) {
  const lines = output.split(/\r?\n/);
  const lineStartingWith = (prefix) => {
    const line = lines.find((candidate) => candidate.startsWith(prefix));
    assert.ok(line, `missing "${prefix}" in dry-run output:\n${output}`);
    return line.slice(prefix.length);
  };

  const effort = lineStartingWith('reasoning effort: ').match(/^(\S+) \(source: (.+)\)$/);
  assert.ok(effort, `could not parse reasoning effort line:\n${output}`);
  const policy = lineStartingWith('codex review edits: ').match(/^(.+?) \(source: (.+)\)$/);
  assert.ok(policy, `could not parse Codex review edits line:\n${output}`);

  return {
    model: lineStartingWith('model: '),
    effort: effort[1],
    effortSource: effort[2],
    policy: policy[1],
    policySource: policy[2],
    configuration: lineStartingWith('configuration: '),
    preflightMaxObjects: Number(lineStartingWith('preflight object limit: ')),
    patch: lineStartingWith('patch: '),
    prompt: lineStartingWith('# prompt (').replace(/\)$/, ''),
  };
}

function readPatch(patchPath) {
  assert.ok(isAbsolute(patchPath), `patch path is not absolute: ${patchPath}`);
  assert.ok(existsSync(patchPath), `patch does not exist: ${patchPath}`);
  const patch = readFileSync(patchPath, 'utf8');
  assert.match(patch, /^- id: agent-default-model$/m);
  assert.match(patch, /^  config:$/m);
  assert.match(patch, /^    provider: deepseek-official$/m);
  assert.match(patch, /^    model: deepseek-flash$/m);
  const settingKeys = [...patch.matchAll(/^    ([A-Za-z][A-Za-z0-9]*):/gm)].map((match) => match[1]);
  assert.deepEqual(settingKeys, ['provider', 'model', 'reasoningEffort']);
  return patch;
}

function assertPromptPolicy(promptPath, policy) {
  const prompt = readFileSync(promptPath, 'utf8');
  assert.ok(prompt.includes(`Codex review policy for this run: ${policy}.`));
  assert.ok(prompt.includes('do not edit user profiles, credentials, authentication or settings'));
  assert.ok(prompt.includes('Neither setting changes DSH\'s role or grants DSH commit/publication permission.'));
  return prompt;
}

function artifactsWithSuffix(directory, suffix) {
  return readdirSync(directory).filter((name) => name.endsWith(suffix)).sort();
}

function makeFakeDsh() {
  const directory = join(suiteRoot, 'fake-dsh');
  mkdirSync(directory, { recursive: true });
  const recorder = join(directory, 'recorder.cjs');
  writeFileSync(
    recorder,
    [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const stdin = fs.readFileSync(0, 'utf8');",
      'fs.writeFileSync(process.env.FAKE_DSH_CAPTURE, JSON.stringify({',
      '  // Node consumes the literal first dsh argument as its script path.',
      '  argv: [path.basename(process.argv[1]), ...process.argv.slice(2)],',
      '  cwd: process.cwd(),',
      '  permissionMode: process.env.DSH_PERMISSION_MODE,',
      '  stdin,',
      '}, null, 2));',
      "process.stdout.write(JSON.stringify({ type: 'final', text: 'FAKE DSH COMPLETE' }) + '\\n');",
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    env(capturePath) {
      const preloadPath = recorder.split(sep).join('/');
      const preload = /\s/.test(preloadPath) ? `"${preloadPath}"` : preloadPath;
      return {
        NODE_OPTIONS: `--require ${preload}`,
        FAKE_DSH_CAPTURE: capturePath,
      };
    },
  };
}

const fakeDsh = makeFakeDsh();

test('shipped config is the implicit default and dry run writes a patch', async () => {
  const repo = writeFixtureRepo('shipped-config repo');
  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out dir',
    '-Dsh', process.execPath,
    '-DryRun',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const resolved = parseResolved(result.stdout);
  assert.equal(resolved.model, 'deepseek-official/deepseek-flash');
  assert.equal(resolved.effort, 'max');
  assert.equal(resolved.policy, 'Not Allow');
  assert.ok(resolved.configuration.includes(shippedConfig));
  assert.ok(resolved.configuration.includes('(implicit)'));
  assert.equal(resolved.effortSource, shippedConfig);
  assert.equal(resolved.policySource, shippedConfig);
  assert.equal(resolved.preflightMaxObjects, 28000);

  assert.equal(dirname(resolved.patch), dirname(resolved.prompt));
  assert.equal(
    resolved.patch.slice(0, -'-patch.yml'.length),
    resolved.prompt.slice(0, -'-prompt.md'.length),
  );
  const patch = readPatch(resolved.patch);
  assert.match(patch, /^    reasoningEffort: max$/m);
  assert.ok(resolved.prompt.endsWith('-prompt.md'));
  assert.ok(existsSync(resolved.prompt));
  const prompt = assertPromptPolicy(resolved.prompt, 'Not Allow');
  assert.ok(prompt.includes('Implement the fixture behavior.'));
  assert.equal(readFileSync(join(repo, 'out dir', '.gitignore'), 'utf8'), '*\n');
});

test('absent implicit config uses built-in max and Not Allow defaults', async () => {
  const directory = caseDirectory('missing-implicit');
  const script = join(directory, 'bridge', 'dsh-impl.ps1');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(bridgeScript, script);
  const repo = writeFixtureRepo('missing-implicit repo');

  const result = await runBridge(script, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-DryRun',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const resolved = parseResolved(result.stdout);
  assert.equal(resolved.effort, 'max');
  assert.equal(resolved.policy, 'Not Allow');
  assert.equal(resolved.configuration, 'built-in defaults');
  assert.equal(resolved.effortSource, 'built-in default');
  assert.equal(resolved.policySource, 'built-in default');
  assert.equal(resolved.preflightMaxObjects, 28000);
  assert.match(readPatch(resolved.patch), /^    reasoningEffort: max$/m);
});

test('dry run shows explicit preflight object limits', async () => {
  const repo = writeFixtureRepo('preflight-limit repo');
  for (const limit of [50000, 0]) {
    const result = await runBridge(bridgeScript, [
      '-Repo', repo,
      '-Spec', 'design.md',
      '-OutDir', `out-${limit}`,
      '-Dsh', process.execPath,
      '-MaxObjects', String(limit),
      '-DryRun',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const resolved = parseResolved(result.stdout);
    assert.equal(resolved.preflightMaxObjects, limit);
  }
});

test('a partial explicit config keeps the other built-in default', async () => {
  const repo = writeFixtureRepo('partial-config repo');
  writeConfig(repo, 'bridge.json', '{"reasoningEffort":"low"}\n');

  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-DryRun',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const resolved = parseResolved(result.stdout);
  assert.equal(resolved.effort, 'low');
  assert.ok(resolved.effortSource.endsWith('bridge.json'));
  assert.equal(resolved.policy, 'Not Allow');
  assert.equal(resolved.policySource, 'built-in default');
  assert.ok(resolved.configuration.endsWith('bridge.json (explicit)'));
  assert.match(readPatch(resolved.patch), /^    reasoningEffort: low$/m);
});

test('explicit parameters override each config setting independently and canonicalize case', async () => {
  const repo = writeFixtureRepo('override repo');
  writeConfig(repo, 'bridge.json', '{"reasoningEffort":"off","codexReviewEdits":"Allow"}\n');

  const effortOnly = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out-effort',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-ReasoningEffort', 'MAX',
    '-DryRun',
  ]);
  assert.equal(effortOnly.code, 0, effortOnly.stderr);
  const effortResolved = parseResolved(effortOnly.stdout);
  assert.equal(effortResolved.effort, 'max');
  assert.equal(effortResolved.effortSource, 'command line');
  assert.equal(effortResolved.policy, 'Allow');
  assert.ok(effortResolved.policySource.endsWith('bridge.json'));
  assert.match(readPatch(effortResolved.patch), /^    reasoningEffort: max$/m);

  const policyOnly = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out-policy',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-CodexReviewEdits', 'not allow',
    '-DryRun',
  ]);
  assert.equal(policyOnly.code, 0, policyOnly.stderr);
  const policyResolved = parseResolved(policyOnly.stdout);
  assert.equal(policyResolved.effort, 'off');
  assert.ok(policyResolved.effortSource.endsWith('bridge.json'));
  assert.equal(policyResolved.policy, 'Not Allow');
  assert.equal(policyResolved.policySource, 'command line');
  assert.match(readPatch(policyResolved.patch), /^    reasoningEffort: off$/m);
  assertPromptPolicy(policyResolved.prompt, 'Not Allow');

  const combined = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out-combined',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-ReasoningEffort', 'MAX',
    '-CodexReviewEdits', 'not allow',
    '-DryRun',
  ]);
  assert.equal(combined.code, 0, combined.stderr);
  const combinedResolved = parseResolved(combined.stdout);
  assert.equal(combinedResolved.effort, 'max');
  assert.equal(combinedResolved.effortSource, 'command line');
  assert.equal(combinedResolved.policy, 'Not Allow');
  assert.equal(combinedResolved.policySource, 'command line');
  assert.match(readPatch(combinedResolved.patch), /^    reasoningEffort: max$/m);
  assertPromptPolicy(combinedResolved.prompt, 'Not Allow');
});

test('all supported effort values flow into the generated patch', async () => {
  const repo = writeFixtureRepo('efforts repo');
  for (const effort of ['off', 'low', 'high', 'max']) {
    const result = await runBridge(bridgeScript, [
      '-Repo', repo,
      '-Spec', 'design.md',
      '-OutDir', `out-${effort}`,
      '-Dsh', process.execPath,
      '-ReasoningEffort', effort,
      '-DryRun',
    ]);
    assert.equal(result.code, 0, result.stderr);
    const resolved = parseResolved(result.stdout);
    assert.equal(resolved.effort, effort);
    assert.match(readPatch(resolved.patch), new RegExp(`^    reasoningEffort: ${effort}$`, 'm'));
  }
});

test('Allow is included in the generated prompt', async () => {
  const repo = writeFixtureRepo('allow-policy repo');
  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-CodexReviewEdits', 'Allow',
    '-DryRun',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const resolved = parseResolved(result.stdout);
  assert.equal(resolved.policy, 'Allow');
  const prompt = assertPromptPolicy(resolved.prompt, 'Allow');
  assert.ok(prompt.includes('small, localized fixes tied to a recorded review finding'));
});

test('explicit relative config paths resolve against Repo and support spaces', async () => {
  const repo = writeFixtureRepo('relative config repo');
  writeConfig(repo, join('config dir', 'my config.json'), '{"codexReviewEdits":"allow"}\n');

  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-Config', 'config dir/my config.json',
    '-DryRun',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const resolved = parseResolved(result.stdout);
  assert.equal(resolved.policy, 'Allow');
  assert.ok(resolved.policySource.endsWith(join('config dir', 'my config.json')));
  assert.ok(resolved.configuration.endsWith('my config.json (explicit)'));
  assert.match(readPatch(resolved.patch), /^    reasoningEffort: max$/m);
});

test('explicit missing config fails before writing run artifacts', async () => {
  const repo = writeFixtureRepo('missing config repo');
  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-Config', 'does-not-exist.json',
    '-DryRun',
  ]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Configuration file not found/);
  assert.equal(existsSync(join(repo, 'out')), false);
});

test('an invalid implicit config beside the bridge script fails', async () => {
  const directory = caseDirectory('invalid-implicit');
  const script = join(directory, 'bridge', 'dsh-impl.ps1');
  mkdirSync(dirname(script), { recursive: true });
  copyFileSync(bridgeScript, script);
  writeFileSync(join(directory, 'bridge', 'bridge.config.json'), '{"reasoningEffort":"ultra"}\n', 'utf8');
  const repo = writeFixtureRepo('invalid-implicit repo');

  const result = await runBridge(script, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-DryRun',
  ]);

  assert.notEqual(result.code, 0);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Configuration setting 'reasoningEffort' must be one of/,
  );
  assert.equal(existsSync(join(repo, 'out')), false);
});

test('invalid config is rejected without echoing file contents', async () => {
  const repo = writeFixtureRepo('invalid config repo');
  const cases = [
    {
      name: 'malformed JSON',
      body: '{"reasoningEffort":"max","sentinel":"SECRET_SENTINEL"',
      pattern: /not valid JSON/,
    },
    {
      name: 'array root',
      body: '[{"reasoningEffort":"max"}]',
      pattern: /root must be a JSON object/,
    },
    {
      name: 'null root',
      body: 'null',
      pattern: /root must be a JSON object/,
    },
    {
      name: 'unknown key',
      body: '{"unexpected":"SECRET_SENTINEL"}',
      pattern: /unknown setting 'unexpected'/,
    },
    {
      name: 'null effort',
      body: '{"reasoningEffort":null}',
      pattern: /reasoningEffort.*must be a string/,
    },
    {
      name: 'numeric effort',
      body: '{"reasoningEffort":5}',
      pattern: /reasoningEffort.*must be a string/,
    },
    {
      name: 'unsupported effort',
      body: '{"reasoningEffort":"ultra"}',
      pattern: /reasoningEffort.*must be one of: off, low, high, max/,
    },
    {
      name: 'null policy',
      body: '{"codexReviewEdits":null}',
      pattern: /codexReviewEdits.*must be a string/,
    },
    {
      name: 'unsupported policy',
      body: '{"codexReviewEdits":"yes"}',
      pattern: /codexReviewEdits.*must be 'Not Allow' or 'Allow'/,
    },
  ];

  for (const current of cases) {
    const configPath = writeConfig(repo, `invalid-${current.name.replaceAll(' ', '-')}.json`, current.body);
    const outDir = `out-${current.name.replaceAll(' ', '-')}`;
    const result = await runBridge(bridgeScript, [
      '-Repo', repo,
      '-Spec', 'design.md',
      '-OutDir', outDir,
      '-Dsh', process.execPath,
      '-Config', configPath,
      '-DryRun',
    ]);
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0, `${current.name} should fail:\n${combined}`);
    assert.match(combined, current.pattern, current.name);
    assert.ok(!combined.includes('SECRET_SENTINEL'), `${current.name} echoed file contents:\n${combined}`);
    assert.equal(existsSync(join(repo, outDir)), false, `${current.name} wrote artifacts`);
  }
});

test('invalid explicit parameters fail even when a valid config would override them', async () => {
  const repo = writeFixtureRepo('invalid parameter repo');
  writeConfig(repo, 'bridge.json', '{"reasoningEffort":"max","codexReviewEdits":"Not Allow"}\n');

  const invalidEffort = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out-effort',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-ReasoningEffort', 'ultra',
    '-DryRun',
  ]);
  assert.notEqual(invalidEffort.code, 0);
  assert.match(`${invalidEffort.stdout}\n${invalidEffort.stderr}`, /-ReasoningEffort must be one of/);

  const invalidPolicy = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out-policy',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-CodexReviewEdits', 'sometimes',
    '-DryRun',
  ]);
  assert.notEqual(invalidPolicy.code, 0);
  assert.match(`${invalidPolicy.stdout}\n${invalidPolicy.stderr}`, /-CodexReviewEdits must be 'Not Allow' or 'Allow'/);
});

test('an invalid config field fails even when an explicit parameter overrides it', async () => {
  const repo = writeFixtureRepo('invalid config override repo');
  writeConfig(repo, 'bridge.json', '{"reasoningEffort":"ultra"}\n');

  const result = await runBridge(bridgeScript, [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-Config', 'bridge.json',
    '-ReasoningEffort', 'low',
    '-DryRun',
  ]);

  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Configuration setting 'reasoningEffort' must be one of/);
});

test('two runs started together get unique prompts and patches', async () => {
  const repo = writeFixtureRepo('unique artifacts repo');
  const args = [
    '-Repo', repo,
    '-Spec', 'design.md',
    '-OutDir', 'out',
    '-Dsh', process.execPath,
    '-DryRun',
  ];
  const [first, second] = await Promise.all([
    runBridge(bridgeScript, args),
    runBridge(bridgeScript, args),
  ]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  const firstRun = parseResolved(first.stdout);
  const secondRun = parseResolved(second.stdout);
  assert.notEqual(firstRun.patch, secondRun.patch);
  assert.notEqual(firstRun.prompt, secondRun.prompt);
  assert.ok(existsSync(firstRun.patch));
  assert.ok(existsSync(secondRun.patch));
  assert.ok(existsSync(firstRun.prompt));
  assert.ok(existsSync(secondRun.prompt));
  assert.equal(artifactsWithSuffix(join(repo, 'out'), '-patch.yml').length, 2);
  assert.equal(artifactsWithSuffix(join(repo, 'out'), '-prompt.md').length, 2);
});

test('a normal run forwards the patch, session, mode, and environment to DSH', async () => {
  const repo = writeFixtureRepo('forwarding repo');
  const capturePath = join(repo, 'fake-dsh-capture.json');
  const result = await runBridge(
    bridgeScript,
    [
      '-Repo', repo,
      '-Spec', 'design.md',
      '-OutDir', 'run dir',
      '-Dsh', process.execPath,
      '-Mode', 'workspace-write',
      '-Session', 'session-test-123',
      '-Task', 'reviewer feedback for this round',
      '-SkipWindowsPreflight',
    ],
    fakeDsh.env(capturePath),
  );

  assert.equal(result.code, 0, result.stderr);
  const capture = JSON.parse(readFileSync(capturePath, 'utf8'));
  const patchPath = capture.argv[2];
  assert.deepEqual(capture.argv, [
    'headless',
    '--patch',
    patchPath,
    '--json',
    '--session-id',
    'session-test-123',
    '-',
  ]);
  assert.ok(isAbsolute(patchPath));
  assert.ok(existsSync(patchPath));
  assert.match(readPatch(patchPath), /^    reasoningEffort: max$/m);
  assert.equal(capture.cwd, repo);
  assert.equal(capture.permissionMode, 'workspace-write');
  assert.ok(capture.stdin.includes('Codex review policy for this run: Not Allow.'));
  assert.ok(capture.stdin.includes('reviewer feedback for this round'));
  assert.ok(capture.stdin.includes('Implement the fixture behavior.'));

  const reportPathLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('report: '));
  assert.ok(reportPathLine, result.stdout);
  const reportPath = resolve(repo, reportPathLine.slice('report: '.length));
  const report = readFileSync(reportPath, 'utf8');
  assert.match(report, /\| model \| deepseek-official\/deepseek-flash \|/);
  assert.match(report, /\| preflight object limit \| 28000 \|/);
  assert.match(report, /\| reasoning effort \| max \(source: .*bridge\.config\.json\) \|/);
  assert.match(report, /\| Codex review edits \| Not Allow \(source: .*bridge\.config\.json\) \|/);
  assert.match(report, /\| configuration \| .*bridge\.config\.json \(implicit\) \|/);
  assert.match(report, /FAKE DSH COMPLETE/);
});

test('normal preflight forwards default, 50000, and zero object limits', async () => {
  const directory = caseDirectory('preflight');
  const script = join(directory, 'bridge', 'dsh-impl.ps1');
  const setupScript = join(directory, 'bridge', 'windows', 'setup.ps1');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(dirname(setupScript), { recursive: true });
  copyFileSync(bridgeScript, script);
  writeFileSync(
    setupScript,
    [
      'param([string]$Repo = "", [string]$Action = "", [string]$MaxObjects = "")',
      '$payload = @{',
      '  repo = $Repo',
      '  action = $Action',
      '  maxObjectsBound = $PSBoundParameters.ContainsKey("MaxObjects")',
      '  maxObjects = $MaxObjects',
      '} | ConvertTo-Json -Compress',
      '[IO.File]::WriteAllText($env:FAKE_PREFLIGHT_CAPTURE, $payload)',
      'Write-Output "RESULT: READY"',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );

  const repo = writeFixtureRepo('preflight repo');
  const cases = [
    { args: [], expected: 28000 },
    { args: ['-MaxObjects', '50000'], expected: 50000 },
    { args: ['-MaxObjects', '0'], expected: 0 },
  ];

  for (const current of cases) {
    const outDir = `out-${current.expected}`;
    const preflightCapture = join(directory, `preflight-${current.expected}.json`);
    const dshCapture = join(directory, `dsh-${current.expected}.json`);
    const env = {
      ...fakeDsh.env(dshCapture),
      FAKE_PREFLIGHT_CAPTURE: preflightCapture,
    };
    const result = await runBridge(
      script,
      [
        '-Repo', repo,
        '-Spec', 'design.md',
        '-OutDir', outDir,
        '-Dsh', process.execPath,
        '-Mode', 'workspace-write',
        ...current.args,
      ],
      env,
    );

    assert.equal(result.code, 0, result.stderr);
    const preflight = JSON.parse(readFileSync(preflightCapture, 'utf8'));
    assert.equal(preflight.repo, repo);
    assert.equal(preflight.action, 'Check');
    assert.equal(preflight.maxObjectsBound, true);
    assert.equal(preflight.maxObjects, String(current.expected));
    assert.match(result.stdout, /windows sandbox preflight: RESULT: READY/);
    assert.ok(existsSync(dshCapture));
    const reportPathLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('report: '));
    assert.ok(reportPathLine, result.stdout);
    const report = readFileSync(resolve(repo, reportPathLine.slice('report: '.length)), 'utf8');
    assert.match(report, new RegExp(`\\| preflight object limit \\| ${current.expected} \\|`));
  }
});

test('invalid bridge max object input fails before preflight, DSH, and artifacts', async () => {
  const directory = caseDirectory('invalid-max-objects');
  const script = join(directory, 'bridge', 'dsh-impl.ps1');
  const setupScript = join(directory, 'bridge', 'windows', 'setup.ps1');
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(dirname(setupScript), { recursive: true });
  copyFileSync(bridgeScript, script);
  writeFileSync(
    setupScript,
    [
      'param([string]$Repo = "", [string]$Action = "", [string]$MaxObjects = "")',
      '[IO.File]::WriteAllText($env:FAKE_PREFLIGHT_CAPTURE, "preflight-ran")',
      'Write-Output "RESULT: READY"',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );
  const repo = writeFixtureRepo('invalid-max-objects repo');

  for (const current of [
    { value: '-1', tag: 'negative' },
    { value: '2147483648', tag: 'out-of-range' },
    { value: 'not-an-integer', tag: 'non-integer' },
  ]) {
    const outDir = `out-${current.tag}`;
    const preflightCapture = join(directory, `preflight-${current.tag}.json`);
    const dshCapture = join(directory, `dsh-${current.tag}.json`);
    const result = await runBridge(
      script,
      [
        '-Repo', repo,
        '-Spec', 'design.md',
        '-OutDir', outDir,
        '-Dsh', process.execPath,
        '-Mode', 'workspace-write',
        '-MaxObjects', current.value,
      ],
      {
        ...fakeDsh.env(dshCapture),
        FAKE_PREFLIGHT_CAPTURE: preflightCapture,
      },
    );

    const combined = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.code, 0, `${current.tag} should fail:\n${combined}`);
    assert.match(combined, /MaxObjects/, current.tag);
    assert.equal(existsSync(preflightCapture), false, `${current.tag} ran preflight`);
    assert.equal(existsSync(dshCapture), false, `${current.tag} launched DSH`);
    assert.equal(existsSync(join(repo, outDir)), false, `${current.tag} wrote artifacts`);
  }
});

function runMcpWithFileStdio(serverPath, messages, env, cwd) {
  // Keep this fixture under the containment-checked suite root. The suite-level
  // after() hook owns recursive removal, so error/close handlers never delete and
  // then read the same paths.
  const directory = mkdtempSync(join(suiteRoot, 'mcp-stdio-'));
  const inputPath = join(directory, 'stdin.jsonl');
  const outputPath = join(directory, 'stdout.jsonl');
  const errorPath = join(directory, 'stderr.log');
  writeFileSync(inputPath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf8');

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

    child.once('error', (error) => {
      settle(() => rejectPromise(error));
    });
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

test('MCP schema and runtime arguments map to the exact bridge parameters', async () => {
  const directory = caseDirectory('mcp');
  const serverDirectory = join(directory, 'mcp');
  mkdirSync(serverDirectory, { recursive: true });
  const serverPath = join(serverDirectory, 'dsh-mcp-server.mjs');
  copyFileSync(mcpServerSource, serverPath);
  const bridgePath = join(directory, 'dsh-impl.ps1');
  writeFileSync(
    bridgePath,
    [
      '$payload = @{ args = @($args); cwd = (Get-Location).Path } | ConvertTo-Json -Compress',
      '$callFile = Join-Path $env:FAKE_BRIDGE_LOG_DIR ("call-" + [guid]::NewGuid().ToString("N") + ".json")',
      '[IO.File]::WriteAllText($callFile, $payload)',
      'Write-Output "fake bridge ok"',
      'exit 0',
      '',
    ].join('\n'),
    'utf8',
  );

  const logDirectory = join(directory, 'bridge-calls');
  mkdirSync(logDirectory, { recursive: true });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'dsh_implement',
        arguments: {
          spec: 'docs/design/x.md',
          task: 'do work',
          session: 'session-42',
          repo: 'C:\\repo path',
          mode: 'workspace-write',
          config: 'config dir/my config.json',
          reasoning_effort: 'max',
          codex_review_edits: 'Allow',
          max_objects: 50000,
        },
      },
    },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', reasoning_effort: 'MAX' } },
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', codex_review_edits: 'allow' } },
    },
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', config: 42 } },
    },
    {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', codex_review_edits: null } },
    },
    {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'minimal.md' } },
    },
    {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'zero.md', max_objects: 0 } },
    },
    {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', max_objects: -1 } },
    },
    {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', max_objects: 1.5 } },
    },
    {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', max_objects: '50000' } },
    },
    {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'dsh_implement', arguments: { spec: 'x.md', max_objects: 2147483648 } },
    },
  ];

  const result = await runMcpWithFileStdio(
    serverPath,
    messages,
    { FAKE_BRIDGE_LOG_DIR: logDirectory },
    repoRoot,
  );
  assert.equal(result.code, 0, result.stderr);
  const responses = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
  const byId = new Map(responses.map((response) => [response.id, response]));

  const tool = byId.get(2).result.tools.find((candidate) => candidate.name === 'dsh_implement');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['spec']);
  assert.deepEqual(tool.inputSchema.properties.reasoning_effort.enum, ['off', 'low', 'high', 'max']);
  assert.deepEqual(tool.inputSchema.properties.codex_review_edits.enum, ['Not Allow', 'Allow']);
  assert.equal(tool.inputSchema.properties.max_objects.type, 'integer');
  assert.equal(tool.inputSchema.properties.max_objects.minimum, 0);
  assert.equal(tool.inputSchema.properties.max_objects.maximum, 2147483647);
  assert.equal(Object.hasOwn(tool.inputSchema.properties.reasoning_effort, 'default'), false);
  assert.equal(Object.hasOwn(tool.inputSchema.properties.codex_review_edits, 'default'), false);
  assert.equal(Object.hasOwn(tool.inputSchema.properties.config, 'default'), false);
  assert.equal(Object.hasOwn(tool.inputSchema.properties.max_objects, 'default'), false);

  assert.equal(byId.get(3).result.isError, false);
  assert.match(byId.get(3).result.content[0].text, /fake bridge ok/);
  assert.equal(byId.get(8).result.isError, false);
  assert.equal(byId.get(9).result.isError, false);
  for (const id of [4, 5, 6, 7, 10, 11, 12, 13]) {
    assert.equal(byId.get(id).result.isError, true, `call ${id} should be rejected`);
  }
  assert.match(byId.get(4).result.content[0].text, /reasoning_effort/);
  assert.match(byId.get(5).result.content[0].text, /codex_review_edits/);
  assert.match(byId.get(6).result.content[0].text, /config/);
  assert.match(byId.get(7).result.content[0].text, /codex_review_edits/);
  for (const id of [10, 11, 12, 13]) {
    assert.match(byId.get(id).result.content[0].text, /max_objects/);
  }

  const callFiles = readdirSync(logDirectory).filter((name) => name.endsWith('.json'));
  assert.equal(callFiles.length, 3, 'invalid calls must not spawn the bridge');
  const bridgeCalls = callFiles.map((name) =>
    JSON.parse(readFileSync(join(logDirectory, name), 'utf8')).args,
  );
  const richArgs = bridgeCalls.find((args) => args.includes('docs/design/x.md'));
  const minimalArgs = bridgeCalls.find((args) => args.includes('minimal.md'));
  const zeroArgs = bridgeCalls.find((args) => args.includes('zero.md'));
  assert.ok(richArgs);
  assert.ok(minimalArgs);
  assert.ok(zeroArgs);
  assert.deepEqual(minimalArgs, ['-Spec', 'minimal.md']);
  assert.deepEqual(zeroArgs, ['-Spec', 'zero.md', '-MaxObjects', '0']);

  const valueFor = (flag) => {
    const index = richArgs.indexOf(flag);
    assert.ok(index >= 0, `missing ${flag} in ${JSON.stringify(richArgs)}`);
    assert.ok(index + 1 < richArgs.length, `missing value for ${flag}`);
    return richArgs[index + 1];
  };
  assert.equal(valueFor('-Spec'), 'docs/design/x.md');
  assert.equal(valueFor('-Task'), 'do work');
  assert.equal(valueFor('-Session'), 'session-42');
  assert.equal(valueFor('-Repo'), 'C:\\repo path');
  assert.equal(valueFor('-Mode'), 'workspace-write');
  assert.equal(valueFor('-Config'), 'config dir/my config.json');
  assert.equal(valueFor('-ReasoningEffort'), 'max');
  assert.equal(valueFor('-CodexReviewEdits'), 'Allow');
  assert.equal(valueFor('-MaxObjects'), '50000');
});
