/**
 * Validated UTF-8 document loading and failure-safe saving.
 *
 * File access is intentionally isolated from the editor model: loading returns
 * a fresh `EditorState` and saving returns a fresh state whose `savedContent`
 * is the exact serialized text that was persisted. Arguments are never mutated.
 */

import { randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readFile,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  createEditor,
  markSaved,
  serialize,
  type EditorState,
} from './editor.js';

/** The v1 editor is a small-text editor, not a large-file editor. */
export const MAX_FILE_BYTES = 1024 * 1024;

export type FileErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'EACCES'
  | 'EPERM'
  | 'EISDIR'
  | 'ENOTFILE'
  | 'ESYMLINK'
  | 'ETOOLARGE'
  | 'ENUL'
  | 'EINVALIDUTF8'
  | 'ESURROGATE'
  | 'ENOSPC'
  | 'EIO';

/**
 * A user-displayable filesystem error. `code` uses standard filesystem codes
 * where they apply; `EEXIST` specifically means a no-clobber destination
 * already existed.
 */
export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly filePath: string;

  constructor(code: FileErrorCode, filePath: string, message: string) {
    super(message);
    this.name = 'FileError';
    this.code = code;
    this.filePath = filePath;
  }
}

const UTF8_DECODER = new TextDecoder('utf-8', {
  fatal: true,
  // Keep a leading U+FEFF in the decoded string so the editor can record it
  // as BOM metadata instead of silently dropping it.
  ignoreBOM: true,
});

/**
 * Load an existing regular UTF-8 file. The returned state stores the absolute
 * resolved path. Nonexistent, nonregular, NUL-containing, invalid UTF-8, and
 * larger-than-1-MiB files are rejected with a `FileError`.
 */
export async function openDocument(filePath: string): Promise<EditorState> {
  const absolute = resolve(filePath);

  let metadata;
  try {
    metadata = await lstat(absolute);
  } catch (error) {
    throw mapFilesystemError(error, absolute, 'open');
  }

  if (metadata.isSymbolicLink()) {
    throw new FileError(
      'ESYMLINK',
      absolute,
      `Symbolic links are not supported: ${absolute}`,
    );
  }
  if (!metadata.isFile()) {
    throw new FileError(
      metadata.isDirectory() ? 'EISDIR' : 'ENOTFILE',
      absolute,
      `Not a regular file: ${absolute}`,
    );
  }
  if (metadata.size > MAX_FILE_BYTES) {
    throw tooLargeError(absolute);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw mapFilesystemError(error, absolute, 'open');
  }

  // Metadata can be stale; enforce the limit against the bytes actually read.
  if (bytes.byteLength > MAX_FILE_BYTES) {
    throw tooLargeError(absolute);
  }
  if (bytes.includes(0)) {
    throw new FileError(
      'ENUL',
      absolute,
      `File contains NUL bytes and cannot be edited: ${absolute}`,
    );
  }

  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new FileError(
      'EINVALIDUTF8',
      absolute,
      `File is not valid UTF-8: ${absolute}`,
    );
  }

  return createEditor(text, absolute);
}

/**
 * Persist an editor as UTF-8 text.
 *
 * The bytes are first written to an exclusive temporary sibling. The finished
 * temporary file is then installed with an atomic rename when `overwrite` is
 * true, or with a no-clobber hard link when it is false. A failed write or
 * install leaves the destination untouched. The returned state only becomes
 * clean after the install succeeds; the original object is never changed.
 */
export async function saveDocument(
  editor: EditorState,
  filePath: string,
  overwrite: boolean,
): Promise<EditorState> {
  const absolute = resolve(filePath);
  const text = serialize(editor);

  if (hasUnpairedSurrogate(text)) {
    throw new FileError(
      'ESURROGATE',
      absolute,
      'Cannot save text containing unpaired Unicode surrogates.',
    );
  }

  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > MAX_FILE_BYTES) {
    throw tooLargeError(absolute);
  }
  const bytes = Buffer.from(text, 'utf8');

  const destination = await destinationKind(absolute);
  if (destination === 'symlink') {
    throw new FileError(
      'ESYMLINK',
      absolute,
      `Symbolic links are not supported: ${absolute}`,
    );
  }
  if (destination === 'other') {
    throw new FileError(
      'ENOTFILE',
      absolute,
      `Not a regular file: ${absolute}`,
    );
  }
  if (destination === 'file' && !overwrite) {
    throw new FileError(
      'EEXIST',
      absolute,
      `File already exists: ${absolute}`,
    );
  }

  const directory = dirname(absolute);
  const temporary = await createTemporaryFile(directory, absolute);

  try {
    let writeFailure: unknown;
    try {
      await temporary.handle.writeFile(bytes);
    } catch (error) {
      writeFailure = error;
    }
    try {
      await temporary.handle.close();
    } catch (error) {
      if (writeFailure === undefined) {
        writeFailure = error;
      }
    }
    if (writeFailure !== undefined) {
      throw mapFilesystemError(writeFailure, absolute, 'save', directory);
    }

    try {
      if (overwrite) {
        await rename(temporary.path, absolute);
      } else {
        // A hard link is a no-clobber install: if the destination appeared
        // concurrently, this fails with EEXIST instead of replacing it.
        await link(temporary.path, absolute);
        await unlink(temporary.path).catch(() => undefined);
      }
    } catch (error) {
      throw mapFilesystemError(error, absolute, 'save', directory);
    }
  } catch (error) {
    // Only this call's uniquely named temporary file is removed.
    await unlink(temporary.path).catch(() => undefined);
    throw error instanceof FileError
      ? error
      : mapFilesystemError(error, absolute, 'save', directory);
  }

  return markSaved(editor, absolute);
}

async function destinationKind(
  absolute: string,
): Promise<'absent' | 'file' | 'symlink' | 'other'> {
  try {
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) {
      return 'symlink';
    }
    return metadata.isFile() ? 'file' : 'other';
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return 'absent';
    }
    throw mapFilesystemError(error, absolute, 'save');
  }
}

async function createTemporaryFile(
  directory: string,
  absolute: string,
): Promise<{ path: string; handle: FileHandle }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const name = `.pascal-desk-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
    const path = join(directory, name);
    try {
      const handle = await open(path, 'wx', 0o666);
      return { path, handle };
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        continue;
      }
      throw mapFilesystemError(error, absolute, 'save', directory);
    }
  }

  throw new FileError(
    'EIO',
    absolute,
    `Could not create a temporary file in ${directory}.`,
  );
}

function tooLargeError(absolute: string): FileError {
  return new FileError(
    'ETOOLARGE',
    absolute,
    `File is too large (limit 1 MiB): ${absolute}`,
  );
}

function mapFilesystemError(
  error: unknown,
  absolute: string,
  action: 'open' | 'save',
  directory?: string,
): FileError {
  if (error instanceof FileError) {
    return error;
  }

  const code = errorCode(error);
  switch (code) {
    case 'ENOENT':
      return new FileError(
        'ENOENT',
        absolute,
        action === 'open'
          ? `File not found: ${absolute}`
          : `Cannot save: folder does not exist: ${directory ?? dirname(absolute)}`,
      );
    case 'EACCES':
    case 'EPERM':
      return new FileError(
        code,
        absolute,
        `Permission denied: ${absolute}`,
      );
    case 'EEXIST':
      return new FileError(
        'EEXIST',
        absolute,
        `File already exists: ${absolute}`,
      );
    case 'EISDIR':
    case 'ENOTDIR':
      return new FileError(
        'EISDIR',
        absolute,
        `Not a regular file: ${absolute}`,
      );
    case 'ENOSPC':
      return new FileError(
        'ENOSPC',
        absolute,
        `No space left while saving: ${absolute}`,
      );
    default:
      return new FileError(
        'EIO',
        absolute,
        action === 'open'
          ? `Could not open file: ${absolute}`
          : `Could not save file: ${absolute}`,
      );
  }
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function isErrno(error: unknown, expected: string): boolean {
  return errorCode(error) === expected;
}
