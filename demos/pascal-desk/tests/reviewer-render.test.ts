import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditor, reduceEditor } from '../src/editor.js';
import { createApp } from '../src/app.js';
import { renderScreen } from '../src/render.js';

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');

test('reviewer: frames stay bounded and only generated SGR escapes survive hostile content', () => {
  const app = createApp(createEditor('begin\n' + '\x1b]52;c;clipboard\x07\t' + 'x'.repeat(300), 'evil\x1b]0;title\x07.pas'));
  app.status = '\x1b[2J forged status\x9b31m';
  const before = JSON.stringify(app);
  for (const columns of [0, 1, 2, 20, 59, 60, 80, 120]) {
    for (const rows of [0, 1, 8, 15, 16, 25]) {
      const result = renderScreen(app, columns, rows);
      const text = plain(result.output);
      assert.equal(/[\x1b\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text), false);
      if (rows === 0) assert.equal(text, '');
      else {
        const lines = text.split('\r\n');
        assert.equal(lines.length, rows);
        assert.ok(lines.every(line => line.length <= Math.max(0, columns - 1)), `${columns}x${rows} frame overflows`);
      }
    }
  }
  assert.equal(JSON.stringify(app), before);
});

test('reviewer: horizontal scrolling retains a visible cursor for loaded tabs', () => {
  const editor = reduceEditor(createEditor('\t'.repeat(60) + 'end'), { type: 'move', direction: 'end' });
  const rendered = renderScreen(createApp(editor), 80, 25);
  assert.ok(rendered.cursor, 'cursor must remain visible after traversing a tab-expanded line');
  assert.ok(rendered.cursor.col >= 2 && rendered.cursor.col <= 78);
  assert.match(plain(rendered.output), /end/);
});
