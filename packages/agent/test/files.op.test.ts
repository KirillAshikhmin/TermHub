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

  it('mkdir: создаёт папку; повторный вызов — ошибка (не молчаливый успех)', async () => {
    await svc.mkdir(root, 'newdir');
    expect((await fsp.stat(path.join(root, 'newdir'))).isDirectory()).toBe(true);
    await expect(svc.mkdir(root, 'newdir')).rejects.toThrow();
  });

  it('mkdir: анти-побег за корень', async () => {
    await expect(svc.mkdir(root, '../escaped')).rejects.toThrow();
    expect(await fsp.stat(path.join(root, '..', 'escaped')).catch(() => null)).toBeNull();
  });

  it('uploadChunk: собирает файл из кусков и не оставляет временных файлов', async () => {
    const part1 = Buffer.from('hello ');
    const part2 = Buffer.from('upload');
    await svc.uploadChunk(root, 'up.txt', part1, 0, false);
    // До последнего куска настоящего файла ещё нет — только временный.
    expect(await fsp.stat(path.join(root, 'up.txt')).catch(() => null)).toBeNull();
    await svc.uploadChunk(root, 'up.txt', part2, part1.length, true);
    expect(await fsp.readFile(path.join(root, 'up.txt'), 'utf8')).toBe('hello upload');
    const left = (await fsp.readdir(root)).filter((n) => n.includes('termhub-part'));
    expect(left).toEqual([]);
  });

  it('uploadChunk: существующий файл не перезаписывается', async () => {
    await expect(svc.uploadChunk(root, 'up.txt', Buffer.from('x'), 0, true)).rejects.toThrow(/exists/i);
    expect(await fsp.readFile(path.join(root, 'up.txt'), 'utf8')).toBe('hello upload');
  });

  it('uploadChunk: анти-побег за корень', async () => {
    await expect(svc.uploadChunk(root, '../escaped.txt', Buffer.from('x'), 0, true)).rejects.toThrow();
  });

  it('uploadStream: пишет файл потоком (LAN-путь)', async () => {
    const { Readable } = await import('node:stream');
    await svc.uploadStream(root, 'streamed.bin', Readable.from([Buffer.from('abc'), Buffer.from('def')]));
    expect(await fsp.readFile(path.join(root, 'streamed.bin'), 'utf8')).toBe('abcdef');
    const left = (await fsp.readdir(root)).filter((n) => n.includes('termhub-part'));
    expect(left).toEqual([]);
  });

  it('runFileOp: mkdir и upload-chunk доступны обоим транспортам', async () => {
    await runFileOp(svc, { action: 'mkdir', root, path: 'viaop' });
    expect((await fsp.stat(path.join(root, 'viaop'))).isDirectory()).toBe(true);
    await runFileOp(svc, {
      action: 'upload-chunk',
      root,
      path: 'viaop/f.txt',
      offset: 0,
      last: true,
      data: Buffer.from('payload').toString('base64'),
    });
    expect(await fsp.readFile(path.join(root, 'viaop', 'f.txt'), 'utf8')).toBe('payload');
  });
});
