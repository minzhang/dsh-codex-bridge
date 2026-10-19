# Node tests under DSH's Windows sandbox

The Windows backend can run Node, TypeScript, and real child processes, but named-pipe stdio
capture by confined descendants can fail with `spawn EPERM`. Node's ordinary test runner uses
that transport for its workers. This is separate from missing permissions on build directories.
Repairing file permissions does not repair Node's pipe transport.

Two adjustments preserve the test assertions and DSH confinement:

1. Run every test file without test-runner worker isolation.
2. For tests that launch a CLI, capture real child output through files in DSH's private temp.

This changes test execution; it never changes the DSH token, workspace policy, or application.
Keep the normal isolated command for independent review on a host that supports it. Test files
sharing one process must not rely on isolated global state; fix leaks rather than dropping checks.

## Project scripts

For an example project that builds two TypeScript test files into `dist/tests/`:

```json
{
  "scripts": {
    "build": "tsc",
    "test": "npm run build && node --test dist/tests/core.test.js dist/tests/cli.test.js",
    "test:sandbox": "npm run build && node dsh-codex-bridge/node/run-tests.mjs dist/tests/core.test.js dist/tests/cli.test.js"
  }
}
```

Replace the example list with **all of your project's test files**. Keep the two lists synchronized
or generate both from one project-owned manifest. Do not copy an old project's hardcoded test count.
The helper requires explicit files and does not compile TypeScript for you. Node 22.14+ is required
for `--experimental-test-isolation=none`. Older Node releases should be upgraded, not silently
switched to a partial suite.

The default Node test runner still needs pipe support. `npm test` is therefore expected to fail
inside the affected DSH Windows backend even after setup succeeds; use `npm run test:sandbox`
there. Other platforms should use their normal commands unless they show a corresponding issue.

## Capture a real child process

Use `node/capture-process.mjs` from an ESM test. It launches an actual executable without a shell
and captures stdout/stderr into unique temporary files. Consult its adjacent type declarations
for the precise supported options and result shape. Preserve your CLI arguments, environment,
exit-code assertions, output assertions, and timeout.

```js
import assert from 'node:assert/strict';
import { captureProcess } from './dsh-codex-bridge/node/capture-process.mjs';

const result = await captureProcess(process.execPath, ['dist/src/cli.js', '--help']);
assert.equal(result.code, 0);
assert.match(result.stdout, /Usage:/);
assert.equal(result.stderr, '');
```

Adjust the import to the test's actual location. For compiled TypeScript tests, remember that a
relative import is resolved from the compiled file in `dist/`, not the source file. Either copy
the helper into the project's test support with an appropriate build layout, or resolve/import
the package's helper at its runtime location. Do not add a dependency on this kit's original repo.
When the CLI should run outside Node's test context, clone `process.env` and delete
`NODE_TEST_CONTEXT` before passing it as the helper's `env` option.

On timeout, the helper attempts Windows child-tree termination with `taskkill /T /F`.
On other platforms it sends SIGTERM, then SIGKILL, to the direct child only. Inspect the
timeout error's `termination` detail for an unconfirmed exit or failed termination step;
descendant cleanup is not guaranteed on every platform. The Windows behavior is the tested
target of this package's sandbox repair.

`os.tmpdir()` under DSH points to the session's private writable temp directory. Do not substitute
an arbitrary ambient-temp directory. File-backed capture needs no new write allowance outside
the workspace/private temp, and child processes inherit the existing restriction.

## Acceptance evidence

DSH must run the project's build and complete sandbox suite and record exit codes, counts,
failures/skips and full logs. Codex reviews the changed helper/tests, checks that assertions were
not weakened, and independently runs the ordinary suite when possible. A passing setup smoke
test proves environment readiness only, never project acceptance.

Backend reference: [DSH Windows sandbox](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md).
