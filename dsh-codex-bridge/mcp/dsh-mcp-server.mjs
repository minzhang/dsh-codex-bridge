#!/usr/bin/env node
// Minimal MCP (Model Context Protocol) stdio server that exposes the dsh bridge as one tool.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout; nothing else on stdout, ever.
//
//   node dsh-mcp-server.mjs
//
// Codex:   codex mcp add dsh -- node <abs path>\dsh-mcp-server.mjs
// config:  [mcp_servers.dsh] command = "node" args = ["<abs path>\\dsh-mcp-server.mjs"]

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SERVER_NAME = 'dsh-bridge';
const SERVER_VERSION = '0.1.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const here = dirname(fileURLToPath(import.meta.url));
const bridgeScript = resolve(join(here, '..', 'dsh-impl.ps1'));
const REASONING_EFFORTS = ['off', 'low', 'high', 'max'];
const CODEX_REVIEW_EDITS = ['Not Allow', 'Allow'];

const TOOL = {
  name: 'dsh_implement',
  description:
    'Delegate ONE implementation task to DeepSeek Harness (dsh). Pass the path to an approved ' +
    'design document; the implementer edits the repository, runs the acceptance checks it finds ' +
    'in the design, and returns a STATUS/CHANGES/CHECKS/DECISIONS/FOLLOW-UPS report. It cannot ' +
    'ask questions: a BLOCKED status means the design is missing a decision. Changes stay ' +
    'uncommitted in the working tree for review.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'string',
        description: 'Design document path, relative to the repository root (e.g. docs/design/001-auth.md).',
      },
      task: {
        type: 'string',
        description: 'Extra instructions for this round, e.g. reviewer feedback to apply.',
      },
      session: {
        type: 'string',
        description: 'Resume this dsh session id (from a previous report) instead of starting a new one.',
      },
      repo: {
        type: 'string',
        description: 'Absolute path to the repository root. Defaults to the server process cwd.',
      },
      mode: {
        type: 'string',
        enum: ['workspace-write', 'read-only', 'danger-full-access'],
        description: 'Sandbox mode. Default workspace-write (writes confined to the repo).',
      },
      timeout_minutes: {
        type: 'number',
        description: 'Hard wall-clock limit for the run. Default 90.',
      },
      config: {
        type: 'string',
        description:
          'Optional bridge configuration JSON path. Relative paths resolve against the repository root. ' +
          'When omitted, the bridge uses bridge.config.json beside the bridge script or built-in defaults.',
      },
      reasoning_effort: {
        type: 'string',
        enum: REASONING_EFFORTS,
        description:
          'Optional reasoning effort. Overrides the configuration file; defaults to the configuration or max.',
      },
      codex_review_edits: {
        type: 'string',
        enum: CODEX_REVIEW_EDITS,
        description:
          'Optional post-review Codex edit policy. Overrides the configuration file; defaults to the ' +
          'configuration or Not Allow.',
      },
      max_objects: {
        type: 'integer',
        minimum: 0,
        maximum: 2147483647,
        description:
          'Optional maximum object count for the Windows sandbox preflight, including folders and metadata. ' +
          'When omitted, the bridge uses its default. Use 0 to explicitly disable the count cap.',
      },
      skip_windows_preflight: {
        type: 'boolean',
        description:
          'Diagnose an unsupported Windows installation by skipping the read-only sandbox preflight. ' +
          'Does not change the DSH permission mode.',
      },
    },
    required: ['spec'],
  },
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function runBridge(args) {
  return new Promise((resolvePromise) => {
    // Redirect the child to files rather than pipes: no buffering deadlocks, and it works
    // under Windows sandboxes that refuse piped stdio between processes.
    const stem = join(tmpdir(), `dsh-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const outPath = `${stem}-out.log`;
    const errPath = `${stem}-err.log`;
    let outFd;
    let errFd;
    try {
      outFd = openSync(outPath, 'w');
      errFd = openSync(errPath, 'w');
    } catch (error) {
      resolvePromise({ code: -1, stdout: '', stderr: `cannot open capture files: ${error.message}` });
      return;
    }

    const cleanup = () => {
      for (const [fd, path] of [
        [outFd, outPath],
        [errFd, errPath],
      ]) {
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(path);
        } catch {}
      }
    };

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', bridgeScript, ...args], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });

    child.on('error', (error) => {
      settle({ code: -1, stdout: '', stderr: `failed to start pwsh: ${error.message}` });
    });

    child.on('close', (code) => {
      let stdout = '';
      let stderr = '';
      try {
        stdout = readFileSync(outPath, 'utf8');
      } catch {}
      try {
        stderr = readFileSync(errPath, 'utf8');
      } catch {}
      settle({ code: code ?? -1, stdout, stderr });
    });
  });
}

function invalidToolArgument(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function validateBridgeArguments(args) {
  if (args.config !== undefined) {
    if (typeof args.config !== 'string' || args.config.trim() === '') {
      return invalidToolArgument('argument "config" must be a non-empty string');
    }
  }
  if (args.reasoning_effort !== undefined && !REASONING_EFFORTS.includes(args.reasoning_effort)) {
    return invalidToolArgument(
      `argument "reasoning_effort" must be one of: ${REASONING_EFFORTS.join(', ')}`,
    );
  }
  if (args.codex_review_edits !== undefined && !CODEX_REVIEW_EDITS.includes(args.codex_review_edits)) {
    return invalidToolArgument(
      `argument "codex_review_edits" must be one of: ${CODEX_REVIEW_EDITS.map((value) => `"${value}"`).join(', ')}`,
    );
  }
  if (
    args.max_objects !== undefined &&
    (typeof args.max_objects !== 'number' ||
      !Number.isInteger(args.max_objects) ||
      args.max_objects < 0 ||
      args.max_objects > 2147483647)
  ) {
    return invalidToolArgument('argument "max_objects" must be an integer from 0 to 2147483647');
  }
  return null;
}

async function callTool(name, args) {
  if (name !== TOOL.name) {
    return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
  }
  if (typeof args?.spec !== 'string' || args.spec.trim() === '') {
    return { content: [{ type: 'text', text: 'argument "spec" is required' }], isError: true };
  }
  const invalid = validateBridgeArguments(args);
  if (invalid) return invalid;

  const cli = ['-Spec', args.spec];
  if (args.task) cli.push('-Task', String(args.task));
  if (args.session) cli.push('-Session', String(args.session));
  if (args.repo) cli.push('-Repo', String(args.repo));
  if (args.mode) cli.push('-Mode', String(args.mode));
  if (typeof args.timeout_minutes === 'number') cli.push('-TimeoutMinutes', String(args.timeout_minutes));
  if (args.config !== undefined) cli.push('-Config', args.config);
  if (args.reasoning_effort !== undefined) cli.push('-ReasoningEffort', args.reasoning_effort);
  if (args.codex_review_edits !== undefined) cli.push('-CodexReviewEdits', args.codex_review_edits);
  if (args.max_objects !== undefined) cli.push('-MaxObjects', String(args.max_objects));
  if (args.skip_windows_preflight === true) cli.push('-SkipWindowsPreflight');

  const result = await runBridge(cli);
  const body = result.stdout.trim() || '(no output)';
  const tail = result.stderr.trim() ? `\n\n[bridge stderr]\n${result.stderr.trim()}` : '';
  return {
    content: [{ type: 'text', text: `${body}${tail}` }],
    isError: result.code !== 0,
  };
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    fail(null, -32700, 'parse error');
    return;
  }

  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        if (isRequest) reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: [TOOL] });
        return;
      case 'tools/call': {
        const result = await callTool(params?.name, params?.arguments ?? {});
        reply(id, result);
        return;
      }
      default:
        if (isRequest) fail(id, -32601, `method not found: ${method}`);
    }
  } catch (error) {
    if (isRequest) fail(id, -32603, `internal error: ${error.message}`);
  }
}

// A tool call can outlive stdin: finish in-flight work before exiting on close.
let pending = 0;
let closed = false;
const maybeExit = () => {
  if (closed && pending === 0) process.exit(0);
};

rl.on('line', (line) => {
  if (!line.trim()) return;
  pending += 1;
  void handleLine(line).finally(() => {
    pending -= 1;
    maybeExit();
  });
});

rl.on('close', () => {
  closed = true;
  maybeExit();
});
