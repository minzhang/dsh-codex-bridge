/**
 * Pure application controller: keyboard input to editor actions, command
 * intents, modal prompts/confirmations, search, and a viewport that keeps the
 * cursor visible.
 *
 * This module has no terminal or filesystem side effects. File operations are
 * expressed as typed effects; the adapter performs them and reports the result
 * through `completeEffect`.
 */

import {
  createEditor,
  isDirty,
  reduceEditor,
  type EditorAction,
  type EditorState,
  type MoveDirection,
} from './editor.js';
import { findNext, type SearchMatch } from './search.js';

export interface KeyInput {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export type Command = 'new' | 'open' | 'save' | 'saveAs' | 'find' | 'quit';
export type Overlay = 'none' | 'help' | 'menu' | 'prompt' | 'confirm';

/** A file prompt accepts a path or a literal search string. */
export interface PromptState {
  kind: 'open' | 'saveAs' | 'find';
  value: string;
  message: string;
}

/** What a confirmation will do if the user answers Y. */
export type PendingAction =
  | { type: 'new' }
  | { type: 'open' }
  | { type: 'quit' }
  | { type: 'save'; path: string };

export interface ConfirmState {
  kind: 'discard' | 'overwrite';
  message: string;
  action: PendingAction;
}

/** Effects the terminal adapter must perform. */
export type FileEffect =
  | { type: 'open'; path: string }
  | { type: 'save'; path: string; overwrite: boolean };

export type Effect = FileEffect | { type: 'quit' };

export interface EffectFailure {
  code?: string;
  message: string;
}

/** The adapter's report for an open/save effect. */
export type EffectResult =
  | { effect: FileEffect; ok: true; editor: EditorState }
  | { effect: FileEffect; ok: false; error: EffectFailure };

export interface AppState {
  editor: EditorState;
  topLine: number;
  leftCol: number;
  status: string;
  overlay: Overlay;
  menuIndex: number;
  prompt: PromptState | null;
  confirm: ConfirmState | null;
  /** The file effect currently awaited by the adapter, if any. */
  busy: FileEffect | null;
  /** Last submitted literal search query. */
  lastFind: string;
  /** Current match used for repeat-search positioning. */
  lastSearch: SearchMatch | null;
  /** Current match to highlight, if any. */
  highlight: SearchMatch | null;
}

export type MenuItem =
  | { label: string; kind: 'command'; command: Command }
  | { label: string; kind: 'edit'; edit: 'undo' | 'redo' }
  | { label: string; kind: 'help' };

export const MENU_ITEMS: readonly MenuItem[] = [
  { label: 'New', kind: 'command', command: 'new' },
  { label: 'Open', kind: 'command', command: 'open' },
  { label: 'Save', kind: 'command', command: 'save' },
  { label: 'Save As', kind: 'command', command: 'saveAs' },
  { label: 'Find', kind: 'command', command: 'find' },
  { label: 'Undo', kind: 'edit', edit: 'undo' },
  { label: 'Redo', kind: 'edit', edit: 'redo' },
  { label: 'Help', kind: 'help' },
  { label: 'Quit', kind: 'command', command: 'quit' },
];

export interface KeyResult {
  state: AppState;
  effect?: Effect;
}

export function createApp(editor: EditorState = createEditor()): AppState {
  return {
    editor,
    topLine: 0,
    leftCol: 0,
    status: '',
    overlay: 'none',
    menuIndex: 0,
    prompt: null,
    confirm: null,
    busy: null,
    lastFind: '',
    lastSearch: null,
    highlight: null,
  };
}

export function handleKey(
  state: AppState,
  key: KeyInput,
  pageSize?: number,
): KeyResult {
  // No edits or new file effects while an operation is in flight. Completion
  // arrives through `completeEffect`.
  if (state.busy !== null) {
    return { state };
  }

  // Ctrl+C and Ctrl+Q follow the same dirty/quit protection in every mode.
  if (isCtrlLetter(key, 'c') || isCtrlLetter(key, 'q')) {
    return requestQuit(state);
  }

  if (state.overlay === 'help') {
    if (isF1(key) || isEscape(key)) {
      return { state: { ...state, overlay: 'none', status: '' } };
    }
    if (isF10(key)) {
      return { state: { ...state, overlay: 'menu', menuIndex: 0, status: '' } };
    }
    return { state };
  }

  if (state.overlay === 'menu') {
    if (isF1(key)) {
      return { state: { ...state, overlay: 'help', status: '' } };
    }
    return handleMenuKey(state, key);
  }

  if (state.overlay === 'prompt') {
    return handlePromptKey(state, key);
  }

  if (state.overlay === 'confirm') {
    return handleConfirmKey(state, key);
  }

  if (isF1(key)) {
    return { state: { ...state, overlay: 'help', status: '' } };
  }

  if (isF10(key)) {
    return { state: { ...state, overlay: 'menu', menuIndex: 0, status: '' } };
  }

  if (isEscape(key)) {
    return { state };
  }

  if (isF2(key) || isCtrlLetter(key, 's')) {
    return requestSave(state);
  }
  if (isF3(key) || isCtrlLetter(key, 'o')) {
    return requestOpen(state);
  }
  if (isCtrlLetter(key, 'n')) {
    return requestNew(state);
  }
  if (isCtrlLetter(key, 'f')) {
    return openFindPrompt(state);
  }
  if (isF4(key)) {
    return repeatFind(state);
  }
  if (isCtrlLetter(key, 'z')) {
    return applyEditor(state, { type: 'undo' });
  }
  if (isCtrlLetter(key, 'y')) {
    return applyEditor(state, { type: 'redo' });
  }

  const direction = movementDirection(key);
  if (direction !== undefined) {
    const action: EditorAction =
      pageSize === undefined
        ? { type: 'move', direction }
        : { type: 'move', direction, pageSize };
    return applyEditor(state, action);
  }

  if (isEnter(key)) {
    return applyEditor(state, { type: 'newline' });
  }
  if (isBackspace(key)) {
    return applyEditor(state, { type: 'backspace' });
  }
  if (isDelete(key)) {
    return applyEditor(state, { type: 'delete' });
  }
  if (isTab(key)) {
    return applyEditor(state, { type: 'insert', text: '  ' });
  }

  const text = insertableText(key);
  if (text !== null) {
    return applyEditor(state, { type: 'insert', text });
  }

  return { state };
}

/**
 * Key handling while the terminal is below the 60x16 editing minimum. Ordinary
 * editing is frozen; quitting, Escape cancellation, and Y/N confirmation keep
 * working so the user can always leave or dismiss a dialog.
 */
export function handleSmallTerminalKey(
  state: AppState,
  key: KeyInput,
): KeyResult {
  if (state.busy !== null) {
    return { state };
  }
  if (isCtrlLetter(key, 'c') || isCtrlLetter(key, 'q')) {
    return requestQuit(state);
  }
  if (isEscape(key)) {
    return cancelOverlay(state);
  }
  if (state.overlay === 'confirm') {
    return handleConfirmKey(state, key);
  }
  return { state };
}

/**
 * Finish an adapter-performed open/save effect. Stale or mismatched results
 * are ignored. A no-clobber save that hits an existing file opens the
 * overwrite confirmation instead of reporting a failure.
 */
export function completeEffect(
  state: AppState,
  result: EffectResult,
): KeyResult {
  if (state.busy === null || !sameEffect(state.busy, result.effect)) {
    return { state };
  }

  if (result.ok) {
    if (result.effect.type === 'open') {
      return {
        state: {
          ...state,
          editor: result.editor,
          topLine: 0,
          leftCol: 0,
          status: `Opened ${shortLabel(result.editor.filePath ?? result.effect.path)}`,
          overlay: 'none',
          prompt: null,
          confirm: null,
          busy: null,
          highlight: null,
          lastSearch: null,
        },
      };
    }

    return {
      state: {
        ...state,
        editor: result.editor,
        status: `Saved ${shortLabel(result.editor.filePath ?? result.effect.path)}`,
        overlay: 'none',
        prompt: null,
        confirm: null,
        busy: null,
      },
    };
  }

  if (
    result.effect.type === 'save' &&
    result.effect.overwrite === false &&
    result.error.code === 'EEXIST'
  ) {
    return {
      state: {
        ...state,
        busy: null,
        overlay: 'confirm',
        prompt: null,
        confirm: {
          kind: 'overwrite',
          message: 'Overwrite existing file? Y / N',
          action: { type: 'save', path: result.effect.path },
        },
        status: '',
      },
    };
  }

  return {
    state: {
      ...state,
      busy: null,
      overlay: 'none',
      prompt: null,
      confirm: null,
      status: `${result.effect.type === 'open' ? 'Open' : 'Save'} failed: ${result.error.message}`,
    },
  };
}

function requestSave(state: AppState): KeyResult {
  const filePath = state.editor.filePath;
  if (filePath === null) {
    return { state: openFilePrompt(state, 'saveAs') };
  }
  return beginSave(state, filePath, true);
}

function requestNew(state: AppState): KeyResult {
  if (isDirty(state.editor)) {
    return showDiscard(state, { type: 'new' });
  }
  return { state: newDocument(state) };
}

function requestOpen(state: AppState): KeyResult {
  if (isDirty(state.editor)) {
    return showDiscard(state, { type: 'open' });
  }
  return { state: openFilePrompt(state, 'open') };
}

function requestQuit(state: AppState): KeyResult {
  if (isDirty(state.editor)) {
    return showDiscard(state, { type: 'quit' });
  }
  return {
    state: { ...state, overlay: 'none', prompt: null, confirm: null },
    effect: { type: 'quit' },
  };
}

function showDiscard(state: AppState, action: PendingAction): KeyResult {
  return {
    state: {
      ...state,
      overlay: 'confirm',
      prompt: null,
      confirm: {
        kind: 'discard',
        message: 'Discard unsaved changes? Y / N',
        action,
      },
      status: '',
    },
  };
}

function openFilePrompt(
  state: AppState,
  kind: 'open' | 'saveAs',
  message = '',
): AppState {
  if (kind === 'saveAs' && state.editor.filePath !== null) {
    return {
      ...state,
      overlay: 'prompt',
      prompt: {
        kind,
        value: state.editor.filePath,
        message,
      },
      confirm: null,
      status: '',
    };
  }
  return {
    ...state,
    overlay: 'prompt',
    prompt: { kind, value: '', message },
    confirm: null,
    status: '',
  };
}

function openFindPrompt(state: AppState): KeyResult {
  return {
    state: {
      ...state,
      overlay: 'prompt',
      prompt: { kind: 'find', value: state.lastFind, message: '' },
      confirm: null,
      status: '',
    },
  };
}

function beginOpen(state: AppState, path: string): KeyResult {
  const effect: FileEffect = { type: 'open', path };
  return {
    state: {
      ...state,
      overlay: 'none',
      prompt: null,
      confirm: null,
      busy: effect,
      status: `Opening ${shortLabel(path)}...`,
    },
    effect,
  };
}

function beginSave(
  state: AppState,
  path: string,
  overwrite: boolean,
): KeyResult {
  const effect: FileEffect = { type: 'save', path, overwrite };
  return {
    state: {
      ...state,
      overlay: 'none',
      prompt: null,
      confirm: null,
      busy: effect,
      status: `Saving ${shortLabel(path)}...`,
    },
    effect,
  };
}

function newDocument(state: AppState): AppState {
  return {
    ...state,
    editor: createEditor(),
    topLine: 0,
    leftCol: 0,
    status: 'New file',
    overlay: 'none',
    prompt: null,
    confirm: null,
    highlight: null,
    lastSearch: null,
  };
}

function cancelConfirm(state: AppState): KeyResult {
  const overwrite = state.confirm?.kind === 'overwrite';
  return {
    state: {
      ...state,
      overlay: 'none',
      confirm: null,
      status: overwrite ? 'Save cancelled' : '',
    },
  };
}

function cancelOverlay(state: AppState): KeyResult {
  if (state.overlay === 'none') {
    return { state };
  }
  return {
    state: {
      ...state,
      overlay: 'none',
      prompt: null,
      confirm: null,
      status: '',
    },
  };
}

function handleMenuKey(state: AppState, key: KeyInput): KeyResult {
  if (isEscape(key) || isF10(key)) {
    return { state: { ...state, overlay: 'none', status: '' } };
  }

  const count = MENU_ITEMS.length;
  let menuIndex = normalizeMenuIndex(state.menuIndex);

  if (isKey(key, 'up') || isKey(key, 'left')) {
    menuIndex = (menuIndex - 1 + count) % count;
    return { state: { ...state, menuIndex } };
  }
  if (isKey(key, 'down') || isKey(key, 'right')) {
    menuIndex = (menuIndex + 1) % count;
    return { state: { ...state, menuIndex } };
  }
  if (isKey(key, 'home')) {
    return { state: { ...state, menuIndex: 0 } };
  }
  if (isKey(key, 'end')) {
    return { state: { ...state, menuIndex: count - 1 } };
  }
  if (isEnter(key)) {
    return selectMenuItem(state);
  }

  return { state };
}

function selectMenuItem(state: AppState): KeyResult {
  const item = MENU_ITEMS[normalizeMenuIndex(state.menuIndex)];
  if (item === undefined) {
    return { state: { ...state, overlay: 'none' } };
  }

  switch (item.kind) {
    case 'command':
      return runCommand(state, item.command);
    case 'edit': {
      const action: EditorAction =
        item.edit === 'undo' ? { type: 'undo' } : { type: 'redo' };
      return applyEditor(state, action);
    }
    case 'help':
      return { state: { ...state, overlay: 'help', status: '' } };
    default:
      return { state: { ...state, overlay: 'none' } };
  }
}

function runCommand(state: AppState, command: Command): KeyResult {
  switch (command) {
    case 'new':
      return requestNew(state);
    case 'open':
      return requestOpen(state);
    case 'save':
      return requestSave(state);
    case 'saveAs':
      return { state: openFilePrompt(state, 'saveAs') };
    case 'find':
      return openFindPrompt(state);
    case 'quit':
      return requestQuit(state);
    default:
      return { state };
  }
}

function handlePromptKey(state: AppState, key: KeyInput): KeyResult {
  const prompt = state.prompt;
  if (prompt === null) {
    return { state: { ...state, overlay: 'none' } };
  }

  if (isEscape(key)) {
    return {
      state: { ...state, overlay: 'none', prompt: null, status: '' },
    };
  }

  if (isEnter(key)) {
    if (prompt.kind === 'find') {
      return submitFind(state, prompt.value);
    }
    return submitFilePrompt(state, prompt);
  }

  if (isBackspace(key)) {
    const chars = Array.from(prompt.value);
    if (chars.length === 0) {
      return { state };
    }
    chars.pop();
    return {
      state: {
        ...state,
        prompt: { ...prompt, value: chars.join(''), message: '' },
      },
    };
  }

  const text = insertableText(key);
  if (text !== null) {
    return {
      state: {
        ...state,
        prompt: { ...prompt, value: prompt.value + text, message: '' },
      },
    };
  }

  return { state };
}

function submitFilePrompt(state: AppState, prompt: PromptState): KeyResult {
  if (prompt.value.trim() === '') {
    return {
      state: {
        ...state,
        prompt: { ...prompt, message: 'Enter a file path.' },
      },
    };
  }

  if (prompt.kind === 'open') {
    return beginOpen(state, prompt.value);
  }
  return beginSave(state, prompt.value, false);
}

function submitFind(state: AppState, query: string): KeyResult {
  if (query === '') {
    return {
      state: {
        ...state,
        prompt: {
          kind: 'find',
          value: '',
          message: 'Enter text to find.',
        },
      },
    };
  }

  const from =
    state.lastFind === query && state.lastSearch !== null
      ? { row: state.lastSearch.row, col: state.lastSearch.col + 1 }
      : { ...state.editor.cursor };
  const match = findNext(state.editor.lines, query, from);
  const base: AppState = {
    ...state,
    overlay: 'none',
    prompt: null,
    lastFind: query,
  };

  if (match === null) {
    return {
      state: {
        ...base,
        highlight: null,
        lastSearch: null,
        status: `No match: ${query}`,
      },
    };
  }

  const wrapped = isBefore(match, from);
  return {
    state: {
      ...base,
      editor: cursorAt(state.editor, match),
      highlight: match,
      lastSearch: match,
      status: wrapped
        ? `Found (wrapped) at Ln ${match.row + 1}, Col ${match.col + 1}`
        : `Found at Ln ${match.row + 1}, Col ${match.col + 1}`,
    },
  };
}

function repeatFind(state: AppState): KeyResult {
  if (state.lastFind === '') {
    return openFindPrompt(state);
  }

  const from =
    state.lastSearch === null
      ? { ...state.editor.cursor }
      : { row: state.lastSearch.row, col: state.lastSearch.col + 1 };
  const match = findNext(state.editor.lines, state.lastFind, from);

  if (match === null) {
    return {
      state: {
        ...state,
        highlight: null,
        lastSearch: null,
        status: `No match: ${state.lastFind}`,
      },
    };
  }

  const wrapped = isBefore(match, from);
  return {
    state: {
      ...state,
      editor: cursorAt(state.editor, match),
      highlight: match,
      lastSearch: match,
      status: wrapped
        ? `Found (wrapped) at Ln ${match.row + 1}, Col ${match.col + 1}`
        : `Found at Ln ${match.row + 1}, Col ${match.col + 1}`,
    },
  };
}

function cursorAt(editor: EditorState, match: SearchMatch): EditorState {
  return {
    ...editor,
    cursor: { row: match.row, col: match.col },
    preferredCol: match.col,
  };
}

function isBefore(match: SearchMatch, from: { row: number; col: number }): boolean {
  return match.row < from.row || (match.row === from.row && match.col < from.col);
}

function handleConfirmKey(state: AppState, key: KeyInput): KeyResult {
  const confirm = state.confirm;
  if (confirm === null) {
    return { state: { ...state, overlay: 'none' } };
  }

  if (isPlainLetter(key, 'n') || isEscape(key)) {
    return cancelConfirm(state);
  }

  if (isPlainLetter(key, 'y')) {
    const base: AppState = {
      ...state,
      overlay: 'none',
      confirm: null,
      status: '',
    };

    if (confirm.kind === 'overwrite') {
      if (confirm.action.type !== 'save') {
        return { state: base };
      }
      return beginSave(base, confirm.action.path, true);
    }

    switch (confirm.action.type) {
      case 'new':
        return { state: newDocument(base) };
      case 'open':
        return { state: openFilePrompt(base, 'open') };
      case 'quit':
        return { state: base, effect: { type: 'quit' } };
      default:
        return { state: base };
    }
  }

  // Enter and every other key are ignored: only Y confirms.
  return { state };
}

function applyEditor(state: AppState, action: EditorAction): KeyResult {
  const editor = reduceEditor(state.editor, action);
  const changed = editor !== state.editor;
  const contentEdit =
    action.type === 'insert' ||
    action.type === 'newline' ||
    action.type === 'backspace' ||
    action.type === 'delete' ||
    action.type === 'undo' ||
    action.type === 'redo';

  return {
    state: {
      ...state,
      editor,
      status: '',
      overlay: 'none',
      highlight: changed && contentEdit ? null : state.highlight,
      lastSearch: changed && contentEdit ? null : state.lastSearch,
    },
  };
}

/**
 * Scroll the viewport so the editor cursor is visible. Dimensions below one
 * cell are treated as one cell so callers cannot produce a negative viewport.
 */
export function fitViewport(
  state: AppState,
  visibleRows: number,
  visibleCols: number,
): AppState {
  const rows = normalizeVisible(visibleRows);
  const cols = normalizeVisible(visibleCols);
  const cursor = state.editor.cursor;
  let topLine = normalizeOffset(state.topLine);
  let leftCol = normalizeOffset(state.leftCol);

  if (cursor.row < topLine) {
    topLine = cursor.row;
  } else if (cursor.row >= topLine + rows) {
    topLine = cursor.row - rows + 1;
  }
  topLine = Math.max(0, topLine);

  const line = state.editor.lines[cursor.row] ?? '';
  const cursorDisplay = displayColumns(line.slice(0, cursor.col));
  const leftDisplay = displayColumns(line.slice(0, leftCol));

  if (cursorDisplay < leftDisplay) {
    leftCol = cursor.col;
  } else if (cursorDisplay >= leftDisplay + cols) {
    const target = cursorDisplay - cols + 1;
    let index = leftCol;
    let width = leftDisplay;
    while (index < cursor.col && width < target) {
      width += displayColumns(line[index] ?? '');
      index += 1;
    }
    leftCol = index;
  }
  leftCol = Math.max(0, leftCol);

  if (topLine === state.topLine && leftCol === state.leftCol) {
    return state;
  }

  return { ...state, topLine, leftCol };
}

function sameEffect(busy: FileEffect, result: FileEffect): boolean {
  if (busy.type !== result.type || busy.path !== result.path) {
    return false;
  }
  if (busy.type === 'save' && result.type === 'save') {
    return busy.overwrite === result.overwrite;
  }
  return true;
}

function shortLabel(path: string): string {
  if (path === '') {
    return 'file';
  }
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function movementDirection(key: KeyInput): MoveDirection | undefined {
  switch (key.name?.toLowerCase()) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'up':
      return 'up';
    case 'down':
      return 'down';
    case 'home':
      return 'home';
    case 'end':
      return 'end';
    case 'pageup':
      return 'pageUp';
    case 'pagedown':
      return 'pageDown';
    default:
      return undefined;
  }
}

function insertableText(key: KeyInput): string | null {
  if (key.ctrl === true || key.meta === true) {
    return null;
  }
  const sequence = key.sequence;
  if (sequence === undefined || sequence === '') {
    return null;
  }
  for (const char of sequence) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b || code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      return null;
    }
  }
  return sequence;
}

function isKey(key: KeyInput, name: string): boolean {
  return key.name?.toLowerCase() === name;
}

function isF1(key: KeyInput): boolean {
  return isKey(key, 'f1');
}

function isF2(key: KeyInput): boolean {
  return isKey(key, 'f2');
}

function isF3(key: KeyInput): boolean {
  return isKey(key, 'f3');
}

function isF4(key: KeyInput): boolean {
  return isKey(key, 'f4');
}

function isF10(key: KeyInput): boolean {
  return isKey(key, 'f10');
}

function isEscape(key: KeyInput): boolean {
  return isKey(key, 'escape') || key.sequence === '\u001b';
}

function isEnter(key: KeyInput): boolean {
  return (
    isKey(key, 'return') ||
    isKey(key, 'enter') ||
    key.sequence === '\r' ||
    key.sequence === '\n'
  );
}

function isBackspace(key: KeyInput): boolean {
  return isKey(key, 'backspace');
}

function isDelete(key: KeyInput): boolean {
  return isKey(key, 'delete');
}

function isTab(key: KeyInput): boolean {
  return isKey(key, 'tab') || key.sequence === '\t';
}

function isCtrlLetter(key: KeyInput, letter: string): boolean {
  if (key.ctrl === true && key.name?.toLowerCase() === letter) {
    return true;
  }
  const code = letter.toUpperCase().charCodeAt(0) - 64;
  return key.sequence === String.fromCharCode(code);
}

/** A plain, unmodified letter key, used by Y/N confirmations. */
function isPlainLetter(key: KeyInput, letter: string): boolean {
  if (key.ctrl === true || key.meta === true) {
    return false;
  }
  return (
    key.name?.toLowerCase() === letter ||
    key.sequence?.toLowerCase() === letter
  );
}

function normalizeMenuIndex(index: number): number {
  const count = MENU_ITEMS.length;
  if (!Number.isFinite(index)) {
    return 0;
  }
  const whole = Math.floor(index);
  return ((whole % count) + count) % count;
}

function normalizeVisible(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
}

/** Display columns for viewport purposes; tabs expand to two cells. */
function displayColumns(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char === '\t' ? 2 : 1;
  }
  return width;
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}
