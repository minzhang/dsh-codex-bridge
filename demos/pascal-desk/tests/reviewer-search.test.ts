import test from 'node:test';
import assert from 'node:assert/strict';
import { findNext } from '../src/search.js';

test('reviewer: literal search is inclusive, supports overlap, and wraps once', () => {
  const lines = ['aaa BEGIN', 'end.'];
  const before = JSON.stringify(lines);
  assert.deepEqual(findNext(lines, 'aa', { row: 0, col: 1 }), { row: 0, col: 1, length: 2 });
  assert.deepEqual(findNext(lines, 'aa', { row: 0, col: 2 }), { row: 0, col: 0, length: 2 });
  assert.deepEqual(findNext(lines, 'begin', { row: 1, col: 4 }), { row: 0, col: 4, length: 5 });
  assert.deepEqual(findNext(lines, '.', { row: 0, col: 0 }), { row: 1, col: 3, length: 1 });
  assert.equal(findNext(lines, '', { row: 0, col: 0 }), null);
  assert.equal(findNext(lines, 'missing', { row: 0, col: 0 }), null);
  assert.equal(findNext(['ab', 'cd'], 'b\nc', { row: 0, col: 0 }), null);
  assert.equal(JSON.stringify(lines), before);
});

test('reviewer: ASCII-only folding preserves source indices beside Unicode characters', () => {
  assert.deepEqual(findNext(['İX'], 'x', { row: 0, col: 0 }), { row: 0, col: 1, length: 1 });
  assert.equal(findNext(['K'], 'k', { row: 0, col: 0 }), null);
  assert.deepEqual(findNext(['😀END'], 'end', { row: 0, col: 0 }), { row: 0, col: 2, length: 3 });
});
