import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FileError,
  MAX_FILE_BYTES,
  openDocument,
  saveDocument,
} from '../src/files.js';
import {
  createEditor,
  isDirty,
  reduceEditor,
  serialize,
} from '../src/editor.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RUNS = join(ROOT, '.dsh-runs');

function temporaryDirectory(): string {
  mkdirSync(RUNS, { recursive: true });
  return mkdtempSync(join(RUNS, 'test-files-'));
}

function cleanup(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

async function expectFileError(
  promise: Promise<unknown>,
  code: string,
): Promise<FileError> {
  let captured: unknown;
  try {
    await promise;
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof FileError, `expected FileError, got ${String(captured)}`);
  assert.equal(captured.code, code);
  return captured;
}

function temporaryFiles(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.tmp'));
}

test('open and save round-trip BOM, CRLF, Unicode, and trailing newline', async () => {
  const directory = temporaryDirectory();
  try {
    const sourceText = '\uFEFFprogram Demo;\r\n{writeln(\'bêta 世界\')}\r\n';
    const sourcePath = join(directory, 'source file.pas');
    const destination = join(directory, 'saved file.pas');
    const sourceBytes = Buffer.from(sourceText, 'utf8');
    writeFileSync(sourcePath, sourceBytes);

    const editor = await openDocument(sourcePath);
    assert.equal(editor.filePath, resolve(sourcePath));
    assert.equal(editor.bom, true);
    assert.equal(editor.eol, '\r\n');
    assert.deepEqual(editor.lines, [
      'program Demo;',
      "{writeln('bêta 世界')}",
      '',
    ]);
    assert.equal(serialize(editor), sourceText);
    assert.equal(isDirty(editor), false);
    assert.equal(editor.undoStack.length, 0);

    const beforePath = editor.filePath;
    const beforeSaved = editor.savedContent;
    const saved = await saveDocument(editor, destination, false);

    assert.equal(saved.filePath, resolve(destination));
    assert.equal(saved.bom, true);
    assert.equal(saved.eol, '\r\n');
    assert.equal(isDirty(saved), false);
    assert.deepEqual(readFileSync(destination), sourceBytes);

    // The argument editor is untouched.
    assert.equal(editor.filePath, beforePath);
    assert.equal(editor.savedContent, beforeSaved);

    const reopened = await openDocument(destination);
    assert.equal(serialize(reopened), sourceText);
    assert.equal(reopened.bom, true);
    assert.equal(reopened.eol, '\r\n');
    assert.equal(temporaryFiles(directory).length, 0);
  } finally {
    cleanup(directory);
  }
});

test('save writes UTF-8 LF content without adding a BOM', async () => {
  const directory = temporaryDirectory();
  try {
    const editor = createEditor('line one\nline two\n');
    const destination = join(directory, 'lf file.pas');
    const saved = await saveDocument(editor, destination, false);

    assert.equal(saved.bom, false);
    assert.equal(saved.eol, '\n');
    assert.equal(serialize(saved), 'line one\nline two\n');
    assert.deepEqual(
      readFileSync(destination),
      Buffer.from('line one\nline two\n', 'utf8'),
    );
    assert.equal(isDirty(saved), false);
  } finally {
    cleanup(directory);
  }
});

test('save and open accept paths containing spaces', async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, 'folder with spaces', 'my notes.pas');
    mkdirSync(join(directory, 'folder with spaces'));
    const editor = createEditor('spaces are fine');
    const saved = await saveDocument(editor, path, false);

    assert.equal(saved.filePath, resolve(path));
    assert.deepEqual(
      readFileSync(path),
      Buffer.from('spaces are fine', 'utf8'),
    );

    const opened = await openDocument(path);
    assert.equal(opened.filePath, resolve(path));
    assert.equal(serialize(opened), 'spaces are fine');
  } finally {
    cleanup(directory);
  }
});

test('open rejects a nonexistent file and preserves a clear code', async () => {
  const directory = temporaryDirectory();
  try {
    const missing = join(directory, 'missing.pas');
    const error = await expectFileError(openDocument(missing), 'ENOENT');
    assert.match(error.message, /File not found/);
  } finally {
    cleanup(directory);
  }
});

test('open rejects directories and other nonregular files', async () => {
  const directory = temporaryDirectory();
  try {
    const error = await expectFileError(openDocument(directory), 'EISDIR');
    assert.match(error.message, /Not a regular file/);
  } finally {
    cleanup(directory);
  }
});

test('open rejects invalid UTF-8 without replacing bytes', async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, 'invalid.pas');
    const bytes = Buffer.from([0x70, 0x72, 0x6f, 0x67, 0xff, 0xfe, 0x0a]);
    writeFileSync(path, bytes);

    const error = await expectFileError(openDocument(path), 'EINVALIDUTF8');
    assert.match(error.message, /not valid UTF-8/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    cleanup(directory);
  }
});

test('open rejects NUL-containing files', async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, 'nul.pas');
    const bytes = Buffer.from('program\u0000Demo;', 'utf8');
    writeFileSync(path, bytes);

    const error = await expectFileError(openDocument(path), 'ENUL');
    assert.match(error.message, /NUL/);
    assert.deepEqual(readFileSync(path), bytes);
  } finally {
    cleanup(directory);
  }
});

test('open and save enforce the 1 MiB limit', async () => {
  const directory = temporaryDirectory();
  try {
    const exact = join(directory, 'exact.pas');
    writeFileSync(exact, Buffer.alloc(MAX_FILE_BYTES, 0x61));
    const loaded = await openDocument(exact);
    assert.equal(loaded.lines[0]?.length, MAX_FILE_BYTES);

    const tooLarge = join(directory, 'too-large.pas');
    writeFileSync(tooLarge, Buffer.alloc(MAX_FILE_BYTES + 1, 0x61));
    await expectFileError(openDocument(tooLarge), 'ETOOLARGE');

    const largeEditor = createEditor('x'.repeat(MAX_FILE_BYTES + 1));
    await expectFileError(
      saveDocument(largeEditor, join(directory, 'large-output.pas'), false),
      'ETOOLARGE',
    );

    const exactEditor = createEditor('x'.repeat(MAX_FILE_BYTES));
    const saved = await saveDocument(
      exactEditor,
      join(directory, 'exact-output.pas'),
      false,
    );
    assert.equal(isDirty(saved), false);
  } finally {
    cleanup(directory);
  }
});

test('no-clobber save rejects an existing destination and leaves it untouched', async () => {
  const directory = temporaryDirectory();
  try {
    const destination = join(directory, 'existing.pas');
    const original = Buffer.from('original content\n', 'utf8');
    writeFileSync(destination, original);

    const editor = createEditor('replacement');
    const error = await expectFileError(
      saveDocument(editor, destination, false),
      'EEXIST',
    );
    assert.match(error.message, /already exists/);
    assert.deepEqual(readFileSync(destination), original);
    assert.equal(temporaryFiles(directory).length, 0);
  } finally {
    cleanup(directory);
  }
});

test('overwrite save replaces a regular destination only after a successful write', async () => {
  const directory = temporaryDirectory();
  try {
    const destination = join(directory, 'replace.pas');
    writeFileSync(destination, 'old');

    const editor = createEditor('new content');
    const saved = await saveDocument(editor, destination, true);

    assert.equal(readFileSync(destination, 'utf8'), 'new content');
    assert.equal(saved.filePath, resolve(destination));
    assert.equal(isDirty(saved), false);
    assert.equal(temporaryFiles(directory).length, 0);
  } finally {
    cleanup(directory);
  }
});

test('failed saves preserve existing destinations and do not mutate the editor', async () => {
  const directory = temporaryDirectory();
  try {
    const directoryDestination = join(directory, 'a folder');
    mkdirSync(directoryDestination);

    let editor = createEditor('original', 'C:/original.pas');
    editor = reduceEditor(editor, { type: 'insert', text: '!' });
    assert.equal(isDirty(editor), true);
    const before = {
      filePath: editor.filePath,
      savedContent: editor.savedContent,
      lines: editor.lines.slice(),
      cursor: { ...editor.cursor },
      undoStack: editor.undoStack.length,
    };

    await expectFileError(
      saveDocument(editor, directoryDestination, true),
      'ENOTFILE',
    );
    assert.equal(readdirSync(directoryDestination).length, 0);

    const missingParent = join(directory, 'missing', 'file.pas');
    const missingError = await expectFileError(
      saveDocument(editor, missingParent, false),
      'ENOENT',
    );
    assert.match(missingError.message, /folder does not exist/);

    assert.equal(editor.filePath, before.filePath);
    assert.equal(editor.savedContent, before.savedContent);
    assert.deepEqual(editor.lines, before.lines);
    assert.deepEqual(editor.cursor, before.cursor);
    assert.equal(editor.undoStack.length, before.undoStack);
    assert.equal(temporaryFiles(directory).length, 0);
  } finally {
    cleanup(directory);
  }
});

test('save rejects unpaired surrogates instead of encoding replacement characters', async () => {
  const directory = temporaryDirectory();
  try {
    const destination = join(directory, 'surrogate.pas');
    writeFileSync(destination, 'safe');
    const editor = createEditor(`ok\uD800bad`);

    const error = await expectFileError(
      saveDocument(editor, destination, true),
      'ESURROGATE',
    );
    assert.match(error.message, /unpaired Unicode surrogates/);
    assert.equal(readFileSync(destination, 'utf8'), 'safe');
    assert.equal(temporaryFiles(directory).length, 0);
  } finally {
    cleanup(directory);
  }
});

test('opening normalizes mixed line endings to the first convention in memory', async () => {
  const directory = temporaryDirectory();
  try {
    const path = join(directory, 'mixed.pas');
    await writeFile(path, 'a\r\nb\nc\rd', 'utf8');

    const editor = await openDocument(path);
    assert.equal(editor.eol, '\r\n');
    assert.deepEqual(editor.lines, ['a', 'b', 'c', 'd']);
    assert.equal(serialize(editor), 'a\r\nb\r\nc\r\nd');
  } finally {
    cleanup(directory);
  }
});
