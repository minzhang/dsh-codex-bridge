/**
 * Deterministic, terminal-independent editor model.
 *
 * The buffer is an immutable value: every reducer result is a fresh state that
 * shares nothing mutable with its input. Content edits are undoable snapshots;
 * navigation is deliberately outside of history.
 */

/** Newline convention used when serializing the buffer. */
export type Eol = '\n' | '\r\n';

/** A zero-based cursor location. */
export interface Position {
  row: number;
  col: number;
}

/** The undoable part of an editor state. */
export interface EditorSnapshot {
  lines: string[];
  cursor: Position;
  preferredCol: number;
}

/** Complete editor state. */
export interface EditorState {
  lines: string[];
  cursor: Position;
  preferredCol: number;
  filePath: string | null;
  eol: Eol;
  /**
   * Whether the document carried a UTF-8 byte-order mark when loaded. The BOM
   * is file metadata: it is never part of `lines`, cursor positions, or edited
   * text, but `serialize` re-emits it for loaded documents.
   */
  bom: boolean;
  /** Serialized content at the last save point. */
  savedContent: string;
  undoStack: EditorSnapshot[];
  redoStack: EditorSnapshot[];
}

export type MoveDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageUp'
  | 'pageDown';

export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'newline' }
  | { type: 'move'; direction: MoveDirection; pageSize?: number }
  | { type: 'undo' }
  | { type: 'redo' };

const HISTORY_LIMIT = 200;
const DEFAULT_PAGE_SIZE = 20;
const TAB_REPLACEMENT = '  ';

/**
 * Create an editor state. The first newline convention in `text` is retained
 * for serialization; CRLF and lone CR are normalized to LF lines. A trailing
 * newline is preserved as a final empty line. One leading U+FEFF is recorded
 * as BOM metadata and stripped from the editable buffer. A new document starts
 * clean and without history.
 */
export function createEditor(text = '', filePath?: string): EditorState {
  const bom = text.startsWith('\uFEFF');
  const body = bom ? text.slice(1) : text;
  const eol = detectEol(body);
  const lines = normalizeNewlines(body).split('\n');
  const savedContent = `${bom ? '\uFEFF' : ''}${lines.join(eol)}`;

  return {
    lines,
    cursor: { row: 0, col: 0 },
    preferredCol: 0,
    filePath: filePath ?? null,
    eol,
    bom,
    savedContent,
    undoStack: [],
    redoStack: [],
  };
}

/** Join the buffer lines using the state's newline convention and BOM flag. */
export function serialize(state: EditorState): string {
  return `${state.bom ? '\uFEFF' : ''}${state.lines.join(state.eol)}`;
}

/** Whether the current content differs from the last saved content. */
export function isDirty(state: EditorState): boolean {
  return serialize(state) !== state.savedContent;
}

/**
 * Record the current content and path as the save point. Undo and redo history
 * are preserved, and snapshots never carry a file path or a saved baseline.
 */
export function markSaved(state: EditorState, filePath?: string): EditorState {
  return {
    ...state,
    filePath: filePath === undefined ? state.filePath : filePath,
    savedContent: serialize(state),
  };
}

/** Apply one action, returning a new state. Ineffective actions are no-ops. */
export function reduceEditor(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'insert':
      return insertText(state, action.text);
    case 'newline':
      return insertText(state, '\n');
    case 'backspace':
      return backspace(state);
    case 'delete':
      return deleteForward(state);
    case 'move':
      return moveCursor(state, action.direction, action.pageSize);
    case 'undo':
      return undo(state);
    case 'redo':
      return redo(state);
    default:
      return state;
  }
}

function detectEol(text: string): Eol {
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\n') {
      return '\n';
    }
    if (char === '\r') {
      return text[index + 1] === '\n' ? '\r\n' : '\n';
    }
  }
  return '\n';
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function normalizeInsertedText(text: string): string {
  return normalizeNewlines(text).replace(/\t/g, TAB_REPLACEMENT);
}

function lineAt(state: EditorState, row: number): string {
  return state.lines[row] ?? '';
}

function snapshotOf(state: EditorState): EditorSnapshot {
  return {
    lines: state.lines.slice(),
    cursor: { ...state.cursor },
    preferredCol: state.preferredCol,
  };
}

function appendSnapshot(
  stack: EditorSnapshot[],
  snapshot: EditorSnapshot,
): EditorSnapshot[] {
  const next = stack.concat(snapshot);
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

function applyContentEdit(
  state: EditorState,
  lines: string[],
  cursor: Position,
): EditorState {
  return {
    ...state,
    lines,
    cursor,
    preferredCol: cursor.col,
    undoStack: appendSnapshot(state.undoStack, snapshotOf(state)),
    redoStack: [],
  };
}

function moveTo(
  state: EditorState,
  cursor: Position,
  preferredCol: number = cursor.col,
): EditorState {
  if (
    state.cursor.row === cursor.row &&
    state.cursor.col === cursor.col &&
    state.preferredCol === preferredCol
  ) {
    return state;
  }

  return {
    ...state,
    cursor: { row: cursor.row, col: cursor.col },
    preferredCol,
  };
}

function insertText(state: EditorState, rawText: string): EditorState {
  const text = normalizeInsertedText(rawText);
  if (text === '') {
    return state;
  }

  const { row, col } = state.cursor;
  const line = lineAt(state, row);
  const before = line.slice(0, col);
  const after = line.slice(col);
  const parts = text.split('\n');
  const first = parts[0] ?? '';
  const lines = state.lines.slice();

  if (parts.length === 1) {
    lines[row] = before + first + after;
    return applyContentEdit(state, lines, { row, col: col + first.length });
  }

  const last = parts[parts.length - 1] ?? '';
  lines[row] = before + first;
  lines.splice(row + 1, 0, ...parts.slice(1, -1), last + after);

  return applyContentEdit(state, lines, {
    row: row + parts.length - 1,
    col: last.length,
  });
}

function backspace(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = lineAt(state, row);

  if (col > 0) {
    const lines = state.lines.slice();
    lines[row] = line.slice(0, col - 1) + line.slice(col);
    return applyContentEdit(state, lines, { row, col: col - 1 });
  }

  if (row > 0) {
    const previous = lineAt(state, row - 1);
    const lines = state.lines.slice();
    lines[row - 1] = previous + line;
    lines.splice(row, 1);
    return applyContentEdit(state, lines, { row: row - 1, col: previous.length });
  }

  return state;
}

function deleteForward(state: EditorState): EditorState {
  const { row, col } = state.cursor;
  const line = lineAt(state, row);

  if (col < line.length) {
    const lines = state.lines.slice();
    lines[row] = line.slice(0, col) + line.slice(col + 1);
    return applyContentEdit(state, lines, { row, col });
  }

  if (row < state.lines.length - 1) {
    const lines = state.lines.slice();
    lines[row] = line + lineAt(state, row + 1);
    lines.splice(row + 1, 1);
    return applyContentEdit(state, lines, { row, col });
  }

  return state;
}

function moveCursor(
  state: EditorState,
  direction: MoveDirection,
  pageSize?: number,
): EditorState {
  const { row, col } = state.cursor;

  switch (direction) {
    case 'left':
      if (col > 0) {
        return moveTo(state, { row, col: col - 1 });
      }
      if (row > 0) {
        return moveTo(state, { row: row - 1, col: lineAt(state, row - 1).length });
      }
      return state;
    case 'right': {
      const lineLength = lineAt(state, row).length;
      if (col < lineLength) {
        return moveTo(state, { row, col: col + 1 });
      }
      if (row < state.lines.length - 1) {
        return moveTo(state, { row: row + 1, col: 0 });
      }
      return state;
    }
    case 'home':
      return moveTo(state, { row, col: 0 });
    case 'end':
      return moveTo(state, { row, col: lineAt(state, row).length });
    default: {
      const lastRow = state.lines.length - 1;
      let targetRow: number;

      if (direction === 'up') {
        if (row === 0) {
          return state;
        }
        targetRow = row - 1;
      } else if (direction === 'down') {
        if (row === lastRow) {
          return state;
        }
        targetRow = row + 1;
      } else if (direction === 'pageUp') {
        targetRow = Math.max(0, row - normalizePageSize(pageSize));
      } else {
        targetRow = Math.min(lastRow, row + normalizePageSize(pageSize));
      }

      const targetCol = Math.max(
        0,
        Math.min(state.preferredCol, lineAt(state, targetRow).length),
      );

      return moveTo(state, { row: targetRow, col: targetCol }, state.preferredCol);
    }
  }
}

function undo(state: EditorState): EditorState {
  const target = state.undoStack[state.undoStack.length - 1];
  if (target === undefined) {
    return state;
  }

  return {
    ...state,
    lines: target.lines.slice(),
    cursor: { ...target.cursor },
    preferredCol: target.preferredCol,
    undoStack: state.undoStack.slice(0, -1),
    redoStack: appendSnapshot(state.redoStack, snapshotOf(state)),
  };
}

function redo(state: EditorState): EditorState {
  const target = state.redoStack[state.redoStack.length - 1];
  if (target === undefined) {
    return state;
  }

  return {
    ...state,
    lines: target.lines.slice(),
    cursor: { ...target.cursor },
    preferredCol: target.preferredCol,
    undoStack: appendSnapshot(state.undoStack, snapshotOf(state)),
    redoStack: state.redoStack.slice(0, -1),
  };
}

function normalizePageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.max(1, Math.floor(pageSize));
}
