import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEditor,
  isDirty,
  markSaved,
  reduceEditor,
  type EditorState,
} from '../src/editor.js';
import {
  MENU_ITEMS,
  completeEffect,
  createApp,
  fitViewport,
  handleKey,
  handleSmallTerminalKey,
  type AppState,
  type Effect,
  type EffectResult,
  type FileEffect,
  type KeyInput,
  type KeyResult,
} from '../src/app.js';

function press(state: AppState, key: KeyInput, pageSize?: number): KeyResult {
  return handleKey(state, key, pageSize);
}

function pressState(state: AppState, key: KeyInput, pageSize?: number): AppState {
  return press(state, key, pageSize).state;
}

function typeText(state: AppState, text: string): AppState {
  let next = state;
  for (const char of text) {
    next = pressState(next, { sequence: char });
  }
  return next;
}

function dirtyApp(text = 'unsaved'): AppState {
  let state = createApp(createEditor(text));
  state = typeText(state, '!');
  return state;
}

function openMenu(state: AppState): AppState {
  return pressState(state, { name: 'f10' });
}

function selectMenuItem(state: AppState, index: number): KeyResult {
  let next = openMenu(state);
  for (let step = 0; step < index; step += 1) {
    next = pressState(next, { name: 'down' });
  }
  return press(next, { name: 'return' });
}

function completeSave(
  state: AppState,
  effect: FileEffect,
  editor: EditorState,
): AppState {
  return completeEffect(state, { effect, ok: true, editor }).state;
}

function completeFailure(
  state: AppState,
  effect: FileEffect,
  code: string,
  message = 'failed',
): AppState {
  return completeEffect(state, {
    effect,
    ok: false,
    error: { code, message },
  }).state;
}

function expectEffect(result: KeyResult, expected: Effect): void {
  assert.deepEqual(result.effect, expected);
}

function fileEffect(result: KeyResult): FileEffect {
  assert.ok(result.effect !== undefined);
  assert.notEqual(result.effect.type, 'quit');
  return result.effect as FileEffect;
}

test('createApp starts clean with no modal state and keeps a supplied editor', () => {
  const state = createApp();
  assert.deepEqual(state.editor.lines, ['']);
  assert.equal(state.topLine, 0);
  assert.equal(state.leftCol, 0);
  assert.equal(state.status, '');
  assert.equal(state.overlay, 'none');
  assert.equal(state.menuIndex, 0);
  assert.equal(state.prompt, null);
  assert.equal(state.confirm, null);
  assert.equal(state.busy, null);
  assert.equal(state.lastFind, '');
  assert.equal(state.lastSearch, null);
  assert.equal(state.highlight, null);

  const editor: EditorState = createEditor('kept', 'demo.pas');
  assert.equal(createApp(editor).editor, editor);
});

test('printable input inserts and named navigation moves the cursor', () => {
  let state = createApp();
  state = typeText(state, 'ab');
  assert.deepEqual(state.editor.lines, ['ab']);
  assert.deepEqual(state.editor.cursor, { row: 0, col: 2 });

  state = pressState(state, { name: 'left' });
  assert.deepEqual(state.editor.cursor, { row: 0, col: 1 });

  state = pressState(state, { name: 'home' });
  assert.deepEqual(state.editor.cursor, { row: 0, col: 0 });

  state = pressState(state, { name: 'end' });
  assert.deepEqual(state.editor.cursor, { row: 0, col: 2 });

  state = pressState(state, { name: 'return' });
  assert.deepEqual(state.editor.lines, ['ab', '']);
  assert.deepEqual(state.editor.cursor, { row: 1, col: 0 });
});

test('ctrl, meta, and escape sequences never insert text', () => {
  const base = typeText(createApp(), 'a');

  assert.deepEqual(
    pressState(base, { name: 'x', sequence: 'x', ctrl: true }).editor.lines,
    ['a'],
  );
  assert.deepEqual(
    pressState(base, { sequence: 'z', meta: true }).editor.lines,
    ['a'],
  );
  assert.deepEqual(
    pressState(base, { sequence: '\u001b[31m' }).editor.lines,
    ['a'],
  );
  assert.deepEqual(
    pressState(base, { name: 'f9', sequence: '\u001b[20~' }).editor.lines,
    ['a'],
  );
});

test('tab, backspace, and delete edit at the cursor', () => {
  let state = typeText(createApp(), 'ac');
  state = pressState(state, { name: 'left' });
  state = pressState(state, { name: 'tab' });
  assert.deepEqual(state.editor.lines, ['a  c']);
  assert.deepEqual(state.editor.cursor, { row: 0, col: 3 });

  state = pressState(state, { name: 'backspace' });
  assert.deepEqual(state.editor.lines, ['a c']);
  assert.deepEqual(state.editor.cursor, { row: 0, col: 2 });

  state = pressState(state, { name: 'delete' });
  assert.deepEqual(state.editor.lines, ['a ']);
  assert.deepEqual(state.editor.cursor, { row: 0, col: 2 });
});

test('Ctrl+Z and Ctrl+Y drive editor undo and redo', () => {
  let state = typeText(createApp(), 'x');
  assert.deepEqual(state.editor.lines, ['x']);

  state = pressState(state, { name: 'z', sequence: '\u001a', ctrl: true });
  assert.deepEqual(state.editor.lines, ['']);

  state = pressState(state, { name: 'y', sequence: '\u0019', ctrl: true });
  assert.deepEqual(state.editor.lines, ['x']);
});

test('page movement uses the supplied page size and clamps at the edges', () => {
  const text = Array.from({ length: 10 }, (_, index) => `L${index}`).join('\n');
  let state = createApp(createEditor(text));

  state = pressState(state, { name: 'pagedown' }, 3);
  assert.equal(state.editor.cursor.row, 3);

  state = pressState(state, { name: 'pagedown' }, 3);
  assert.equal(state.editor.cursor.row, 6);

  state = pressState(state, { name: 'pageup' }, 3);
  assert.equal(state.editor.cursor.row, 3);

  state = pressState(state, { name: 'pageup' }, 100);
  assert.equal(state.editor.cursor.row, 0);
});

test('save shortcuts emit a typed save effect for a named document', () => {
  for (const key of [
    { name: 'f2' },
    { name: 's', sequence: '\u0013', ctrl: true },
  ]) {
    const initial = createApp(createEditor('saved text', 'D:/docs/demo.pas'));
    const result = press(initial, key);

    assert.deepEqual(result.effect, {
      type: 'save',
      path: 'D:/docs/demo.pas',
      overwrite: true,
    });
    assert.deepEqual(result.state.busy, result.effect);
    assert.equal(result.state.overlay, 'none');
    assert.match(result.state.status, /Saving/);
  }
});

test('save on an unnamed document opens a Save As prompt instead of a save effect', () => {
  const result = press(createApp(), { name: 'f2' });

  assert.equal(result.effect, undefined);
  assert.equal(result.state.overlay, 'prompt');
  assert.equal(result.state.prompt?.kind, 'saveAs');
  assert.equal(result.state.prompt?.value, '');
  assert.equal(result.state.busy, null);
});

test('open and new shortcuts use prompts and clean-buffer semantics', () => {
  const opened = press(createApp(), { name: 'f3' });
  assert.equal(opened.effect, undefined);
  assert.equal(opened.state.overlay, 'prompt');
  assert.equal(opened.state.prompt?.kind, 'open');

  const ctrlO = press(createApp(), {
    name: 'o',
    sequence: '\u000f',
    ctrl: true,
  });
  assert.equal(ctrlO.state.prompt?.kind, 'open');

  const fresh = press(createApp(createEditor('old', 'old.pas')), {
    name: 'n',
    sequence: '\u000e',
    ctrl: true,
  });
  assert.deepEqual(fresh.state.editor.lines, ['']);
  assert.equal(fresh.state.editor.filePath, null);
  assert.equal(fresh.state.editor.savedContent, '');
  assert.equal(isDirty(fresh.state.editor), false);
  assert.equal(fresh.state.status, 'New file');
});

test('Ctrl+F opens a prefilled find prompt and Escape cancels it', () => {
  const initial: AppState = {
    ...createApp(createEditor('alpha\nbeta')),
    lastFind: 'beta',
  };
  let result = press(initial, { name: 'f', sequence: '\u0006', ctrl: true });

  assert.equal(result.state.overlay, 'prompt');
  assert.deepEqual(result.state.prompt, {
    kind: 'find',
    value: 'beta',
    message: '',
  });

  result = press(result.state, { name: 'escape' });
  assert.equal(result.state.overlay, 'none');
  assert.equal(result.state.prompt, null);
  assert.deepEqual(result.state.editor.lines, ['alpha', 'beta']);
});

test('clean quit emits the quit effect; dirty quit asks and only Y discards', () => {
  const clean = press(createApp(), {
    name: 'q',
    sequence: '\u0011',
    ctrl: true,
  });
  expectEffect(clean, { type: 'quit' });

  const dirty = press(dirtyApp('hello'), {
    name: 'q',
    sequence: '\u0011',
    ctrl: true,
  });
  assert.equal(dirty.effect, undefined);
  assert.equal(dirty.state.overlay, 'confirm');
  assert.equal(dirty.state.confirm?.kind, 'discard');
  assert.equal(dirty.state.confirm?.message, 'Discard unsaved changes? Y / N');

  const enter = press(dirty.state, { name: 'return' });
  assert.equal(enter.effect, undefined);
  assert.equal(enter.state.overlay, 'confirm');

  const no = press(dirty.state, { name: 'n' });
  assert.equal(no.effect, undefined);
  assert.equal(no.state.overlay, 'none');
  assert.equal(no.state.editor, dirty.state.editor);
  assert.equal(isDirty(no.state.editor), true);

  const escape = press(dirty.state, { name: 'escape' });
  assert.equal(escape.state.overlay, 'none');
  assert.equal(escape.state.editor, dirty.state.editor);

  const yes = press(dirty.state, { sequence: 'y' });
  expectEffect(yes, { type: 'quit' });
});

test('Ctrl+C follows the same dirty protection as Ctrl+Q', () => {
  const clean = press(createApp(), {
    name: 'c',
    sequence: '\u0003',
    ctrl: true,
  });
  expectEffect(clean, { type: 'quit' });

  const dirty = press(dirtyApp(), {
    name: 'c',
    sequence: '\u0003',
    ctrl: true,
  });
  assert.equal(dirty.state.overlay, 'confirm');
  assert.equal(dirty.state.confirm?.action.type, 'quit');
});

test('F1 help is modal, toggles off, and Escape dismisses it', () => {
  let state = createApp(createEditor('abc'));
  state = pressState(state, { name: 'f1' });
  assert.equal(state.overlay, 'help');

  const typed = typeText(state, 'x');
  assert.equal(typed.overlay, 'help');
  assert.deepEqual(typed.editor.lines, ['abc']);

  const moved = pressState(state, { name: 'right' });
  assert.equal(moved.overlay, 'help');
  assert.deepEqual(moved.editor.cursor, { row: 0, col: 0 });

  state = pressState(state, { name: 'escape' });
  assert.equal(state.overlay, 'none');

  state = pressState(state, { name: 'f1' });
  state = pressState(state, { name: 'f1' });
  assert.equal(state.overlay, 'none');
});

test('F10 menu wraps, clamps, and swallows typing and editor navigation', () => {
  let state = openMenu(createApp());
  assert.equal(state.overlay, 'menu');
  assert.equal(state.menuIndex, 0);

  state = pressState(state, { name: 'up' });
  assert.equal(state.menuIndex, MENU_ITEMS.length - 1);

  state = pressState(state, { name: 'down' });
  assert.equal(state.menuIndex, 0);

  state = pressState(state, { name: 'end' });
  assert.equal(state.menuIndex, MENU_ITEMS.length - 1);

  state = pressState(state, { name: 'home' });
  assert.equal(state.menuIndex, 0);

  const typed = typeText(state, 'x');
  assert.equal(typed.overlay, 'menu');
  assert.deepEqual(typed.editor.lines, ['']);

  const moved = pressState(state, { name: 'right' });
  assert.deepEqual(moved.editor.cursor, { row: 0, col: 0 });

  assert.equal(pressState(state, { name: 'escape' }).overlay, 'none');

  state = openMenu(createApp());
  assert.equal(pressState(state, { name: 'f10' }).overlay, 'none');
});

test('menu commands trigger the same prompts, files, and safeguards as shortcuts', () => {
  const newResult = selectMenuItem(createApp(createEditor('a')), 0);
  assert.equal(newResult.state.overlay, 'none');
  assert.deepEqual(newResult.state.editor.lines, ['']);

  const open = selectMenuItem(createApp(), 1);
  assert.equal(open.state.overlay, 'prompt');
  assert.equal(open.state.prompt?.kind, 'open');

  const save = selectMenuItem(
    createApp(createEditor('a', 'D:/a.pas')),
    2,
  );
  expectEffect(save, {
    type: 'save',
    path: 'D:/a.pas',
    overwrite: true,
  });

  const saveAs = selectMenuItem(createApp(), 3);
  assert.equal(saveAs.state.overlay, 'prompt');
  assert.equal(saveAs.state.prompt?.kind, 'saveAs');

  const find = selectMenuItem(createApp(), 4);
  assert.equal(find.state.overlay, 'prompt');
  assert.equal(find.state.prompt?.kind, 'find');

  const quit = selectMenuItem(createApp(), 8);
  expectEffect(quit, { type: 'quit' });

  const dirtyNew = selectMenuItem(dirtyApp(), 0);
  assert.equal(dirtyNew.state.overlay, 'confirm');
  assert.equal(dirtyNew.state.confirm?.action.type, 'new');
});

test('menu Undo, Redo, and Help apply their intents', () => {
  const edited = typeText(createApp(), 'a');

  const undone = selectMenuItem(edited, 5).state;
  assert.equal(undone.overlay, 'none');
  assert.deepEqual(undone.editor.lines, ['']);

  const redone = selectMenuItem(undone, 6).state;
  assert.equal(redone.overlay, 'none');
  assert.deepEqual(redone.editor.lines, ['a']);

  const help = selectMenuItem(createApp(), 7).state;
  assert.equal(help.overlay, 'help');
});

test('status clears when a later edit is applied', () => {
  let state: AppState = { ...createApp(), status: 'Saved demo.pas' };

  state = typeText(state, 'x');

  assert.equal(state.status, '');
  assert.deepEqual(state.editor.lines, ['x']);
});

test('a file prompt accepts spaces, edits at the end, and keeps blank input open', () => {
  let state = press(createApp(), { name: 'f3' }).state;
  state = typeText(state, 'my notes/demo.pas');
  assert.equal(state.prompt?.value, 'my notes/demo.pas');

  state = pressState(state, { name: 'backspace' });
  assert.equal(state.prompt?.value, 'my notes/demo.pa');

  state = typeText(state, 's');
  const result = press(state, { name: 'return' });
  expectEffect(result, {
    type: 'open',
    path: 'my notes/demo.pas',
  });
  assert.equal(result.state.overlay, 'none');
  assert.equal(result.state.prompt, null);
  assert.equal(result.state.busy?.type, 'open');

  const blank = press(createApp(), { name: 'f2' }).state;
  const submitted = press(blank, { name: 'return' });
  assert.equal(submitted.state.overlay, 'prompt');
  assert.equal(submitted.state.prompt?.message, 'Enter a file path.');
  assert.equal(submitted.effect, undefined);

  const spaced = press(blank, { sequence: '   ' });
  assert.equal(spaced.state.prompt?.value, '   ');
  const spacedSubmit = press(spaced.state, { name: 'return' });
  assert.equal(spacedSubmit.state.overlay, 'prompt');
  assert.equal(spacedSubmit.state.prompt?.message, 'Enter a file path.');
});

test('discard confirmation protects New and Open until Y, and Escape restores editing', () => {
  const dirty = dirtyApp('original');
  const editor = dirty.editor;
  const newAsk = press(dirty, { name: 'n', sequence: '\u000e', ctrl: true });
  assert.equal(newAsk.state.overlay, 'confirm');
  assert.equal(newAsk.state.confirm?.action.type, 'new');

  const cancelled = press(newAsk.state, { name: 'escape' });
  assert.equal(cancelled.state.overlay, 'none');
  assert.equal(cancelled.state.editor, editor);
  assert.equal(isDirty(cancelled.state.editor), true);

  const opened = press(newAsk.state, { sequence: 'Y' });
  assert.equal(opened.state.overlay, 'none');
  assert.deepEqual(opened.state.editor.lines, ['']);
  assert.equal(opened.state.editor.filePath, null);

  const openAsk = press(dirty, { name: 'f3' });
  assert.equal(openAsk.state.confirm?.action.type, 'open');
  const openPrompt = press(openAsk.state, { sequence: 'Y' });
  assert.equal(openPrompt.state.overlay, 'prompt');
  assert.equal(openPrompt.state.prompt?.kind, 'open');
  assert.equal(openPrompt.state.editor, editor);

  const newConfirmed = press(newAsk.state, { name: 'y' });
  assert.deepEqual(newConfirmed.state.editor.lines, ['']);
  assert.equal(newConfirmed.state.editor.filePath, null);
  assert.equal(isDirty(newConfirmed.state.editor), false);
});

test('completing an open success replaces the editor and clears search state', () => {
  let state = press(
    createApp(createEditor('old', 'C:/old.pas')),
    { name: 'f3' },
  ).state;
  state = typeText(state, 'C:/new file.pas');
  const pending = press(state, { name: 'return' });
  assert.ok(pending.effect);
  assert.equal(pending.effect.type, 'open');

  const loaded = createEditor('new content', 'C:/new file.pas');
  const result = completeEffect(pending.state, {
    effect: pending.effect,
    ok: true,
    editor: loaded,
  });

  assert.equal(result.state.editor, loaded);
  assert.equal(result.state.busy, null);
  assert.equal(result.state.overlay, 'none');
  assert.equal(result.state.status, 'Opened new file.pas');
  assert.equal(result.state.topLine, 0);
  assert.equal(result.state.leftCol, 0);
  assert.equal(result.state.highlight, null);
  assert.equal(result.state.lastSearch, null);
});

test('a failed open or save reports an error and preserves the document', () => {
  const initial = dirtyApp('keep me');
  const before = initial.editor;

  const openAsk = press(initial, { name: 'f3' });
  assert.equal(openAsk.state.overlay, 'confirm');
  const openState = press(openAsk.state, { sequence: 'y' }).state;
  const openPrompt = typeText(openState, 'C:/missing.pas');
  const openPending = press(openPrompt, { name: 'return' });
  assert.ok(openPending.effect);
  const openFailed = completeFailure(
    openPending.state,
    fileEffect(openPending),
    'ENOENT',
    'File not found: C:/missing.pas',
  );
  assert.equal(openFailed.editor, before);
  assert.equal(openFailed.busy, null);
  assert.match(openFailed.status, /Open failed: File not found/);

  const savePending = press(
    createApp(createEditor('keep', 'C:/keep.pas')),
    { name: 'f2' },
  );
  assert.ok(savePending.effect);
  const saveFailed = completeFailure(
    savePending.state,
    fileEffect(savePending),
    'EACCES',
    'Permission denied: C:/keep.pas',
  );
  assert.equal(saveFailed.editor.filePath, 'C:/keep.pas');
  assert.equal(isDirty(saveFailed.editor), false);
  assert.equal(saveFailed.busy, null);
  assert.match(saveFailed.status, /Save failed: Permission denied/);
});

test('Save As completion only marks the returned editor clean after success', () => {
  let state = dirtyApp('draft');
  state = pressState(state, { name: 'f2' });
  assert.equal(state.overlay, 'prompt');
  state = typeText(state, 'C:/notes/first draft.pas');
  const pending = press(state, { name: 'return' });
  assert.ok(pending.effect);
  assert.equal(pending.effect.type, 'save');
  assert.equal(pending.effect.type === 'save' && pending.effect.overwrite, false);
  assert.equal(isDirty(pending.state.editor), true);

  const savedEditor = markSaved(pending.state.editor, 'C:/notes/first draft.pas');
  const completed = completeSave(pending.state, pending.effect, savedEditor);

  assert.equal(completed.editor, savedEditor);
  assert.equal(completed.editor.filePath, 'C:/notes/first draft.pas');
  assert.equal(isDirty(completed.editor), false);
  assert.equal(completed.busy, null);
  assert.equal(completed.status, 'Saved first draft.pas');
});

test('EEXIST on no-clobber save requires explicit overwrite confirmation', () => {
  let state = dirtyApp('draft');
  state = pressState(state, { name: 'f2' });
  state = typeText(state, 'C:/notes/existing.pas');
  const pending = press(state, { name: 'return' });
  assert.ok(pending.effect);
  assert.equal(pending.effect.type, 'save');
  if (pending.effect.type === 'save') {
    assert.equal(pending.effect.overwrite, false);
  }

  const ask = completeFailure(
    pending.state,
    pending.effect,
    'EEXIST',
    'File already exists: C:/notes/existing.pas',
  );
  assert.equal(ask.overlay, 'confirm');
  assert.equal(ask.confirm?.kind, 'overwrite');
  assert.equal(ask.confirm?.message, 'Overwrite existing file? Y / N');
  assert.equal(ask.editor, pending.state.editor);

  const enter = press(ask, { name: 'return' });
  assert.equal(enter.effect, undefined);
  assert.equal(enter.state.overlay, 'confirm');

  const no = press(ask, { name: 'n' });
  assert.equal(no.effect, undefined);
  assert.equal(no.state.overlay, 'none');
  assert.equal(no.state.editor, pending.state.editor);
  assert.equal(no.state.status, 'Save cancelled');

  const escape = press(ask, { name: 'escape' });
  assert.equal(escape.state.editor, pending.state.editor);
  assert.equal(escape.state.overlay, 'none');

  const yes = press(ask, { sequence: 'y' });
  assert.ok(yes.effect);
  assert.deepEqual(yes.effect, {
    type: 'save',
    path: 'C:/notes/existing.pas',
    overwrite: true,
  });
  assert.equal(yes.state.overlay, 'none');

  const savedEditor = markSaved(
    yes.state.editor,
    'C:/notes/existing.pas',
  );
  const completed = completeSave(yes.state, yes.effect, savedEditor);
  assert.equal(isDirty(completed.editor), false);
  assert.equal(completed.status, 'Saved existing.pas');
});

test('busy state refuses edits, navigation, and further file effects', () => {
  const initial = createApp(createEditor('a', 'C:/a.pas'));
  const pending = press(initial, { name: 'f2' });
  assert.ok(pending.effect);
  const busy = pending.state;

  for (const key of [
    { sequence: 'x' },
    { name: 'left' },
    { name: 'f2' },
    { name: 'f3' },
    { name: 'f4' },
    { name: 'f10' },
    { name: 'escape' },
    { name: 'q', sequence: '\u0011', ctrl: true },
  ]) {
    const result = press(busy, key);
    assert.equal(result.state, busy);
    assert.equal(result.effect, undefined);
  }

  assert.deepEqual(busy.editor.lines, ['a']);
});

test('stale or mismatched completion results are ignored', () => {
  const pending = press(
    createApp(createEditor('a', 'C:/a.pas')),
    { name: 'f2' },
  );
  assert.ok(pending.effect);

  const stale = completeEffect(pending.state, {
    effect: { type: 'save', path: 'C:/other.pas', overwrite: true },
    ok: true,
    editor: createEditor('other', 'C:/other.pas'),
  });
  assert.equal(stale.state, pending.state);

  const completed = completeEffect(pending.state, {
    effect: fileEffect(pending),
    ok: true,
    editor: markSaved(pending.state.editor, 'C:/a.pas'),
  });
  const after = completeEffect(completed.state, {
    effect: fileEffect(pending),
    ok: true,
    editor: createEditor('again', 'C:/a.pas'),
  });
  assert.equal(after.state, completed.state);
});

test('find moves the cursor without touching text or history', () => {
  let state = createApp(createEditor('alpha Beta gamma\nbeta again'));
  const historyBefore = state.editor.undoStack.length;

  state = pressState(state, { name: 'f', sequence: '\u0006', ctrl: true });
  state = typeText(state, 'beta');
  const result = press(state, { name: 'return' });

  assert.equal(result.state.overlay, 'none');
  assert.deepEqual(result.state.editor.cursor, { row: 0, col: 6 });
  assert.equal(result.state.editor.preferredCol, 6);
  assert.deepEqual(result.state.editor.lines, [
    'alpha Beta gamma',
    'beta again',
  ]);
  assert.equal(result.state.editor.undoStack.length, historyBefore);
  assert.deepEqual(result.state.highlight, { row: 0, col: 6, length: 4 });
  assert.match(result.state.status, /Found at Ln 1, Col 7/);

  const repeated = press(result.state, { name: 'f4' });
  assert.deepEqual(repeated.state.editor.cursor, { row: 1, col: 0 });
  assert.match(repeated.state.status, /Found at Ln 2, Col 1/);
});

test('find wraps once and F4 wraps from the last match', () => {
  let state = createApp(createEditor('one target two\ntarget three'));
  state = pressState(state, { name: 'end' });
  state = pressState(state, { name: 'down' });
  state = pressState(state, { name: 'end' });
  assert.deepEqual(state.editor.cursor, { row: 1, col: 12 });

  state = pressState(state, { name: 'f', sequence: '\u0006', ctrl: true });
  state = typeText(state, 'target');
  const first = press(state, { name: 'return' });

  assert.deepEqual(first.state.editor.cursor, { row: 0, col: 4 });
  assert.match(first.state.status, /wrapped/);

  const next = press(first.state, { name: 'f4' });
  assert.deepEqual(next.state.editor.cursor, { row: 1, col: 0 });

  const wrapped = press(next.state, { name: 'f4' });
  assert.deepEqual(wrapped.state.editor.cursor, { row: 0, col: 4 });
  assert.match(wrapped.state.status, /wrapped/);
});

test('find not-found leaves the document and cursor alone', () => {
  let state = createApp(createEditor('nothing here'));
  state = pressState(state, { name: 'end' });
  const cursor = { ...state.editor.cursor };
  const lines = state.editor.lines.slice();

  state = pressState(state, { name: 'f', sequence: '\u0006', ctrl: true });
  state = typeText(state, 'absent');
  const result = press(state, { name: 'return' });

  assert.deepEqual(result.state.editor.cursor, cursor);
  assert.deepEqual(result.state.editor.lines, lines);
  assert.equal(result.state.highlight, null);
  assert.match(result.state.status, /No match: absent/);
});

test('a content edit invalidates the find highlight but navigation does not', () => {
  let state = createApp(createEditor('alpha beta'));
  state = pressState(state, { name: 'f', sequence: '\u0006', ctrl: true });
  state = typeText(state, 'beta');
  state = press(state, { name: 'return' }).state;
  assert.notEqual(state.highlight, null);

  state = pressState(state, { name: 'left' });
  assert.notEqual(state.highlight, null);

  state = typeText(state, 'X');
  assert.equal(state.highlight, null);
  assert.equal(state.lastSearch, null);
});

test('F4 without a previous query opens the Find prompt', () => {
  const result = press(createApp(createEditor('abc')), { name: 'f4' });
  assert.equal(result.state.overlay, 'prompt');
  assert.equal(result.state.prompt?.kind, 'find');
});

test('modal prompts and confirmations never leak keystrokes into the document', () => {
  let dirty = dirtyApp('safe');
  dirty = pressState(dirty, { name: 'f', sequence: '\u0006', ctrl: true });
  dirty = typeText(dirty, 'zzz');
  assert.deepEqual(dirty.editor.lines, ['!safe']);

  const confirm = press(dirtyApp('safe'), { name: 'n', sequence: '\u000e', ctrl: true });
  const typedInConfirm = typeText(confirm.state, 'abc');
  assert.deepEqual(typedInConfirm.editor.lines, ['!safe']);
  assert.equal(typedInConfirm.overlay, 'confirm');
});

test('small-terminal handling freezes edits but keeps quit and cancellation working', () => {
  let state = createApp(createEditor('abc'));
  const frozen = handleSmallTerminalKey(state, { sequence: 'x' });
  assert.equal(frozen.state, state);
  assert.equal(frozen.effect, undefined);

  const quit = handleSmallTerminalKey(state, {
    name: 'q',
    sequence: '\u0011',
    ctrl: true,
  });
  expectEffect(quit, { type: 'quit' });

  let dirty = dirtyApp('abc');
  dirty = pressState(dirty, { name: 'f1' });
  const confirm = handleSmallTerminalKey(dirty, {
    name: 'q',
    sequence: '\u0011',
    ctrl: true,
  });
  assert.equal(confirm.state.overlay, 'confirm');
  const accepted = handleSmallTerminalKey(confirm.state, { sequence: 'y' });
  expectEffect(accepted, { type: 'quit' });

  const cancelled = handleSmallTerminalKey(confirm.state, { name: 'escape' });
  assert.equal(cancelled.state.overlay, 'none');
  assert.equal(cancelled.state.editor, dirty.editor);
});

test('fitViewport scrolls vertically and keeps the cursor visible', () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
  let state = createApp(createEditor(text));
  state = pressState(state, { name: 'pagedown' }, 20);
  for (let step = 0; step < 5; step += 1) {
    state = pressState(state, { name: 'down' });
  }
  assert.equal(state.editor.cursor.row, 25);

  let fitted = fitViewport(state, 5, 10);
  assert.equal(fitted.topLine, 21);
  assert.equal(fitted.leftCol, 0);
  assert.equal(fitViewport(fitted, 5, 10), fitted);

  state = pressState(fitted, { name: 'up' });
  fitted = fitViewport(state, 5, 10);
  assert.equal(fitted.topLine, 21);

  for (let step = 0; step < 4; step += 1) {
    state = pressState(state, { name: 'up' });
  }
  assert.equal(state.editor.cursor.row, 20);
  fitted = fitViewport(state, 5, 10);
  assert.equal(fitted.topLine, 20);
});

test('fitViewport scrolls horizontally and clamps tiny dimensions', () => {
  let state = createApp(createEditor('abcdefghijklmnopqrstuvwxyz'));
  for (let step = 0; step < 20; step += 1) {
    state = pressState(state, { name: 'right' });
  }
  assert.equal(state.editor.cursor.col, 20);

  let fitted = fitViewport(state, 5, 10);
  assert.equal(fitted.leftCol, 11);

  state = pressState(fitted, { name: 'home' });
  fitted = fitViewport(state, 5, 10);
  assert.equal(fitted.leftCol, 0);

  const tiny = fitViewport(createApp(createEditor('abc')), 0, -5);
  assert.equal(tiny.topLine, 0);
  assert.equal(tiny.leftCol, 0);
});

test('fitViewport accounts for tab-expanded display width', () => {
  const editor = reduceEditor(createEditor(`${'\t'.repeat(20)}end`), {
    type: 'move',
    direction: 'end',
  });
  const state = createApp(editor);

  const fitted = fitViewport(state, 5, 10);

  assert.ok(fitted.leftCol > 0);
  assert.ok(fitted.leftCol < editor.cursor.col);
});
