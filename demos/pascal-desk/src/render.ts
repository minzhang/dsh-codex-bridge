/**
 * Pure, bounded terminal frame renderer.
 *
 * The renderer owns all ANSI used for presentation. Text that comes from the
 * editor, filename, or status is sanitized first, so control sequences from
 * content can never reach the terminal. Each returned row has at most
 * `columns - 1` display cells to avoid terminal autowrap.
 */

import { MENU_ITEMS, fitViewport, type AppState } from './app.js';
import { isDirty } from './editor.js';
import { highlightLine, type TokenKind } from './syntax.js';

export interface RenderResult {
  output: string;
  cursor: { row: number; col: number } | null;
}

const MIN_COLUMNS = 60;
const MIN_ROWS = 16;

const RESET = '\x1b[0m';
const CONTENT_STYLE = '\x1b[44;37m';
const BORDER_STYLE = '\x1b[44;36m';
const MENU_STYLE = '\x1b[30;47m';
const STATUS_STYLE = '\x1b[30;47m';
const SHORTCUT_STYLE = '\x1b[30;47m';
const OVERLAY_STYLE = '\x1b[30;47m';
const OVERLAY_BORDER = '\x1b[44;36m';
const OVERLAY_TITLE = '\x1b[30;47m';
const SELECTED_STYLE = '\x1b[30;46m';
const NOTICE_STYLE = '\x1b[44;97m';
const KEYWORD_STYLE = '\x1b[44;93m';
const STRING_STYLE = '\x1b[44;92m';
const COMMENT_STYLE = '\x1b[44;96m';
const NUMBER_STYLE = '\x1b[44;95m';
const MATCH_STYLE = '\x1b[30;103m';

const MENU_BAR = 'File  Edit  Search  Help';
const MENU_HINT = 'F10 Menu  F1 Help';
const SHORTCUT_BAR =
  'F1 Help  F2 Save  F3 Open  F4 Next  F10 Menu  Ctrl+Q Quit';

const HELP_LINES = [
  'F1 toggles help; Escape closes overlays.',
  'F10 opens the menu; Up/Down choose; Enter selects.',
  'Arrows, Home, End, PageUp, PageDown move.',
  'Enter starts a line. Tab inserts two spaces.',
  'Ctrl+Z undo, Ctrl+Y redo.',
  'F2/Ctrl+S save current file or prompt Save As.',
  'F3/Ctrl+O open; Ctrl+N new. Unsaved changes ask Y/N.',
  'Ctrl+F find; F4 finds the next match.',
  'Ctrl+Q/Ctrl+C quit with dirty protection.',
  'Open/Save As accept paths containing spaces; Esc cancels.',
  'UTF-8 files up to 1 MiB; LF/CRLF and a BOM are preserved.',
  'Find is literal, ASCII case-insensitive, and wraps once.',
  'Coloring is single-line; cursor widths are ASCII-oriented.',
];

interface ScreenCell {
  char: string;
  style: string;
  continuation: boolean;
}

/**
 * Size of the editor viewport inside the frame. Exported so the CLI can pass
 * the same page size that the renderer displays.
 */
export function editorAreaSize(
  columns: number,
  rows: number,
): { rows: number; cols: number } {
  const width = Math.max(0, normalizeDimension(columns) - 1);
  const height = normalizeDimension(rows);
  return {
    rows: Math.max(1, height - 5),
    cols: Math.max(1, width - 2),
  };
}

export function renderScreen(
  state: AppState,
  columns: number,
  rows: number,
): RenderResult {
  const frameWidth = Math.max(0, normalizeDimension(columns) - 1);
  const frameRows = normalizeDimension(rows);

  if (frameRows === 0) {
    return { output: '', cursor: null };
  }

  if (normalizeDimension(columns) < MIN_COLUMNS || frameRows < MIN_ROWS) {
    return {
      output: renderResizeNotice(
        state,
        frameWidth,
        frameRows,
        normalizeDimension(columns),
      ),
      cursor: null,
    };
  }

  const area = editorAreaSize(columns, frameRows);
  const fitted = fitViewport(state, area.rows, area.cols);
  const viewLeft = horizontalViewLeft(fitted, area.cols);
  const view: AppState =
    viewLeft === fitted.leftCol ? fitted : { ...fitted, leftCol: viewLeft };
  const frame = Array.from({ length: frameRows }, () =>
    createRow(frameWidth, CONTENT_STYLE),
  );

  const menuRow = frame[0];
  if (menuRow !== undefined) {
    fillCells(menuRow, 0, frameWidth, MENU_STYLE);
    putText(menuRow, 1, MENU_BAR, MENU_STYLE, Math.max(1, frameWidth - 1));
    const hintStart = Math.max(1, frameWidth - 1 - MENU_HINT.length);
    putText(menuRow, hintStart, MENU_HINT, MENU_STYLE, Math.max(1, frameWidth - 1));
  }

  const dirty = isDirty(state.editor);
  drawTopBorder(frame[1], frameWidth, state, dirty);

  for (let screenRow = 0; screenRow < area.rows; screenRow += 1) {
    const row = frame[2 + screenRow];
    if (row === undefined) {
      break;
    }
    fillCells(row, 0, frameWidth, CONTENT_STYLE);
    if (frameWidth > 0) {
      setCell(row, 0, '|', BORDER_STYLE);
    }
    if (frameWidth > 1) {
      setCell(row, frameWidth - 1, '|', BORDER_STYLE);
    }

    const line = view.editor.lines[view.topLine + screenRow];
    if (line === undefined) {
      continue;
    }

    const maxCol = 1 + area.cols;
    let col = 1;
    let consumed = 0;
    for (const token of highlightLine(line)) {
      const tokenStart = consumed;
      consumed += token.text.length;
      if (consumed <= view.leftCol) {
        continue;
      }
      const skip = Math.max(0, view.leftCol - tokenStart);
      col = putText(
        row,
        col,
        token.text.slice(skip),
        styleForToken(token.kind),
        maxCol,
      );
      if (col >= maxCol) {
        break;
      }
    }

    applyMatchHighlight(row, line, view, area, state.highlight, screenRow);
  }

  drawBottomBorder(frame[frameRows - 3], frameWidth);
  drawStatusRow(frame[frameRows - 2], frameWidth, state, dirty);
  drawShortcutRow(frame[frameRows - 1], frameWidth);

  let cursor: { row: number; col: number } | null = null;
  if (state.overlay === 'help') {
    drawHelpOverlay(frame, area);
  } else if (state.overlay === 'menu') {
    drawMenuOverlay(frame, area, state.menuIndex);
  } else if (state.overlay === 'prompt') {
    cursor = drawPromptOverlay(frame, area, state);
  } else if (state.overlay === 'confirm') {
    drawConfirmOverlay(frame, area, state);
  } else {
    cursor = cursorFor(view, area);
  }

  return {
    output: frame.map(serializeRow).join('\r\n'),
    cursor,
  };
}

/**
 * Convert the state's character-based left column into a character window that
 * keeps the cursor's display column visible after tabs and wide characters are
 * expanded. This keeps loaded tab-indented files horizontally scrollable.
 */
function horizontalViewLeft(state: AppState, visibleCols: number): number {
  const cursor = state.editor.cursor;
  const line = state.editor.lines[cursor.row] ?? '';
  const leftCol = state.leftCol;
  const before = widthOf(sanitizeText(line.slice(0, leftCol)));
  const throughCursor = widthOf(sanitizeText(line.slice(0, cursor.col)));

  if (throughCursor < before) {
    return cursor.col;
  }
  if (throughCursor < before + visibleCols) {
    return leftCol;
  }

  const targetWidth = throughCursor - visibleCols + 1;
  let index = leftCol;
  let width = before;
  while (index < cursor.col && width < targetWidth) {
    width += widthOf(sanitizeText(line[index] ?? ''));
    index += 1;
  }
  return index;
}

function applyMatchHighlight(
  row: ScreenCell[] | undefined,
  line: string,
  view: AppState,
  area: { rows: number; cols: number },
  match: AppState['highlight'],
  screenRow: number,
): void {
  if (row === undefined || match === null || match.length <= 0) {
    return;
  }
  if (match.row !== view.topLine + screenRow) {
    return;
  }

  const lineStart = line.slice(0, match.col);
  const matched = line.slice(match.col, match.col + match.length);
  const leftStart = line.slice(0, view.leftCol);
  const before = widthOf(sanitizeText(lineStart)) - widthOf(sanitizeText(leftStart));
  const width = widthOf(sanitizeText(matched));
  const start = Math.max(1, 1 + before);
  const end = Math.min(1 + area.cols, start + width);

  recolorRange(row, start, end, MATCH_STYLE);
}

function recolorRange(
  row: ScreenCell[],
  start: number,
  end: number,
  style: string,
): void {
  const from = Math.max(0, start);
  const to = Math.min(row.length, end);
  for (let col = from; col < to; col += 1) {
    const cell = row[col];
    if (cell !== undefined) {
      row[col] = { ...cell, style };
    }
  }
}

function cursorFor(
  state: AppState,
  area: { rows: number; cols: number },
): { row: number; col: number } | null {
  const cursor = state.editor.cursor;
  if (
    cursor.row < state.topLine ||
    cursor.row >= state.topLine + area.rows
  ) {
    return null;
  }

  const line = state.editor.lines[cursor.row] ?? '';
  const before = widthOf(sanitizeText(line.slice(0, state.leftCol)));
  const throughCursor = widthOf(sanitizeText(line.slice(0, cursor.col)));
  const offset = Math.max(0, throughCursor - before);
  if (offset >= area.cols) {
    return null;
  }

  return {
    row: 3 + (cursor.row - state.topLine),
    col: 2 + offset,
  };
}

function drawTopBorder(
  row: ScreenCell[] | undefined,
  width: number,
  state: AppState,
  dirty: boolean,
): void {
  if (row === undefined) {
    return;
  }
  fillCells(row, 0, width, BORDER_STYLE);
  for (let col = 1; col < width - 1; col += 1) {
    setCell(row, col, '-', BORDER_STYLE);
  }
  if (width > 0) {
    setCell(row, 0, '+', BORDER_STYLE);
  }
  if (width > 1) {
    setCell(row, width - 1, '+', BORDER_STYLE);
  }

  const name = displayFileName(state.editor.filePath);
  const title = `[ ${name}${dirty ? ' *' : ''} ]`;
  putText(row, 1, title, BORDER_STYLE, Math.max(1, width - 1));
}

function drawBottomBorder(row: ScreenCell[] | undefined, width: number): void {
  if (row === undefined) {
    return;
  }
  fillCells(row, 0, width, BORDER_STYLE);
  for (let col = 1; col < width - 1; col += 1) {
    setCell(row, col, '-', BORDER_STYLE);
  }
  if (width > 0) {
    setCell(row, 0, '+', BORDER_STYLE);
  }
  if (width > 1) {
    setCell(row, width - 1, '+', BORDER_STYLE);
  }
}

function drawStatusRow(
  row: ScreenCell[] | undefined,
  width: number,
  state: AppState,
  dirty: boolean,
): void {
  if (row === undefined) {
    return;
  }
  fillCells(row, 0, width, STATUS_STYLE);
  const cursor = state.editor.cursor;
  const parts = [`Ln ${cursor.row + 1}, Col ${cursor.col + 1}`];
  if (dirty) {
    parts.push('[Modified]');
  }
  if (state.status !== '') {
    parts.push(state.status);
  }
  putText(row, 1, parts.join('  '), STATUS_STYLE, Math.max(1, width - 1));
}

function drawShortcutRow(row: ScreenCell[] | undefined, width: number): void {
  if (row === undefined) {
    return;
  }
  fillCells(row, 0, width, SHORTCUT_STYLE);
  putText(row, 1, SHORTCUT_BAR, SHORTCUT_STYLE, Math.max(1, width - 1));
}

function drawHelpOverlay(
  frame: ScreenCell[][],
  area: { rows: number; cols: number },
): void {
  const boxWidth = Math.min(area.cols, 56);
  const boxHeight = Math.min(area.rows, HELP_LINES.length + 2);
  const box = drawBox(frame, area, boxWidth, boxHeight, 'Help');
  if (box === null) {
    return;
  }

  for (let index = 0; index < boxHeight - 2; index += 1) {
    const row = frame[box.row + 1 + index];
    if (row === undefined) {
      break;
    }
    const text = HELP_LINES[index] ?? '';
    putText(row, box.col + 2, text, OVERLAY_STYLE, box.col + boxWidth - 1);
  }
}

function drawMenuOverlay(
  frame: ScreenCell[][],
  area: { rows: number; cols: number },
  rawIndex: number,
): void {
  const boxWidth = Math.min(area.cols, 20);
  const boxHeight = Math.min(area.rows, MENU_ITEMS.length + 2);
  const box = drawBox(frame, area, boxWidth, boxHeight, 'Menu');
  if (box === null) {
    return;
  }

  const selected = normalizeMenuIndex(rawIndex, MENU_ITEMS.length);
  const visibleItems = Math.min(MENU_ITEMS.length, boxHeight - 2);
  for (let index = 0; index < visibleItems; index += 1) {
    const row = frame[box.row + 1 + index];
    const item = MENU_ITEMS[index];
    if (row === undefined || item === undefined) {
      break;
    }
    const isSelected = index === selected;
    const style = isSelected ? SELECTED_STYLE : OVERLAY_STYLE;
    fillCells(row, box.col + 1, box.col + boxWidth - 1, style);
    putText(
      row,
      box.col + 2,
      item.label,
      style,
      box.col + boxWidth - 1,
    );
  }
}

function drawPromptOverlay(
  frame: ScreenCell[][],
  area: { rows: number; cols: number },
  state: AppState,
): { row: number; col: number } | null {
  const prompt = state.prompt;
  if (prompt === null) {
    return null;
  }

  const title =
    prompt.kind === 'open' ? 'Open File' : prompt.kind === 'saveAs' ? 'Save As' : 'Find';
  const boxWidth = Math.max(2, Math.min(area.cols, 60));
  const boxHeight = Math.min(area.rows, 6);
  const box = drawBox(frame, area, boxWidth, boxHeight, title);
  if (box === null) {
    return null;
  }

  const innerStart = box.col + 2;
  const innerMax = box.col + boxWidth - 1;
  const valueRow = frame[box.row + 1];
  const prefix = prompt.kind === 'find' ? 'Find: ' : 'Path: ';
  const available = Math.max(0, innerMax - innerStart - prefix.length);
  const display = promptDisplay(prompt.value, available);

  if (valueRow !== undefined) {
    putText(valueRow, innerStart, `${prefix}${display.text}`, OVERLAY_STYLE, innerMax);
  }

  if (prompt.message !== '') {
    const messageRow = frame[box.row + 2];
    if (messageRow !== undefined) {
      putText(messageRow, innerStart, prompt.message, OVERLAY_STYLE, innerMax);
    }
  }

  const hintRow = frame[box.row + 3];
  if (hintRow !== undefined && boxHeight > 4) {
    const hint = prompt.kind === 'find' ? 'Enter find  Esc cancel' : 'Enter accept  Esc cancel';
    putText(hintRow, innerStart, hint, OVERLAY_STYLE, innerMax);
  }

  const cursorCol = Math.min(
    innerMax,
    innerStart + prefix.length + display.cursor + 1,
  );
  return { row: box.row + 2, col: Math.max(1, cursorCol) };
}

function drawConfirmOverlay(
  frame: ScreenCell[][],
  area: { rows: number; cols: number },
  state: AppState,
): void {
  const confirm = state.confirm;
  if (confirm === null) {
    return;
  }

  const boxWidth = Math.max(2, Math.min(area.cols, 60));
  const boxHeight = Math.min(area.rows, confirm.kind === 'overwrite' ? 7 : 6);
  const box = drawBox(frame, area, boxWidth, boxHeight, 'Confirm');
  if (box === null) {
    return;
  }

  const innerStart = box.col + 2;
  const innerMax = box.col + boxWidth - 1;
  const messageRow = frame[box.row + 1];
  if (messageRow !== undefined) {
    putText(messageRow, innerStart, confirm.message, OVERLAY_STYLE, innerMax);
  }

  if (
    confirm.kind === 'overwrite' &&
    confirm.action.type === 'save'
  ) {
    const pathRow = frame[box.row + 2];
    if (pathRow !== undefined) {
      putText(
        pathRow,
        innerStart,
        confirm.action.path,
        OVERLAY_STYLE,
        innerMax,
      );
    }
  }

  const hintRow = frame[box.row + (confirm.kind === 'overwrite' ? 3 : 2)];
  if (hintRow !== undefined) {
    putText(
      hintRow,
      innerStart,
      'Y confirm  N/Esc cancel',
      OVERLAY_STYLE,
      innerMax,
    );
  }
}

function promptDisplay(
  value: string,
  maxWidth: number,
): { text: string; cursor: number } {
  if (maxWidth <= 0) {
    return { text: '', cursor: 0 };
  }

  const safe = sanitizeText(value);
  if (widthOf(safe) <= maxWidth) {
    return { text: safe, cursor: widthOf(safe) };
  }

  let suffix = '';
  let width = 0;
  const chars = Array.from(safe);
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index] ?? '';
    const charSize = charWidth(char);
    if (width + charSize > Math.max(0, maxWidth - 1)) {
      break;
    }
    suffix = char + suffix;
    width += charSize;
  }
  return { text: `~${suffix}`, cursor: Math.min(maxWidth, 1 + width) };
}

function drawBox(
  frame: ScreenCell[][],
  area: { rows: number; cols: number },
  boxWidth: number,
  boxHeight: number,
  title: string,
): { row: number; col: number } | null {
  if (boxWidth < 2 || boxHeight < 2) {
    return null;
  }

  const startRow = 2 + Math.floor((area.rows - boxHeight) / 2);
  const startCol = 1 + Math.floor((area.cols - boxWidth) / 2);

  for (let offset = 0; offset < boxHeight; offset += 1) {
    const row = frame[startRow + offset];
    if (row === undefined) {
      return null;
    }
    fillCells(row, startCol, startCol + boxWidth, OVERLAY_STYLE);
    setCell(row, startCol, offset === 0 || offset === boxHeight - 1 ? '+' : '|', OVERLAY_BORDER);
    setCell(
      row,
      startCol + boxWidth - 1,
      offset === 0 || offset === boxHeight - 1 ? '+' : '|',
      OVERLAY_BORDER,
    );
    if (offset === 0 || offset === boxHeight - 1) {
      for (let col = 1; col < boxWidth - 1; col += 1) {
        setCell(row, startCol + col, '-', OVERLAY_BORDER);
      }
    }
  }

  const top = frame[startRow];
  if (top !== undefined) {
    putText(
      top,
      startCol + 2,
      ` ${title} `,
      OVERLAY_TITLE,
      startCol + boxWidth - 1,
    );
  }

  return { row: startRow, col: startCol };
}

function renderResizeNotice(
  state: AppState,
  width: number,
  rows: number,
  columns: number,
): string {
  const frame = Array.from({ length: rows }, () => createRow(width, CONTENT_STYLE));
  let messages: string[];
  let first = 0;

  if (state.overlay === 'confirm' && state.confirm !== null) {
    // The pending question is the most important content when the terminal is
    // tiny, so it occupies the first rows instead of being pushed off-screen.
    messages = [state.confirm.message];
    if (
      state.confirm.kind === 'overwrite' &&
      state.confirm.action.type === 'save'
    ) {
      messages.push(state.confirm.action.path);
    }
    messages.push('Y confirm  N/Esc cancel');
    messages.push('Terminal too small');
  } else if (state.overlay === 'prompt' && state.prompt !== null) {
    const title =
      state.prompt.kind === 'open'
        ? 'Open'
        : state.prompt.kind === 'saveAs'
          ? 'Save As'
          : 'Find';
    messages = [
      `${title}: ${state.prompt.value}`,
      'Esc cancel',
      'Terminal too small',
    ];
  } else {
    messages = [
      'Terminal too small',
      `Need at least ${MIN_COLUMNS} x ${MIN_ROWS}`,
      `Current: ${columns} x ${rows}`,
      'Ctrl+Q Quit   Esc Cancel',
    ];
    first = Math.max(0, Math.floor((rows - messages.length) / 2));
  }

  for (let index = 0; index < messages.length; index += 1) {
    const row = frame[first + index];
    const message = messages[index];
    if (row === undefined || message === undefined) {
      continue;
    }
    const start = Math.max(0, Math.floor((width - message.length) / 2));
    putText(row, start, message, NOTICE_STYLE);
  }

  return frame.map(serializeRow).join('\r\n');
}

function styleForToken(kind: TokenKind): string {
  switch (kind) {
    case 'keyword':
      return KEYWORD_STYLE;
    case 'string':
      return STRING_STYLE;
    case 'comment':
      return COMMENT_STYLE;
    case 'number':
      return NUMBER_STYLE;
    case 'plain':
    default:
      return CONTENT_STYLE;
  }
}

function createRow(width: number, style: string): ScreenCell[] {
  return Array.from({ length: width }, () => ({
    char: ' ',
    style,
    continuation: false,
  }));
}

function putText(
  row: ScreenCell[],
  start: number,
  text: string,
  style: string,
  maxCol: number = row.length,
): number {
  let col = Math.max(0, start);

  for (const char of sanitizeText(text)) {
    if (col >= maxCol || col >= row.length) {
      break;
    }
    const width = charWidth(char);
    if (width === 0) {
      const previous = previousBaseCell(row, col);
      if (previous >= 0) {
        const cell = row[previous];
        if (cell !== undefined) {
          row[previous] = { ...cell, char: cell.char + char };
        }
      }
      continue;
    }
    if (col + width > maxCol || col + width > row.length) {
      break;
    }
    clearCell(row, col);
    row[col] = { char, style, continuation: false };
    if (width === 2) {
      clearCell(row, col + 1);
      row[col + 1] = { char: '', style, continuation: true };
    }
    col += width;
  }

  return col;
}

function fillCells(
  row: ScreenCell[],
  start: number,
  end: number,
  style: string,
): void {
  const from = Math.max(0, start);
  const to = Math.min(row.length, end);
  for (let col = from; col < to; col += 1) {
    clearCell(row, col);
    row[col] = { char: ' ', style, continuation: false };
  }
}

function setCell(row: ScreenCell[], index: number, char: string, style: string): void {
  if (index < 0 || index >= row.length) {
    return;
  }
  clearCell(row, index);
  row[index] = { char, style, continuation: false };
}

function clearCell(row: ScreenCell[], index: number): void {
  const cell = row[index];
  if (cell === undefined) {
    return;
  }
  if (cell.continuation && index > 0) {
    const base = row[index - 1];
    if (base !== undefined) {
      row[index - 1] = { char: ' ', style: base.style, continuation: false };
    }
  }
  if (index + 1 < row.length && row[index + 1]?.continuation === true) {
    row[index + 1] = { char: ' ', style: cell.style, continuation: false };
  }
  row[index] = { char: ' ', style: cell.style, continuation: false };
}

function previousBaseCell(row: ScreenCell[], col: number): number {
  let index = col - 1;
  while (index >= 0 && row[index]?.continuation === true) {
    index -= 1;
  }
  return index;
}

function serializeRow(row: ScreenCell[]): string {
  let output = '';
  let style = '';
  for (const cell of row) {
    if (cell.continuation) {
      continue;
    }
    if (cell.style !== style) {
      output += cell.style;
      style = cell.style;
    }
    output += cell.char;
  }
  return output + RESET;
}

function displayFileName(filePath: string | null): string {
  if (filePath === null || filePath === '') {
    return 'No Name';
  }
  const parts = filePath.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? '';
  return name === '' ? filePath : name;
}

function sanitizeText(text: string): string {
  let output = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\t') {
      output += '  ';
    } else if (code === 0x1b) {
      output += '^[';
    } else if (code === 0x7f) {
      output += '^?';
    } else if (code < 0x20) {
      output += `^${String.fromCharCode(code + 64)}`;
    } else if (code >= 0x80 && code <= 0x9f) {
      output += `\\x${code.toString(16).padStart(2, '0')}`;
    } else {
      output += char;
    }
  }
  return output;
}

function widthOf(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char);
  }
  return width;
}

function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (isCombining(code)) {
    return 0;
  }
  if (isWide(code)) {
    return 2;
  }
  return 1;
}

function isCombining(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  );
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xa960 && code <= 0xa97f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function normalizeMenuIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) {
    return 0;
  }
  const whole = Math.floor(index);
  return ((whole % count) + count) % count;
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
