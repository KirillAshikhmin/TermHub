import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FileService } from '../src/files.js';

let base: string;
let root: string;
let svc: FileService;
beforeEach(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'th-upload-security-'));
  root = path.join(base, 'root');
  await fsp.mkdir(root);
  svc = new FileService({ roots: [root] });
});
afterEach(async () => { await fsp.rm(base, { recursive: true, force: true }); });

for (const mode of ['chunk', 'stream']) {
  it(`${mode}: a pre-existing upload temp symlink cannot overwrite an outside file`, async () => {
    const secret = path.join(base, 'secret');
    await fsp.writeFile(secret, 'secret');
    await fsp.symlink(secret, path.join(root, '.new.txt.termhub-part'));
    if (mode === 'chunk') await svc.uploadChunk(root, 'new.txt', Buffer.from('new'), 0, true);
    else await svc.uploadStream(root, 'new.txt', Readable.from(['new']));
    expect(await fsp.readFile(secret, 'utf8')).toBe('secret');
    expect(await fsp.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new');
  });
}

it('requires an active upload and exact sequential offsets, cleaning a failed upload', async () => {
  await expect(svc.uploadChunk(root, 'new.txt', Buffer.from('x'), 1, true)).rejects.toThrow(/upload|offset/i);
  await svc.uploadChunk(root, 'new.txt', Buffer.from('abc'), 0, false);
  await expect(svc.uploadChunk(root, 'new.txt', Buffer.from('x'), 2, true)).rejects.toThrow(/offset/i);
  expect(await fsp.readdir(root)).toEqual([]);
});

it('cleans an interrupted stream', async () => {
  const stream = Readable.from((async function* () { yield 'abc'; throw new Error('interrupted'); })());
  await expect(svc.uploadStream(root, 'new.txt', stream)).rejects.toThrow('interrupted');
  expect(await fsp.readdir(root)).toEqual([]);
});

it('does not replace a destination created while an upload is in progress', async () => {
  await svc.uploadChunk(root, 'new.txt', Buffer.from('abc'), 0, false);
  await fsp.writeFile(path.join(root, 'new.txt'), 'keep');
  await expect(svc.uploadChunk(root, 'new.txt', Buffer.from('d'), 3, true)).rejects.toThrow();
  expect(await fsp.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('keep');
  expect(await fsp.readdir(root)).toEqual(['new.txt']);
});

for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  it(`rejects invalid offset ${offset} without creating a file`, async () => {
    await expect(svc.uploadChunk(root, 'new.txt', Buffer.from('x'), offset, true)).rejects.toThrow(/offset/i);
    expect(await fsp.readdir(root)).toEqual([]);
  });
}

it('cleans abandoned chunk uploads after their idle timeout', async () => {
  vi.useFakeTimers();
  try {
    await svc.uploadChunk(root, 'new.txt', Buffer.from('abc'), 0, false);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  } finally {
    vi.useRealTimers();
  }
  await vi.waitFor(async () => expect(await fsp.readdir(root)).toEqual([]));
  await expect(svc.uploadChunk(root, 'new.txt', Buffer.from('d'), 3, true)).rejects.toThrow(/active upload/i);
});

it('restarts a chunk upload without retaining its previous temporary file', async () => {
  await svc.uploadChunk(root, 'new.txt', Buffer.from('old'), 0, false);
  await svc.uploadChunk(root, 'new.txt', Buffer.from('new'), 0, true);
  expect(await fsp.readFile(path.join(root, 'new.txt'), 'utf8')).toBe('new');
  expect(await fsp.readdir(root)).toEqual(['new.txt']);
});
