import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createEditor, isDirty, reduceEditor, serialize } from '../src/editor.js';
import { openDocument, saveDocument } from '../src/files.js';

async function fixture(body: (directory: string) => Promise<void>): Promise<void> {
  const root = resolve('.dsh-runs');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'reviewer-phase3-files-'));
  try { await body(directory); }
  finally {
    assert.equal(directory.startsWith(root + '\\') || directory.startsWith(root + '/'), true);
    await rm(directory, { recursive: true, force: true });
  }
}

test('reviewer: BOM, CRLF, trailing newline and Unicode survive open/save without becoming editable BOM text', async () => {
  await fixture(async directory => {
    const source = join(directory, 'source with spaces.pas');
    const destination = join(directory, 'copy with spaces.pas');
    const bytes = Buffer.from('\ufeffprogram 漢😀;\r\nbegin\r\nend.\r\n');
    await writeFile(source, bytes);
    const loaded = await openDocument(source);
    assert.equal(loaded.bom, true);
    assert.equal(loaded.lines[0], 'program 漢😀;');
    assert.equal(loaded.eol, '\r\n');
    assert.deepEqual(loaded.cursor, { row: 0, col: 0 });
    assert.equal(loaded.filePath, resolve(source));
    assert.equal(isDirty(loaded), false);
    const snapshot = JSON.stringify(loaded);
    const saved = await saveDocument(loaded, destination, false);
    assert.deepEqual(await readFile(destination), bytes);
    assert.equal(JSON.stringify(loaded), snapshot, 'saving must not mutate its input');
    assert.equal(saved.filePath, resolve(destination));
    assert.equal(isDirty(saved), false);
    assert.deepEqual((await readdir(directory)).sort(), ['copy with spaces.pas', 'source with spaces.pas']);
  });
});

test('reviewer: save preserves undo history and only establishes the baseline after success', async () => {
  await fixture(async directory => {
    const path = join(directory, 'history.pas');
    const edited = reduceEditor(createEditor('begin\nend.'), { type: 'insert', text: '// note\n' });
    const before = JSON.stringify(edited);
    const saved = await saveDocument(edited, path, false);
    assert.equal(JSON.stringify(edited), before);
    assert.equal(isDirty(edited), true);
    assert.deepEqual(saved.undoStack, edited.undoStack);
    assert.equal(isDirty(saved), false);
    const undone = reduceEditor(saved, { type: 'undo' });
    assert.equal(isDirty(undone), true);
    assert.equal(undone.filePath, resolve(path));
    assert.equal(isDirty(reduceEditor(undone, { type: 'redo' })), false);
    assert.equal((await readFile(path)).toString('utf8'), serialize(edited));
  });
});

test('reviewer: concurrent no-clobber saves have exactly one winner and leave no temporary siblings', async () => {
  await fixture(async directory => {
    const path = join(directory, 'race.pas');
    const versions = [createEditor('winner A\n'), createEditor('winner B\n')];
    const results = await Promise.allSettled(versions.map(editor => saveDocument(editor, path, false)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex(result => result.status === 'fulfilled');
    const loser = results.find(result => result.status === 'rejected');
    assert.ok(loser && loser.status === 'rejected');
    assert.equal((loser.reason as { code?: string }).code, 'EEXIST');
    assert.equal(await readFile(path, 'utf8'), serialize(versions[winner]!));
    assert.deepEqual(await readdir(directory), ['race.pas']);
  });
});

test('reviewer: existing destination is preserved until overwrite is explicitly authorized', async () => {
  await fixture(async directory => {
    const path = join(directory, 'existing.pas');
    await writeFile(path, 'original');
    const edited = reduceEditor(createEditor('original'), { type: 'insert', text: 'changed ' });
    const before = JSON.stringify(edited);
    await assert.rejects(saveDocument(edited, path, false), { code: 'EEXIST' });
    assert.equal(await readFile(path, 'utf8'), 'original');
    assert.equal(JSON.stringify(edited), before);
    assert.equal(isDirty(edited), true);
    await saveDocument(edited, path, true);
    assert.equal(await readFile(path, 'utf8'), 'changed original');
    assert.deepEqual(await readdir(directory), ['existing.pas']);
  });
});

test('reviewer: invalid UTF-8, NUL, non-files and missing inputs are rejected without changing bytes', async () => {
  await fixture(async directory => {
    for (const [name, bytes] of [
      ['invalid.pas', Buffer.from([0xc0, 0xaf])],
      ['nul.pas', Buffer.from('before\0after')],
    ] as const) {
      const path = join(directory, name);
      await writeFile(path, bytes);
      await assert.rejects(openDocument(path));
      assert.deepEqual(await readFile(path), bytes);
    }
    await assert.rejects(openDocument(directory));
    await assert.rejects(openDocument(join(directory, 'missing.pas')));
  });
});

test('reviewer: byte-based limits and malformed output refuse saves without destroying destination', async () => {
  await fixture(async directory => {
    const destination = join(directory, 'keep.pas');
    await writeFile(destination, 'keep me');
    const tooLarge = createEditor('漢'.repeat(350_000));
    assert.ok(Buffer.byteLength(serialize(tooLarge), 'utf8') > 1024 * 1024);
    await assert.rejects(saveDocument(tooLarge, destination, true));
    await assert.rejects(saveDocument(createEditor('unpaired\ud800'), destination, true));
    assert.equal(await readFile(destination, 'utf8'), 'keep me');
    const hugeSource = join(directory, 'huge.pas');
    await writeFile(hugeSource, Buffer.alloc(1024 * 1024 + 1, 0x61));
    await assert.rejects(openDocument(hugeSource));
    await assert.rejects(saveDocument(createEditor('new'), join(directory, 'absent', 'out.pas'), false));
    assert.deepEqual((await readdir(directory)).sort(), ['huge.pas', 'keep.pas']);
  });
});

test('reviewer: failure while closing the completed temporary file must not replace the destination', async () => {
  await fixture(async directory => {
    const path = join(directory, 'preserved.pas');
    await writeFile(path, 'original bytes');
    const originalOpen = filesystem.open;
    let injected = false;
    filesystem.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).startsWith(directory) && args[1] === 'wx') {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          await originalClose();
          injected = true;
          throw Object.assign(new Error('reviewer simulated close I/O failure'), { code: 'EIO' });
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(saveDocument(createEditor('replacement'), path, true), /I\/O|close|save/i);
      assert.equal(injected, true, 'fault must exercise the real temporary handle');
      assert.equal(await readFile(path, 'utf8'), 'original bytes');
      assert.deepEqual(await readdir(directory), ['preserved.pas']);
    } finally {
      filesystem.open = originalOpen;
      syncBuiltinESMExports();
    }
  });
});
