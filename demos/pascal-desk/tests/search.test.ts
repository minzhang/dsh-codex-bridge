import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findNext } from '../src/search.js';

const LINES = ['alpha Beta gamma', 'beta again', 'no match here'];

test('findNext matches literally and case-insensitively for ASCII', () => {
  assert.deepEqual(findNext(LINES, 'BETA', { row: 0, col: 0 }), {
    row: 0,
    col: 6,
    length: 4,
  });
  assert.deepEqual(findNext(LINES, 'bEtA', { row: 0, col: 0 }), {
    row: 0,
    col: 6,
    length: 4,
  });
  assert.deepEqual(findNext(LINES, 'gamma', { row: 0, col: 0 }), {
    row: 0,
    col: 11,
    length: 5,
  });
});

test('findNext starts at the supplied position inclusively', () => {
  assert.deepEqual(findNext(LINES, 'beta', { row: 0, col: 6 }), {
    row: 0,
    col: 6,
    length: 4,
  });
  assert.deepEqual(findNext(LINES, 'beta', { row: 0, col: 7 }), {
    row: 1,
    col: 0,
    length: 4,
  });
});

test('findNext never matches across a line boundary', () => {
  assert.equal(
    findNext(['ab', 'cd'], 'b\nc', { row: 0, col: 0 }),
    null,
  );
  assert.deepEqual(findNext(['aaaa', 'aaaa'], 'aa', { row: 0, col: 1 }), {
    row: 0,
    col: 1,
    length: 2,
  });
});

test('findNext wraps once to earlier positions in the starting line', () => {
  assert.deepEqual(findNext(['target only', 'none'], 'target', { row: 1, col: 0 }), {
    row: 0,
    col: 0,
    length: 6,
  });
  assert.deepEqual(findNext(['one target two'], 'target', { row: 0, col: 6 }), {
    row: 0,
    col: 4,
    length: 6,
  });
});

test('repeated searches walk matches and wrap after the last one', () => {
  const lines = ['aa aa'];
  const first = findNext(lines, 'aa', { row: 0, col: 0 });
  assert.deepEqual(first, { row: 0, col: 0, length: 2 });

  const second = findNext(lines, 'aa', { row: 0, col: 1 });
  assert.deepEqual(second, { row: 0, col: 3, length: 2 });

  const wrapped = findNext(lines, 'aa', { row: 0, col: 4 });
  assert.deepEqual(wrapped, { row: 0, col: 0, length: 2 });
});

test('empty queries and no-match queries return null', () => {
  assert.equal(findNext(LINES, '', { row: 0, col: 0 }), null);
  assert.equal(findNext(LINES, 'absent', { row: 0, col: 0 }), null);
  assert.equal(findNext([], 'anything', { row: 0, col: 0 }), null);
});

test('clamps out-of-range positions and ignores Unicode case folding', () => {
  assert.deepEqual(findNext(['abc'], 'a', { row: -4, col: -2 }), {
    row: 0,
    col: 0,
    length: 1,
  });
  assert.deepEqual(findNext(['abc'], 'c', { row: 99, col: 99 }), {
    row: 0,
    col: 2,
    length: 1,
  });
  assert.equal(findNext(['Ärger'], 'ärger', { row: 0, col: 0 }), null);
  assert.deepEqual(findNext(['Ärger'], 'Ärger', { row: 0, col: 0 }), {
    row: 0,
    col: 0,
    length: 5,
  });
});

test('queries longer than the line do not match', () => {
  assert.equal(findNext(['short'], 'longer than line', { row: 0, col: 0 }), null);
});
