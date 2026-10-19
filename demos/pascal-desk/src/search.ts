/**
 * Pure literal search over editor lines.
 *
 * Matching is case-insensitive for ASCII letters only, never crosses a line
 * boundary, starts at the supplied position inclusively, and wraps once. The
 * returned position is a zero-based editor character position.
 */

import type { Position } from './editor.js';

export interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

/**
 * Find the next occurrence of `query` at or after `from`, wrapping once around
 * the document. Returns `null` for an empty query or when there is no match.
 */
export function findNext(
  lines: string[],
  query: string,
  from: Position,
): SearchMatch | null {
  if (query === '' || lines.length === 0) {
    return null;
  }

  const startRow = clamp(Math.trunc(from.row), 0, lines.length - 1);
  const startLine = lines[startRow] ?? '';
  const startCol = clamp(Math.trunc(from.col), 0, startLine.length);

  // Scan the starting line from the requested column to its end, then every
  // following line, wrapping to the first line. The start line's earlier
  // columns are the final partial pass so the search wraps exactly once.
  for (let row = startRow; row < lines.length; row += 1) {
    const line = lines[row] ?? '';
    const col = findInLine(line, query, row === startRow ? startCol : 0);
    if (col !== -1) {
      return { row, col, length: query.length };
    }
  }

  for (let row = 0; row < startRow; row += 1) {
    const line = lines[row] ?? '';
    const col = findInLine(line, query, 0);
    if (col !== -1) {
      return { row, col, length: query.length };
    }
  }

  const col = findInLine(startLine, query, 0, startCol);
  if (col !== -1) {
    return { row: startRow, col, length: query.length };
  }

  return null;
}

/**
 * Find `query` in one line at or after `fromCol`. When `beforeCol` is given,
 * matches must start strictly before it. This is used only for the wrapped
 * tail of the starting line.
 */
function findInLine(
  line: string,
  query: string,
  fromCol: number,
  beforeCol?: number,
): number {
  const lastStart = line.length - query.length;
  const end = beforeCol === undefined ? lastStart : Math.min(lastStart, beforeCol - 1);
  const start = Math.max(0, fromCol);

  for (let index = start; index <= end; index += 1) {
    if (matchesAt(line, query, index)) {
      return index;
    }
  }

  return -1;
}

function matchesAt(line: string, query: string, start: number): boolean {
  for (let offset = 0; offset < query.length; offset += 1) {
    if (foldAscii(line[start + offset] ?? '') !== foldAscii(query[offset] ?? '')) {
      return false;
    }
  }
  return true;
}

function foldAscii(char: string): string {
  const code = char.charCodeAt(0);
  if (code >= 0x41 && code <= 0x5a) {
    return String.fromCharCode(code + 0x20);
  }
  return char;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return minimum;
  }
  return Math.min(Math.max(value, minimum), maximum);
}
