// FileService: файловые операции (statFull/copy/move/remove) + безопасность.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FileService, runFileOp } from '../src/files.js';

let root = '';
let svc: FileService;

beforeAll(async () => {
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'th-fop-')));
  await fsp.writeFile(path.join(root, 'a.txt'), 'hello');
  await fsp.mkdir(path.join(root, 'sub'));
  svc = new FileService({ roots: [root] });
});

afterAll(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('FileService — операции', () => {
  it('statFull: метаданные файла', async () => {
    const info = await svc.statFull(root, 'a.txt');
    expect(info.name).toBe('a.txt');
    expect(info.kind).toBe('file');
    expect(info.size).toBe(5);
    expect(info.mode).toMatch(/^[rwx-]{9}$/);
    expect(info.mtime).toBeGreaterThan(0);
  });

  it('copy: копирует, исходник остаётся', async () => {
    await svc.copy(root, 'a.txt', root, 'sub/a.txt');
    expect((await svc.statFull(root, 'sub/a.txt')).size).toBe(5);
    expect((await svc.statFull(root, 'a.txt')).size).toBe(5);
  });

  it('move: перемещает/переименовывает', async () => {
    await svc.move(root, 'a.txt', root, 'b.txt');
    await expect(svc.statFull(root, 'a.txt')).rejects.toThrow();
    expect((await svc.statFull(root, 'b.txt')).name).toBe('b.txt');
  });

  it('remove: удаляет файл', async () => {
    await svc.remove(root, 'b.txt');
    await expect(svc.statFull(root, 'b.txt')).rejects.toThrow();
  });

  it('нельзя удалить корень', async () => {
    await expect(svc.remove(root, '')).rejects.toThrow(/root/i);
  });

  it('анти-побег: назначение вне корня отклоняется', async () => {
    await svc.copy(root, 'sub/a.txt', root, 'c.txt');
    await expect(svc.move(root, 'c.txt', root, '../evil.txt')).rejects.toThrow();
  });

  it('runFileOp диспетчеризует действия', async () => {
    const info = (await runFileOp(svc, { action: 'stat-full', root, path: 'sub/a.txt' })) as { size: number };
    expect(info.size).toBe(5);
  });

  it('writeFile: перезаписывает содержимое файла', async () => {
    await svc.writeFile(root, 'sub/a.txt', 'updated!');
    expect((await svc.readFile(root, 'sub/a.txt')).data).toBe('updated!');
  });
});
