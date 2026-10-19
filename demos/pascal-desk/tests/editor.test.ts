import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createEditor,
  isDirty,
  markSaved,
  reduceEditor,
  serialize,
  type EditorAction,
  type EditorState,
} from '../src/editor.js';

function apply(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce(reduceEditor, state);
}

function moveRight(state: EditorState, times: number): EditorState {
  let next = state;
  for (let index = 0; index < times; index += 1) {
    next = reduceEditor(next, { type: 'move', direction: 'right' });
  }
  return next;
}

function repeatedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index}`).join('\n');
}

test('createEditor creates a clean, unnamed, empty buffer', () => {
  const state = createEditor();

  assert.deepEqual(state.lines, ['']);
  assert.deepEqual(state.cursor, { row: 0, col: 0 });
  assert.equal(state.preferredCol, 0);
  assert.equal(state.filePath, null);
  assert.equal(state.eol, '\n');
  assert.equal(serialize(state), '');
  assert.equal(isDirty(state), false);
  assert.deepEqual(state.undoStack, []);
  assert.deepEqual(state.redoStack, []);
});

test('createEditor keeps a trailing newline as a final empty line', () => {
  const state = createEditor('one\ntwo\n', 'notes.txt');

  assert.deepEqual(state.lines, ['one', 'two', '']);
  assert.equal(state.filePath, 'notes.txt');
  assert.equal(serialize(state), 'one\ntwo\n');
  assert.equal(isDirty(state), false);
});

test('createEditor detects CRLF and round-trips unedited content', () => {
  const source = 'alpha\r\nbêta\r\n';
  const state = createEditor(source);

  assert.equal(state.eol, '\r\n');
  assert.deepEqual(state.lines, ['alpha', 'bêta', '']);
  assert.equal(serialize(state), source);
  assert.equal(isDirty(state), false);
});

test('createEditor uses the first newline convention and normalizes lone CR', () => {
  const crlfFirst = createEditor('a\r\nb\nc');
  assert.equal(crlfFirst.eol, '\r\n');
  assert.equal(serialize(crlfFirst), 'a\r\nb\r\nc');

  const lfFirst = createEditor('a\nb\r\nc');
  assert.equal(lfFirst.eol, '\n');
  assert.equal(serialize(lfFirst), 'a\nb\nc');

  const loneCr = createEditor('a\rb\r');
  assert.equal(loneCr.eol, '\n');
  assert.deepEqual(loneCr.lines, ['a', 'b', '']);
  assert.equal(serialize(loneCr), 'a\nb\n');
});

test('insert adds text at the cursor and advances it', () => {
  let state = createEditor('abcd');
  state = moveRight(state, 2);

  state = reduceEditor(state, { type: 'insert', text: 'XY' });

  assert.deepEqual(state.lines, ['abXYcd']);
  assert.deepEqual(state.cursor, { row: 0, col: 4 });
  assert.equal(state.preferredCol, 4);
  assert.equal(state.undoStack.length, 1);
});

test('insert expands tabs and normalizes newline sequences', () => {
  let state = createEditor('');

  state = reduceEditor(state, { type: 'insert', text: 'a\tb\r\nc\rd' });

  assert.deepEqual(state.lines, ['a  b', 'c', 'd']);
  assert.deepEqual(state.cursor, { row: 2, col: 1 });
  assert.equal(serialize(state), 'a  b\nc\nd');
});

test('multiline insert splits the current line in the middle', () => {
  let state = createEditor('abcd');
  state = moveRight(state, 2);

  state = reduceEditor(state, { type: 'insert', text: 'X\nY' });

  assert.deepEqual(state.lines, ['abX', 'Ycd']);
  assert.deepEqual(state.cursor, { row: 1, col: 1 });
});

test('newline splits the current line at the cursor', () => {
  const atStart = reduceEditor(createEditor('abc'), { type: 'newline' });
  assert.deepEqual(atStart.lines, ['', 'abc']);
  assert.deepEqual(atStart.cursor, { row: 1, col: 0 });

  let inMiddle = createEditor('abcd');
  inMiddle = apply(inMiddle, { type: 'move', direction: 'end' }, { type: 'move', direction: 'left' });
  inMiddle = reduceEditor(inMiddle, { type: 'newline' });
  assert.deepEqual(inMiddle.lines, ['abc', 'd']);
  assert.deepEqual(inMiddle.cursor, { row: 1, col: 0 });
});

test('empty insert is a no-op that does not clear redo', () => {
  let state = createEditor('a');
  state = reduceEditor(state, { type: 'insert', text: 'b' });
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.redoStack.length, 1);

  const unchanged = reduceEditor(state, { type: 'insert', text: '' });

  assert.deepEqual(unchanged.lines, ['a']);
  assert.equal(unchanged.undoStack.length, 0);
  assert.equal(unchanged.redoStack.length, 1);
  assert.deepEqual(reduceEditor(unchanged, { type: 'redo' }).lines, ['ba']);
});

test('backspace deletes before the cursor and joins lines at column zero', () => {
  let state = createEditor('ab\ncd');

  state = reduceEditor(state, { type: 'move', direction: 'down' });
  state = reduceEditor(state, { type: 'backspace' });

  assert.deepEqual(state.lines, ['abcd']);
  assert.deepEqual(state.cursor, { row: 0, col: 2 });

  state = reduceEditor(state, { type: 'backspace' });

  assert.deepEqual(state.lines, ['acd']);
  assert.deepEqual(state.cursor, { row: 0, col: 1 });
});

test('backspace at the beginning of the buffer is a no-op', () => {
  let state = createEditor('');
  state = reduceEditor(state, { type: 'insert', text: 'x' });
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.redoStack.length, 1);

  const unchanged = reduceEditor(state, { type: 'backspace' });

  assert.deepEqual(unchanged.lines, ['']);
  assert.equal(unchanged.undoStack.length, 0);
  assert.equal(unchanged.redoStack.length, 1);
});

test('delete removes the character ahead and joins the next line at end of line', () => {
  let state = createEditor('abc');
  state = reduceEditor(state, { type: 'move', direction: 'right' });
  state = reduceEditor(state, { type: 'delete' });

  assert.deepEqual(state.lines, ['ac']);
  assert.deepEqual(state.cursor, { row: 0, col: 1 });

  let joined = createEditor('ab\ncd');
  joined = apply(joined, { type: 'move', direction: 'end' }, { type: 'delete' });

  assert.deepEqual(joined.lines, ['abcd']);
  assert.deepEqual(joined.cursor, { row: 0, col: 2 });
});

test('delete at the end of the buffer is a no-op that keeps history intact', () => {
  let state = createEditor('');
  state = reduceEditor(state, { type: 'insert', text: 'x' });
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.redoStack.length, 1);

  const unchanged = reduceEditor(state, { type: 'delete' });

  assert.deepEqual(unchanged.lines, ['']);
  assert.equal(unchanged.undoStack.length, 0);
  assert.equal(unchanged.redoStack.length, 1);
});

test('left and right wrap across adjacent lines', () => {
  let state = createEditor('ab\nc');

  state = moveRight(state, 3);
  assert.deepEqual(state.cursor, { row: 1, col: 0 });

  state = reduceEditor(state, { type: 'move', direction: 'left' });
  assert.deepEqual(state.cursor, { row: 0, col: 2 });
});

test('home and end move to the current line bounds', () => {
  let state = createEditor('ab\ncdef');
  state = reduceEditor(state, { type: 'move', direction: 'down' });
  state = reduceEditor(state, { type: 'move', direction: 'end' });

  assert.deepEqual(state.cursor, { row: 1, col: 4 });

  state = reduceEditor(state, { type: 'move', direction: 'home' });
  assert.deepEqual(state.cursor, { row: 1, col: 0 });
});

test('vertical movement preserves the preferred column through short lines', () => {
  let state = createEditor('abcdef\nxy\nabcdef');
  state = moveRight(state, 4);
  assert.deepEqual(state.cursor, { row: 0, col: 4 });

  state = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.deepEqual(state.cursor, { row: 1, col: 2 });
  assert.equal(state.preferredCol, 4);

  state = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.deepEqual(state.cursor, { row: 2, col: 4 });

  state = reduceEditor(state, { type: 'move', direction: 'up' });
  assert.deepEqual(state.cursor, { row: 1, col: 2 });
});

test('horizontal movement resets the preferred column', () => {
  let state = createEditor('abcdef\nxy\nabcdef');
  state = moveRight(state, 4);
  state = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.deepEqual(state.cursor, { row: 1, col: 2 });

  state = reduceEditor(state, { type: 'move', direction: 'left' });
  assert.equal(state.preferredCol, 1);

  state = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.deepEqual(state.cursor, { row: 2, col: 1 });
});

test('vertical movement at the document edges is a no-op', () => {
  const state = createEditor('a\nb');

  const top = reduceEditor(state, { type: 'move', direction: 'up' });
  assert.deepEqual(top.cursor, { row: 0, col: 0 });
  assert.equal(top.undoStack.length, 0);

  let bottom = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.deepEqual(bottom.cursor, { row: 1, col: 0 });

  bottom = reduceEditor(bottom, { type: 'move', direction: 'down' });
  assert.deepEqual(bottom.cursor, { row: 1, col: 0 });
});

test('page movement defaults to 20 rows and clamps at the document edges', () => {
  let state = createEditor(repeatedLines(30));
  state = reduceEditor(state, { type: 'move', direction: 'pageDown' });
  assert.deepEqual(state.cursor, { row: 20, col: 0 });

  state = reduceEditor(state, { type: 'move', direction: 'pageDown' });
  assert.deepEqual(state.cursor, { row: 29, col: 0 });

  state = reduceEditor(state, { type: 'move', direction: 'pageUp' });
  assert.deepEqual(state.cursor, { row: 9, col: 0 });

  state = reduceEditor(state, { type: 'move', direction: 'pageUp', pageSize: 100 });
  assert.deepEqual(state.cursor, { row: 0, col: 0 });
});

test('page movement preserves the preferred column and clamps page size to one', () => {
  const lines = Array.from({ length: 25 }, (_, index) =>
    index === 11 ? 'xy' : 'abcdefghij',
  );
  let state = createEditor(lines.join('\n'));
  state = moveRight(state, 8);
  assert.deepEqual(state.cursor, { row: 0, col: 8 });

  state = reduceEditor(state, { type: 'move', direction: 'pageDown', pageSize: 11 });
  assert.deepEqual(state.cursor, { row: 11, col: 2 });
  assert.equal(state.preferredCol, 8);

  state = reduceEditor(state, { type: 'move', direction: 'pageDown', pageSize: 11 });
  assert.deepEqual(state.cursor, { row: 22, col: 8 });

  state = reduceEditor(state, { type: 'move', direction: 'pageUp', pageSize: 0 });
  assert.deepEqual(state.cursor, { row: 21, col: 8 });
});

test('content edits reset the preferred column', () => {
  let state = createEditor('abcdef\nxy\nabcdef');
  state = moveRight(state, 4);
  state = reduceEditor(state, { type: 'move', direction: 'down' });
  assert.equal(state.preferredCol, 4);

  state = reduceEditor(state, { type: 'insert', text: 'Q' });
  assert.equal(state.preferredCol, 3);

  state = reduceEditor(state, { type: 'move', direction: 'up' });
  assert.deepEqual(state.cursor, { row: 0, col: 3 });
});

test('undo restores content and cursor, and redo reapplies the edit', () => {
  let state = createEditor('ab');
  state = apply(
    state,
    { type: 'move', direction: 'end' },
    { type: 'insert', text: 'cd' },
  );
  assert.deepEqual(state.lines, ['abcd']);
  assert.deepEqual(state.cursor, { row: 0, col: 4 });

  state = reduceEditor(state, { type: 'undo' });
  assert.deepEqual(state.lines, ['ab']);
  assert.deepEqual(state.cursor, { row: 0, col: 2 });

  state = reduceEditor(state, { type: 'redo' });
  assert.deepEqual(state.lines, ['abcd']);
  assert.deepEqual(state.cursor, { row: 0, col: 4 });
});

test('navigation is not recorded in undo history', () => {
  let state = createEditor('a\nb');
  state = reduceEditor(state, { type: 'insert', text: 'X' });
  assert.equal(state.undoStack.length, 1);

  state = apply(
    state,
    { type: 'move', direction: 'down' },
    { type: 'move', direction: 'end' },
  );
  assert.equal(state.undoStack.length, 1);

  state = reduceEditor(state, { type: 'undo' });
  assert.deepEqual(state.lines, ['a', 'b']);
});

test('a real edit after undo clears redo', () => {
  let state = createEditor('a');
  state = reduceEditor(state, { type: 'insert', text: 'b' });
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.redoStack.length, 1);

  state = reduceEditor(state, { type: 'insert', text: 'c' });

  assert.equal(state.redoStack.length, 0);
  assert.deepEqual(state.lines, ['ca']);
  assert.deepEqual(reduceEditor(state, { type: 'redo' }).lines, ['ca']);
});

test('history keeps at most 200 snapshots', () => {
  let state = createEditor('');
  for (let index = 0; index < 205; index += 1) {
    state = reduceEditor(state, { type: 'insert', text: 'x' });
  }
  assert.equal(state.undoStack.length, 200);

  for (let index = 0; index < 200; index += 1) {
    state = reduceEditor(state, { type: 'undo' });
  }
  assert.equal(state.lines[0]?.length, 5);

  const exhausted = reduceEditor(state, { type: 'undo' });
  assert.equal(exhausted.undoStack.length, 0);
  assert.equal(exhausted.lines[0]?.length, 5);
});

test('dirty status clears when undo returns to the saved content', () => {
  let state = createEditor('hello', 'greeting.txt');
  assert.equal(isDirty(state), false);

  state = apply(
    state,
    { type: 'move', direction: 'end' },
    { type: 'insert', text: '!' },
  );
  assert.equal(isDirty(state), true);

  state = markSaved(state);
  assert.equal(isDirty(state), false);

  state = reduceEditor(state, { type: 'insert', text: '?' });
  assert.equal(isDirty(state), true);

  state = reduceEditor(state, { type: 'undo' });
  assert.equal(isDirty(state), false);
});

test('dirty status around a save point is correct for CRLF content', () => {
  let state = createEditor('a\r\nb');
  state = apply(
    state,
    { type: 'move', direction: 'down' },
    { type: 'move', direction: 'end' },
    { type: 'insert', text: '!' },
  );
  assert.equal(isDirty(state), true);

  state = markSaved(state);
  assert.equal(isDirty(state), false);

  state = reduceEditor(state, { type: 'undo' });
  assert.equal(isDirty(state), true);

  state = reduceEditor(state, { type: 'redo' });
  assert.equal(isDirty(state), false);
  assert.equal(serialize(state), 'a\r\nb!');
});

test('markSaved keeps undo history and undo never restores a stale path', () => {
  let state = createEditor('a', 'one.txt');
  state = reduceEditor(state, { type: 'insert', text: 'X' });
  assert.equal(isDirty(state), true);

  state = markSaved(state, 'two.txt');
  assert.equal(state.filePath, 'two.txt');
  assert.equal(isDirty(state), false);
  assert.equal(state.undoStack.length, 1);

  state = reduceEditor(state, { type: 'undo' });
  assert.deepEqual(state.lines, ['a']);
  assert.equal(state.filePath, 'two.txt');
  assert.equal(isDirty(state), true);

  state = reduceEditor(state, { type: 'redo' });
  assert.deepEqual(state.lines, ['Xa']);
  assert.equal(state.filePath, 'two.txt');
  assert.equal(isDirty(state), false);
});

test('markSaved without a path keeps the current path', () => {
  let state = createEditor('a', 'x.txt');
  state = reduceEditor(state, { type: 'insert', text: 'b' });

  state = markSaved(state);

  assert.equal(state.filePath, 'x.txt');
  assert.equal(isDirty(state), false);
});

test('previous states and snapshots are never mutated', () => {
  const base = createEditor('one\ntwo');
  const afterInsert = reduceEditor(base, { type: 'insert', text: 'X' });

  assert.deepEqual(base.lines, ['one', 'two']);
  assert.deepEqual(base.cursor, { row: 0, col: 0 });
  assert.equal(base.undoStack.length, 0);
  assert.equal(base.redoStack.length, 0);

  const snapshot = afterInsert.undoStack[0];
  assert.ok(snapshot);
  const snapshotLines = [...snapshot.lines];
  const snapshotCursor = { ...snapshot.cursor };

  const afterSecondInsert = reduceEditor(afterInsert, { type: 'insert', text: 'Y' });

  assert.deepEqual(afterInsert.lines, ['Xone', 'two']);
  assert.deepEqual(snapshot.lines, snapshotLines);
  assert.deepEqual(snapshot.cursor, snapshotCursor);

  const undone = reduceEditor(afterSecondInsert, { type: 'undo' });
  assert.deepEqual(undone.lines, ['Xone', 'two']);
  assert.notEqual(undone.lines, afterInsert.lines);
  assert.notEqual(undone.cursor, afterInsert.cursor);
});

test('serialization uses the detected convention after edits', () => {
  let state = createEditor('a\r\nb');
  state = apply(
    state,
    { type: 'move', direction: 'down' },
    { type: 'move', direction: 'end' },
    { type: 'newline' },
    { type: 'insert', text: 'c' },
  );

  assert.equal(state.eol, '\r\n');
  assert.deepEqual(state.lines, ['a', 'b', 'c']);
  assert.equal(serialize(state), 'a\r\nb\r\nc');
});

test('the buffer stays nonempty and lines stay free of newline characters', () => {
  let state = createEditor('a');
  state = reduceEditor(state, { type: 'delete' });
  assert.deepEqual(state.lines, ['']);

  state = reduceEditor(state, { type: 'backspace' });
  assert.deepEqual(state.lines, ['']);
  assert.deepEqual(state.cursor, { row: 0, col: 0 });

  let multiline = createEditor('one\ntwo');
  multiline = apply(
    multiline,
    { type: 'move', direction: 'down' },
    { type: 'move', direction: 'end' },
  );
  for (let index = 0; index < 10; index += 1) {
    multiline = reduceEditor(multiline, { type: 'backspace' });
  }

  assert.deepEqual(multiline.lines, ['']);
  for (const line of multiline.lines) {
    assert.equal(line.includes('\n'), false);
    assert.equal(line.includes('\r'), false);
  }
});

test('cursor stays bounded after repeated boundary navigation and deletion', () => {
  let state = createEditor('abc\ndef');
  state = moveRight(state, 20);
  assert.deepEqual(state.cursor, { row: 1, col: 3 });

  for (let index = 0; index < 20; index += 1) {
    state = reduceEditor(state, { type: 'move', direction: 'left' });
  }
  assert.deepEqual(state.cursor, { row: 0, col: 0 });

  state = apply(
    state,
    { type: 'move', direction: 'down' },
    { type: 'move', direction: 'end' },
  );
  assert.deepEqual(state.cursor, { row: 1, col: 3 });

  const atEof = reduceEditor(state, { type: 'delete' });
  assert.deepEqual(atEof.lines, ['abc', 'def']);
  assert.deepEqual(atEof.cursor, { row: 1, col: 3 });

  let erased = atEof;
  for (let index = 0; index < 5; index += 1) {
    erased = reduceEditor(erased, { type: 'backspace' });
  }
  assert.deepEqual(erased.lines, ['ab']);
  assert.deepEqual(erased.cursor, { row: 0, col: 2 });
});

test('creating a new document starts a new history and baseline', () => {
  let state = createEditor('old');
  state = reduceEditor(state, { type: 'insert', text: 'x' });
  state = reduceEditor(state, { type: 'undo' });
  assert.equal(state.redoStack.length, 1);

  const fresh = createEditor('new', 'new.txt');

  assert.deepEqual(fresh.lines, ['new']);
  assert.deepEqual(fresh.undoStack, []);
  assert.deepEqual(fresh.redoStack, []);
  assert.equal(fresh.filePath, 'new.txt');
  assert.equal(fresh.bom, false);
  assert.equal(isDirty(fresh), false);
});

test('a leading BOM is metadata, not an editable glyph', () => {
  const source = '\uFEFFprogram Demo;';
  const state = createEditor(source, 'demo.pas');

  assert.equal(state.bom, true);
  assert.deepEqual(state.lines, ['program Demo;']);
  assert.deepEqual(state.cursor, { row: 0, col: 0 });
  assert.equal(serialize(state), source);
  assert.equal(isDirty(state), false);

  let edited = reduceEditor(state, { type: 'move', direction: 'end' });
  edited = reduceEditor(edited, { type: 'insert', text: ' {ok}' });

  assert.equal(edited.bom, true);
  assert.deepEqual(edited.lines, ['program Demo; {ok}']);
  assert.equal(serialize(edited), '\uFEFFprogram Demo; {ok}');
  assert.equal(isDirty(edited), true);

  const undone = reduceEditor(edited, { type: 'undo' });
  assert.equal(undone.bom, true);
  assert.equal(serialize(undone), source);
  assert.equal(isDirty(undone), false);

  const redone = reduceEditor(undone, { type: 'redo' });
  assert.equal(redone.bom, true);
  assert.equal(serialize(redone), '\uFEFFprogram Demo; {ok}');
});

test('BOM metadata survives CRLF serialization and markSaved', () => {
  const source = '\uFEFFalpha\r\nbêta\r\n';
  let state = createEditor(source, 'bom.pas');

  assert.equal(state.bom, true);
  assert.equal(state.eol, '\r\n');
  assert.deepEqual(state.lines, ['alpha', 'bêta', '']);
  assert.equal(serialize(state), source);

  state = reduceEditor(state, { type: 'insert', text: '!' });
  assert.equal(serialize(state), '\uFEFF!alpha\r\nbêta\r\n');
  assert.equal(isDirty(state), true);

  const saved = markSaved(state, 'saved.pas');
  assert.equal(saved.bom, true);
  assert.equal(saved.savedContent, '\uFEFF!alpha\r\nbêta\r\n');
  assert.equal(saved.filePath, 'saved.pas');
  assert.equal(isDirty(saved), false);
});

test('only one leading BOM is treated as metadata', () => {
  const state = createEditor('\uFEFF\uFEFFtext');

  assert.equal(state.bom, true);
  assert.deepEqual(state.lines, ['\uFEFFtext']);
  assert.equal(serialize(state), '\uFEFF\uFEFFtext');
});

