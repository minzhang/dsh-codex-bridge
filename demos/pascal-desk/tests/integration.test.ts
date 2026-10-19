import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  completeEffect,
  createApp,
  handleKey,
  type AppState,
  type FileEffect,
  type KeyInput,
  type KeyResult,
} from '../src/app.js';
import {
  createEditor,
  isDirty,
  serialize,
} from '../src/editor.js';
import { FileError, openDocument, saveDocument } from '../src/files.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = join(ROOT, '.dsh-runs');

function temporaryDirectory(): string {
  mkdirSync(RUNS, { recursive: true });
  return mkdtempSync(join(RUNS, 'test-integration-'));
}

function press(state: AppState, key: KeyInput): KeyResult {
  return handleKey(state, key);
}

function pressState(state: AppState, key: KeyInput): AppState {
  return press(state, key).state;
}

function typeText(state: AppState, text: string): AppState {
  let next = state;
  for (const char of text) {
    next = pressState(next, { sequence: char });
  }
  return next;
}

function fileEffect(result: KeyResult): FileEffect {
  assert.ok(result.effect !== undefined);
  assert.notEqual(result.effect.type, 'quit');
  return result.effect as FileEffect;
}

async function runEffect(
  state: AppState,
  effect: FileEffect,
): Promise<KeyResult> {
  try {
    if (effect.type === 'open') {
      const editor = await openDocument(effect.path);
      return completeEffect(state, { effect, ok: true, editor });
    }
    const editor = await saveDocument(
      state.editor,
      effect.path,
      effect.overwrite,
    );
    return completeEffect(state, { effect, ok: true, editor });
  } catch (failure) {
    const error =
      failure instanceof FileError
        ? { code: failure.code, message: failure.message }
        : { message: failure instanceof Error ? failure.message : String(failure) };
    return completeEffect(state, { effect, ok: false, error });
  }
}

test('integration: edit, Save As with spaces, save again, and reopen', async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, 'draft with spaces.pas');

    let state = createApp();
    state = typeText(state, 'program Demo;');
    state = pressState(state, { name: 'f2' });
    assert.equal(state.overlay, 'prompt');
    assert.equal(state.prompt?.kind, 'saveAs');

    state = typeText(state, path);
    let result = press(state, { name: 'return' });
    let effect = fileEffect(result);
    assert.equal(effect.type, 'save');
    assert.equal(effect.type === 'save' && effect.overwrite, false);

    result = await runEffect(result.state, effect);
    state = result.state;
    assert.equal(isDirty(state.editor), false);
    assert.equal(state.editor.filePath, path);
    assert.equal(state.status, 'Saved draft with spaces.pas');
    assert.equal(readFileSync(path, 'utf8'), 'program Demo;');

    state = pressState(state, { name: 'end' });
    state = typeText(state, ' {edited}');
    assert.equal(isDirty(state.editor), true);

    result = press(state, { name: 'f2' });
    effect = fileEffect(result);
    assert.equal(effect.type === 'save' && effect.overwrite, true);
    result = await runEffect(result.state, effect);
    state = result.state;

    assert.equal(isDirty(state.editor), false);
    assert.equal(readFileSync(path, 'utf8'), 'program Demo; {edited}');

    let reopened = createApp(createEditor('scratch'));
    reopened = pressState(reopened, { name: 'f3' });
    reopened = typeText(reopened, path);
    result = press(reopened, { name: 'return' });
    effect = fileEffect(result);
    result = await runEffect(result.state, effect);

    assert.equal(result.state.editor.filePath, path);
    assert.deepEqual(result.state.editor.lines, ['program Demo; {edited}']);
    assert.equal(serialize(result.state.editor), 'program Demo; {edited}');
    assert.equal(isDirty(result.state.editor), false);
    assert.match(result.state.status, /Opened/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('integration: discard and overwrite cancellation preserve data', async () => {
  const directory = temporaryDirectory();
  try {
    const existing = join(directory, 'existing.pas');
    writeFileSync(existing, 'keep this file');

    let state = createApp();
    state = typeText(state, 'unsaved draft');
    const dirtyEditor = state.editor;

    let result = press(state, { name: 'f3' });
    assert.equal(result.state.overlay, 'confirm');
    result = press(result.state, { name: 'n' });
    assert.equal(result.state.overlay, 'none');
    assert.equal(result.state.editor, dirtyEditor);

    result = press(result.state, { name: 'f3' });
    result = press(result.state, { sequence: 'y' });
    assert.equal(result.state.overlay, 'prompt');
    assert.equal(result.state.prompt?.kind, 'open');
    result = press(result.state, { name: 'escape' });
    assert.equal(result.state.overlay, 'none');
    assert.equal(result.state.editor, dirtyEditor);

    result = press(result.state, { name: 'f2' });
    result = press(typeText(result.state, existing), { name: 'return' });
    let effect = fileEffect(result);
    result = await runEffect(result.state, effect);
    assert.equal(result.state.overlay, 'confirm');
    assert.equal(result.state.confirm?.kind, 'overwrite');
    assert.equal(result.state.editor, dirtyEditor);
    assert.equal(readFileSync(existing, 'utf8'), 'keep this file');

    result = press(result.state, { name: 'escape' });
    assert.equal(result.state.overlay, 'none');
    assert.equal(result.state.status, 'Save cancelled');
    assert.equal(result.state.editor, dirtyEditor);
    assert.equal(isDirty(result.state.editor), true);
    assert.equal(readFileSync(existing, 'utf8'), 'keep this file');

    result = press(result.state, { name: 'f2' });
    result = press(typeText(result.state, existing), { name: 'return' });
    effect = fileEffect(result);
    result = await runEffect(result.state, effect);
    assert.equal(result.state.overlay, 'confirm');

    result = press(result.state, { sequence: 'y' });
    effect = fileEffect(result);
    assert.equal(effect.type === 'save' && effect.overwrite, true);
    result = await runEffect(result.state, effect);

    assert.equal(isDirty(result.state.editor), false);
    assert.equal(result.state.editor.filePath, existing);
    assert.equal(readFileSync(existing, 'utf8'), 'unsaved draft');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('integration: save failure keeps the dirty document and leaves no destination', async () => {
  const directory = temporaryDirectory();
  try {
    const missingParent = join(directory, 'missing', 'draft.pas');

    let state = createApp();
    state = typeText(state, 'not saved');
    state = pressState(state, { name: 'f2' });
    state = typeText(state, missingParent);
    let result = press(state, { name: 'return' });
    const effect = fileEffect(result);
    const beforeEditor = result.state.editor;
    const beforeLines = result.state.editor.lines.slice();

    result = await runEffect(result.state, effect);

    assert.equal(result.state.editor, beforeEditor);
    assert.deepEqual(result.state.editor.lines, beforeLines);
    assert.equal(result.state.editor.filePath, null);
    assert.equal(isDirty(result.state.editor), true);
    assert.equal(result.state.busy, null);
    assert.match(result.state.status, /Save failed: .*folder does not exist/);
    assert.throws(() => readFileSync(missingParent));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('integration: opening a missing file reports an error and keeps the document', async () => {
  const directory = temporaryDirectory();
  try {
    const missing = join(directory, 'missing.pas');
    let state = createApp(createEditor('still here', 'C:/local.pas'));
    state = pressState(state, { name: 'f3' });
    state = typeText(state, missing);
    let result = press(state, { name: 'return' });
    const effect = fileEffect(result);
    const beforeEditor = result.state.editor;

    result = await runEffect(result.state, effect);

    assert.equal(result.state.editor, beforeEditor);
    assert.equal(result.state.editor.filePath, 'C:/local.pas');
    assert.equal(result.state.busy, null);
    assert.match(result.state.status, /Open failed: File not found/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('integration: new after confirmation creates a clean unnamed buffer', async () => {
  let state = createApp();
  state = typeText(state, 'discard me');
  let result = press(state, { name: 'n', sequence: '\u000e', ctrl: true });
  assert.equal(result.state.overlay, 'confirm');
  assert.deepEqual(result.state.editor.lines, ['discard me']);

  result = press(result.state, { name: 'y' });
  assert.deepEqual(result.state.editor.lines, ['']);
  assert.equal(result.state.editor.filePath, null);
  assert.equal(isDirty(result.state.editor), false);
  assert.equal(result.state.status, 'New file');
});
