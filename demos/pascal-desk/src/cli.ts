/**
 * Thin Node terminal adapter for Pascal Desk.
 *
 * The module is import-safe: alternate screen, raw mode, keypress handling, and
 * signal handlers are only installed when the executable entry point runs, and
 * only for an interactive TTY. Cleanup restores the terminal exactly once.
 */

import { resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  createApp,
  completeEffect,
  handleKey,
  handleSmallTerminalKey,
  type AppState,
  type Effect,
  type EffectResult,
  type KeyInput,
} from './app.js';
import {
  FileError,
  openDocument,
  saveDocument,
} from './files.js';
import { createEditor, type EditorState } from './editor.js';
import { editorAreaSize, renderScreen } from './render.js';

const ENTER_ALTERNATE_SCREEN = '\x1b[?1049h';
const LEAVE_ALTERNATE_SCREEN = '\x1b[?1049l';
const SHOW_CURSOR = '\x1b[?25h';
const HIDE_CURSOR = '\x1b[?25l';
const CURSOR_HOME = '\x1b[H';
const CLEAR_SCREEN = '\x1b[2J';
const RESET = '\x1b[0m';

const MIN_COLUMNS = 60;
const MIN_ROWS = 16;

const USAGE = 'Usage: pascal-desk [--help] [file.pas]';
const HELP_TEXT = `${USAGE}

Pascal Desk is a small Turbo Pascal inspired terminal editor.
It edits ordinary UTF-8 text; it does not compile, run, or debug programs.

Options:
  -h, --help   Show this help and exit.

File argument:
  Open one existing UTF-8 file (LF or CRLF, up to 1 MiB).
  Run "npm run demo" to open the bundled example.

Shortcuts:
  F1 Help        F2/Ctrl+S Save     F3/Ctrl+O Open
  F4 Find Next   F10 Menu           Ctrl+N New
  Ctrl+F Find    Ctrl+Z Undo        Ctrl+Y Redo
  Ctrl+Q Quit    Escape Cancel

Dirty documents ask before New/Open/Quit discard changes.
Save As asks before overwriting an existing file.
`;

export interface CliIO {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  error: NodeJS.WriteStream;
}

interface NodeKeypress {
  sequence?: string;
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Parse arguments and either print help, report startup errors, or run the TUI. */
export async function main(
  argv: string[] = process.argv.slice(2),
  io: Partial<CliIO> = {},
): Promise<number> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const error = io.error ?? process.stderr;

  if (argv.includes('--help') || argv.includes('-h')) {
    output.write(HELP_TEXT);
    return 0;
  }

  let filePath: string | undefined;
  for (const argument of argv) {
    if (argument.startsWith('-')) {
      error.write(
        diagnosticText(`pascal-desk: unknown flag "${argument}"\n\n${USAGE}\n`),
      );
      return 1;
    }
    if (filePath !== undefined) {
      error.write(
        diagnosticText(`pascal-desk: expected at most one file path\n\n${USAGE}\n`),
      );
      return 1;
    }
    filePath = argument;
  }

  let initialEditor: EditorState | undefined;
  if (filePath !== undefined) {
    try {
      initialEditor = await openDocument(filePath);
    } catch (failure) {
      error.write(diagnosticText(`pascal-desk: ${errorMessage(failure)}\n`));
      return 1;
    }
  }

  if (input.isTTY !== true || output.isTTY !== true) {
    error.write(
      'pascal-desk: requires a TTY for interactive use (stdin and stdout must be terminals).\n' +
        'Run with --help for usage.\n',
    );
    return 1;
  }

  return runTerminal(input, output, initialEditor);
}

/** Run the interactive loop. Exported for adapters and focused tests. */
export function runTerminal(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
  initialEditor?: EditorState,
): Promise<number> {
  return new Promise<number>((resolvePromise) => {
    let state: AppState = createApp(initialEditor ?? createEditor());
    let cleanedUp = false;
    let rawEnabled = false;
    let alternateScreen = false;
    let operationRunning = false;

    function cleanup(code: number): void {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;

      input.removeListener('keypress', onKeypress);
      input.removeListener('end', onEnd);
      input.removeListener('error', onError);
      output.removeListener('resize', onResize);
      output.removeListener('error', onError);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);

      if (rawEnabled && typeof input.setRawMode === 'function') {
        try {
          input.setRawMode(false);
        } catch {
          // Best effort: the terminal may already be gone.
        }
      }
      rawEnabled = false;

      input.pause();
      const leave = alternateScreen
        ? `${RESET}${SHOW_CURSOR}${LEAVE_ALTERNATE_SCREEN}`
        : SHOW_CURSOR;
      alternateScreen = false;
      try {
        output.write(leave);
      } catch {
        // The terminal may already be gone; cleanup must still resolve.
      }
      resolvePromise(code);
    }

    function fail(error: unknown): void {
      if (cleanedUp) {
        return;
      }
      cleanup(1);
      try {
        output.write(
          diagnosticText(`\npascal-desk: ${errorMessage(error)}\n`),
        );
      } catch {
        // Nothing else can be reported.
      }
    }

    function draw(): void {
      const columns = terminalColumns(output);
      const rows = terminalRows(output);
      const frame = renderScreen(state, columns, rows);
      let chunk = `${CURSOR_HOME}${frame.output}`;
      if (frame.cursor === null) {
        chunk += HIDE_CURSOR;
      } else {
        chunk += `\x1b[${frame.cursor.row};${frame.cursor.col}H${SHOW_CURSOR}`;
      }
      output.write(chunk);
    }

    function isSmallTerminal(): boolean {
      return (
        terminalColumns(output) < MIN_COLUMNS ||
        terminalRows(output) < MIN_ROWS
      );
    }

    function handleEffect(effect: Effect): void {
      if (cleanedUp) {
        return;
      }
      if (effect.type === 'quit') {
        cleanup(0);
        return;
      }
      if (operationRunning) {
        return;
      }

      operationRunning = true;
      const editorAtStart = state.editor;
      void (async () => {
        let result: EffectResult;
        try {
          if (effect.type === 'open') {
            const editor = await openDocument(effect.path);
            result = { effect, ok: true, editor };
          } else {
            const editor = await saveDocument(
              editorAtStart,
              effect.path,
              effect.overwrite,
            );
            result = { effect, ok: true, editor };
          }
        } catch (failure) {
          result = { effect, ok: false, error: toEffectFailure(failure) };
        }

        if (cleanedUp) {
          operationRunning = false;
          return;
        }

        try {
          const completion = completeEffect(state, result);
          state = completion.state;
          operationRunning = false;
          if (completion.effect !== undefined) {
            handleEffect(completion.effect);
          } else {
            draw();
          }
        } catch (failure) {
          operationRunning = false;
          fail(failure);
        }
      })();
    }

    function onKeypress(
      sequence: string | undefined,
      key: NodeKeypress | undefined,
    ): void {
      if (cleanedUp) {
        return;
      }
      try {
        const columns = terminalColumns(output);
        const rows = terminalRows(output);
        const inputKey = toKeyInput(sequence, key);
        const result = isSmallTerminal()
          ? handleSmallTerminalKey(state, inputKey)
          : handleKey(
              state,
              inputKey,
              editorAreaSize(columns, rows).rows,
            );
        state = result.state;
        if (result.effect !== undefined) {
          if (result.effect.type === 'quit') {
            cleanup(0);
            return;
          }
          draw();
          handleEffect(result.effect);
          return;
        }
        draw();
      } catch (error) {
        fail(error);
      }
    }

    function onResize(): void {
      if (cleanedUp) {
        return;
      }
      try {
        output.write(CLEAR_SCREEN);
        draw();
      } catch (error) {
        fail(error);
      }
    }

    function onEnd(): void {
      cleanup(0);
    }

    function onError(error: Error): void {
      fail(error);
    }

    function onSignal(): void {
      cleanup(0);
    }

    try {
      emitKeypressEvents(input);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(true);
        rawEnabled = true;
      }
      input.on('keypress', onKeypress);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('resize', onResize);
      output.on('error', onError);
      process.on('SIGINT', onSignal);
      process.on('SIGTERM', onSignal);
      input.resume();

      alternateScreen = true;
      output.write(`${ENTER_ALTERNATE_SCREEN}${CLEAR_SCREEN}${CURSOR_HOME}`);
      draw();
    } catch (error) {
      fail(error);
    }
  });
}

function toEffectFailure(error: unknown): { code?: string; message: string } {
  if (error instanceof FileError) {
    return { code: error.code, message: error.message };
  }
  return { message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Escape terminal control bytes in diagnostics. Newlines are retained for
 * multi-line usage text; every other control character becomes visible text.
 */
function diagnosticText(text: string): string {
  let output = '';
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n') {
      output += '\n';
    } else if (char === '\t') {
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

function toKeyInput(
  sequence: string | undefined,
  key: NodeKeypress | undefined,
): KeyInput {
  const input: KeyInput = {};
  if (key !== undefined && key.name !== undefined) {
    input.name = key.name;
  }
  const seq = key?.sequence ?? sequence;
  if (seq !== undefined) {
    input.sequence = seq;
  }
  if (key?.ctrl === true) {
    input.ctrl = true;
  }
  if (key?.meta === true) {
    input.meta = true;
  }
  if (key?.shift === true) {
    input.shift = true;
  }
  return input;
}

function terminalColumns(output: NodeJS.WriteStream): number {
  const columns = output.columns;
  if (typeof columns === 'number' && Number.isFinite(columns) && columns > 0) {
    return Math.floor(columns);
  }
  return 80;
}

function terminalRows(output: NodeJS.WriteStream): number {
  const rows = output.rows;
  if (typeof rows === 'number' && Number.isFinite(rows) && rows > 0) {
    return Math.floor(rows);
  }
  return 24;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined) {
  const modulePath = fileURLToPath(import.meta.url);
  if (resolve(invokedPath) === resolve(modulePath)) {
    void main()
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error: unknown) => {
        process.stderr.write(
          diagnosticText(`pascal-desk: ${errorMessage(error)}\n`),
        );
        process.exitCode = 1;
      });
  }
}
