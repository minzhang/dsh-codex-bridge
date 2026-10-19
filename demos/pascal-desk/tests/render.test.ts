import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createEditor } from '../src/editor.js';
import { createApp, handleKey, type AppState } from '../src/app.js';
import { renderScreen } from '../src/render.js';
import { highlightLine } from '../src/syntax.js';

const SGR = /\u001b\[[0-9;]*m/g;

function stripAnsi(text: string): string {
  return text.replace(SGR, '');
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

function appFor(text: string, filePath?: string): AppState {
  return createApp(createEditor(text, filePath));
}

test('renderScreen returns a complete bounded frame with a visible cursor', () => {
  const result = renderScreen(createApp(), 80, 24);
  const lines = result.output.split('\r\n');

  assert.equal(result.output.endsWith('\n'), false);
  assert.equal(lines.length, 24);
  for (const line of lines) {
    assert.ok(stripAnsi(line).length <= 79);
  }
  assert.deepEqual(result.cursor, { row: 3, col: 2 });
  assert.ok(result.output.includes('\u001b[44;37m'));
  assert.ok(result.output.includes('\u001b[44;36m'));
  assert.ok(result.output.includes('\u001b[30;47m'));
});

test('renderScreen shows filename, dirty marker, line/column, and status', () => {
  let state = appFor('hello', 'demo.pas');
  let plain = stripAnsi(renderScreen(state, 80, 24).output);
  assert.ok(plain.includes('demo.pas'));
  assert.ok(plain.includes('Ln 1, Col 1'));
  assert.equal(plain.includes('[Modified]'), false);

  state = handleKey(state, { name: 'end' }).state;
  state = handleKey(state, { sequence: '!' }).state;
  plain = stripAnsi(renderScreen(state, 80, 24).output);
  assert.ok(plain.includes('demo.pas *'));
  assert.ok(plain.includes('[Modified]'));
  assert.ok(plain.includes('Ln 1, Col 7'));

  const pending = handleKey(state, { name: 'f2' });
  assert.ok(pending.effect);
  plain = stripAnsi(renderScreen(pending.state, 80, 24).output);
  assert.ok(plain.includes('Saving demo.pas'));
  assert.ok(plain.includes('demo.pas *'));
});

test('renderScreen hides the cursor below the minimum size and clips output', () => {
  const small = renderScreen(createApp(), 40, 12);
  const smallLines = small.output.split('\r\n');

  assert.equal(small.cursor, null);
  assert.equal(smallLines.length, 12);
  for (const line of smallLines) {
    assert.ok(stripAnsi(line).length <= 39);
  }
  assert.ok(stripAnsi(small.output).includes('Terminal too small'));

  assert.notEqual(renderScreen(createApp(), 60, 16).cursor, null);
  assert.equal(renderScreen(createApp(), 59, 16).cursor, null);
  assert.equal(renderScreen(createApp(), 60, 15).cursor, null);
});

test('help and menu overlays render without a cursor', () => {
  let state = handleKey(createApp(), { name: 'f1' }).state;
  let result = renderScreen(state, 80, 24);
  let plain = stripAnsi(result.output);

  assert.equal(result.cursor, null);
  assert.ok(plain.includes('Help'));
  assert.ok(plain.includes('Escape closes overlays'));

  state = handleKey(createApp(), { name: 'f10' }).state;
  result = renderScreen(state, 80, 24);
  plain = stripAnsi(result.output);

  assert.equal(result.cursor, null);
  for (const label of [
    'New',
    'Open',
    'Save',
    'Save As',
    'Find',
    'Undo',
    'Redo',
    'Help',
    'Quit',
  ]) {
    assert.ok(plain.includes(label));
  }
});

test('control bytes from content, filename, and status cannot reach the terminal', () => {
  const evilName = 'evil\u001b[2J.pas';
  const state: AppState = {
    ...createApp(createEditor('body\u001b[31mRED\u0007', evilName)),
    status: 'status\u001b[31mX\u0007',
  };

  const result = renderScreen(state, 80, 24);
  const plain = stripAnsi(result.output);

  assert.equal(result.output.includes('\u001b[2J'), false);
  assert.equal(result.output.includes('\u001b[31m'), false);
  assert.equal(result.output.includes('\u0007'), false);
  assert.ok(result.output.includes('^['));
  assert.ok(result.output.includes('^G'));
  assert.ok(plain.includes('evil^[[2J.pas'));
  assert.ok(plain.includes('status'));

  const escapes = result.output.split('\u001b').length - 1;
  const safeSgr = result.output.match(SGR) ?? [];
  assert.equal(safeSgr.length, escapes);
});

test('tabs expand for display only and Unicode text survives rendering', () => {
  const tabbed = renderScreen(appFor('a\tb'), 80, 24);
  const tabPlain = stripAnsi(tabbed.output);
  assert.ok(tabPlain.includes('a  b'));
  assert.equal(tabPlain.includes('\t'), false);

  const unicode = stripAnsi(renderScreen(appFor('bêta 世界'), 80, 24).output);
  assert.ok(unicode.includes('bêta'));
  assert.ok(unicode.includes('世界'));
});

test('rendering does not mutate a frozen application state', () => {
  const state = deepFreeze(appFor('abc'));

  assert.doesNotThrow(() => renderScreen(state, 80, 24));
  assert.equal(state.topLine, 0);
  assert.equal(state.leftCol, 0);
});

test('the cursor follows scrolling near the end of a long buffer', () => {
  const text = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
  let state = createApp(createEditor(text));
  state = handleKey(state, { name: 'pagedown' }, 20).state;
  for (let step = 0; step < 5; step += 1) {
    state = handleKey(state, { name: 'down' }).state;
  }

  const result = renderScreen(state, 80, 24);
  const plain = stripAnsi(result.output);

  assert.equal(result.cursor?.row, 21);
  assert.equal(result.cursor?.col, 2);
  assert.ok(plain.includes('line 25'));
});

test('renderScreen handles degenerate dimensions without throwing', () => {
  const zeroRows = renderScreen(createApp(), 80, 0);
  assert.equal(zeroRows.output, '');
  assert.equal(zeroRows.cursor, null);

  const tiny = renderScreen(createApp(), 1, 1);
  assert.equal(tiny.cursor, null);
  assert.equal(tiny.output.split('\r\n').length, 1);
});

test('highlightLine preserves every input character', () => {
  const samples = [
    'program Demo;',
    "writeln('it''s fine'); { comment }",
    '(* block *) x := 42; // tail',
    "unterminated 'string",
    '{unterminated',
    'a\t b',
    'begin END Begin',
    '$FF 12.5 1..9',
    'bêta 世界',
    '',
  ];

  for (const sample of samples) {
    assert.equal(highlightLine(sample).map((token) => token.text).join(''), sample);
  }
});

test('highlightLine classifies keywords, strings, comments, and numbers', () => {
  const tokens = highlightLine("begin S := 'it''s'; {note} 42 (*x*) // tail");

  assert.deepEqual(
    tokens.filter((token) => token.kind === 'keyword').map((token) => token.text),
    ['begin'],
  );
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'string').map((token) => token.text),
    ["'it''s'"],
  );
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'comment').map((token) => token.text),
    ['{note}', '(*x*)', '// tail'],
  );
  assert.deepEqual(
    tokens.filter((token) => token.kind === 'number').map((token) => token.text),
    ['42'],
  );

  assert.deepEqual(
    highlightLine('BeGiN').map((token) => token.kind),
    ['keyword'],
  );
  assert.deepEqual(highlightLine('procedure'), [{ text: 'procedure', kind: 'keyword' }]);
  assert.deepEqual(highlightLine("'abc"), [{ text: "'abc", kind: 'string' }]);
  assert.deepEqual(highlightLine(''), []);
});

test('keyword tokens are colored in rendered output', () => {
  const output = renderScreen(appFor('begin'), 80, 24).output;
  assert.ok(output.includes('\u001b[44;93m'));
});

test('file and find prompts render bounded panels with a visible prompt cursor', () => {
  const opened = handleKey(appFor('code'), { name: 'f3' }).state;
  const result = renderScreen(opened, 80, 24);
  const plain = stripAnsi(result.output);

  assert.equal(result.cursor !== null, true);
  assert.ok(plain.includes('Open File'));
  assert.ok(plain.includes('Path:'));
  assert.ok(plain.includes('Enter accept  Esc cancel'));
  assert.equal(result.output.includes('\u001b[2J'), false);

  const find = handleKey(appFor('alpha beta'), {
    name: 'f',
    sequence: '\u0006',
    ctrl: true,
  }).state;
  const findResult = renderScreen(find, 80, 24);
  const findPlain = stripAnsi(findResult.output);
  assert.equal(findResult.cursor !== null, true);
  assert.ok(findPlain.includes('Find'));
  assert.ok(findPlain.includes('Enter find  Esc cancel'));

  const long = { ...opened, prompt: opened.prompt ? { ...opened.prompt, value: 'C:/a very long folder name/another folder/final file.pas' } : null };
  const longResult = renderScreen(long, 60, 20);
  const longPlain = stripAnsi(longResult.output);
  assert.ok(longPlain.includes('final file.pas'));
  assert.ok(longResult.cursor !== null);
  assert.ok(longResult.cursor.col <= 59);
});

test('discard and overwrite confirmations render bounded panels and default to cancel', () => {
  let dirty = appFor('dirty');
  dirty = handleKey(dirty, { sequence: '!' }).state;
  const ask = handleKey(dirty, { name: 'q', sequence: '\u0011', ctrl: true }).state;

  let result = renderScreen(ask, 80, 24);
  let plain = stripAnsi(result.output);
  assert.equal(result.cursor, null);
  assert.ok(plain.includes('Discard unsaved changes? Y / N'));
  assert.ok(plain.includes('Y confirm  N/Esc cancel'));

  const overwrite = {
    ...ask,
    confirm: {
      kind: 'overwrite' as const,
      message: 'Overwrite existing file? Y / N',
      action: { type: 'save' as const, path: 'C:/notes/existing.pas' },
    },
    busy: null,
  };
  result = renderScreen(overwrite, 80, 24);
  plain = stripAnsi(result.output);
  assert.ok(plain.includes('Overwrite existing file? Y / N'));
  assert.ok(plain.includes('C:/notes/existing.pas'));
  assert.ok(plain.includes('Y confirm  N/Esc cancel'));
});

test('prompt and confirmation text cannot inject terminal controls', () => {
  const state: AppState = {
    ...createApp(),
    overlay: 'prompt',
    prompt: {
      kind: 'open',
      value: 'bad\u001b[2Jname\u0007\t.pas',
      message: 'msg\u001b[31m',
    },
  };

  const result = renderScreen(state, 80, 24);
  assert.equal(result.output.includes('\u001b[2J'), false);
  assert.equal(result.output.includes('\u001b[31m'), false);
  assert.equal(result.output.includes('\u0007'), false);
  assert.ok(stripAnsi(result.output).includes('bad^[[2Jname^G'));

  const confirmState: AppState = {
    ...createApp(),
    overlay: 'confirm',
    confirm: {
      kind: 'overwrite',
      message: 'Overwrite? Y / N',
      action: { type: 'save', path: 'evil\u001b]0;title\u0007.pas' },
    },
  };
  const confirm = renderScreen(confirmState, 80, 24);
  assert.equal(confirm.output.includes('\u001b]0;title'), false);
  assert.ok(stripAnsi(confirm.output).includes('evil^[]0;title^G.pas'));
});

test('find results are highlighted and help documents phase 3 shortcuts', () => {
  let state = appFor('alpha beta gamma');
  state = handleKey(state, { name: 'f', sequence: '\u0006', ctrl: true }).state;
  for (const char of 'beta') {
    state = handleKey(state, { sequence: char }).state;
  }
  state = handleKey(state, { name: 'return' }).state;

  const result = renderScreen(state, 80, 24);
  assert.ok(result.output.includes('\u001b[30;103m'));
  assert.ok(stripAnsi(result.output).includes('Found at Ln 1, Col 7'));

  const help = handleKey(createApp(), { name: 'f1' }).state;
  const helpPlain = stripAnsi(renderScreen(help, 80, 24).output);
  assert.ok(helpPlain.includes('F4 finds the next match'));
  assert.ok(helpPlain.includes('UTF-8 files up to 1 MiB'));
  assert.equal(helpPlain.includes('phase 3'), false);
});

test('small-terminal notice keeps quit and cancel guidance visible', () => {
  const plain = stripAnsi(renderScreen(createApp(), 50, 12).output);
  assert.ok(plain.includes('Terminal too small'));
  assert.ok(plain.includes('Ctrl+Q Quit'));
  assert.ok(plain.includes('Esc Cancel'));
});

