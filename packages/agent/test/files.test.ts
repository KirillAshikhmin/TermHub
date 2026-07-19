// Тесты файлового браузера: листинг/чтение и — главное — безопасность путей
// (побег за корень через «..» и symlink должен блокироваться).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FileService } from '../src/files.js';

let root: string;
let outside: string;
let svc: FileService;

beforeAll(async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'termhub-files-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await fsp.mkdir(root, { recursive: true });
  await fsp.mkdir(outside, { recursive: true });
  await fsp.mkdir(path.join(root, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(root, 'b.txt'), 'hello world');
  await fsp.writeFile(path.join(root, 'a.txt'), 'aaa');
  await fsp.writeFile(path.join(root, '.hidden'), 'secret');
  // Бинарный: содержит NUL.
  await fsp.writeFile(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x03]));
  // Медиа (по расширению): для statFile/readChunk.
  await fsp.writeFile(path.join(root, 'clip.mp4'), Buffer.from('0123456789abcdef'));
  // Секрет за пределами корня + symlink на него внутри корня.
  await fsp.writeFile(path.join(outside, 'secret.txt'), 'TOP SECRET');
  await fsp.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-out.txt'));
  svc = new FileService({ roots: [root] });
});

afterAll(async () => {
  await fsp.rm(path.dirname(root), { recursive: true, force: true });
});

describe('FileService.listDir', () => {
  it('папки идут первыми, затем файлы по имени; скрытые помечены', async () => {
    const list = await svc.listDir(root, '');
    const names = list.map((e) => e.name);
    expect(names[0]).toBe('sub'); // единственная папка — первой
    expect(list.find((e) => e.name === 'sub')!.kind).toBe('dir');
    expect(list.find((e) => e.name === '.hidden')!.hidden).toBe(true);
    expect(list.find((e) => e.name === 'a.txt')!.hidden).toBe(false);
    // файлы после папок, по алфавиту
    const files = list.filter((e) => e.kind === 'file').map((e) => e.name);
    expect(files).toEqual([...files].sort((x, y) => x.localeCompare(y)));
  });

  it('отдаёт размер и mtime файлов', async () => {
    const list = await svc.listDir(root, '');
    const b = list.find((e) => e.name === 'b.txt')!;
    expect(b.size).toBe('hello world'.length);
    expect(b.mtime).toBeGreaterThan(0);
  });
});

describe('FileService.readFile', () => {
  it('читает текстовый файл как text', async () => {
    const c = await svc.readFile(root, 'b.txt');
    expect(c.kind).toBe('text');
    expect(c.data).toBe('hello world');
    expect(c.truncated).toBe(false);
  });

  it('файл с NUL-байтами отдаёт как binary (base64)', async () => {
    const c = await svc.readFile(root, 'bin.dat');
    expect(c.kind).toBe('binary');
    expect(Buffer.from(c.data, 'base64')).toEqual(Buffer.from([0x00, 0x01, 0x02, 0x03]));
  });
});

describe('FileService.statFile / readChunk', () => {
  it('statFile определяет kind/mime по расширению (video)', async () => {
    const st = await svc.statFile(root, 'clip.mp4');
    expect(st.kind).toBe('video');
    expect(st.mime).toBe('video/mp4');
    expect(st.size).toBe(16);
  });

  it('statFile: .txt без media-расширения → binary (kind уточняет readFile)', async () => {
    const st = await svc.statFile(root, 'b.txt');
    expect(st.kind).toBe('binary');
    expect(st.size).toBe('hello world'.length);
  });

  it('readChunk читает диапазон байт', async () => {
    const chunk = await svc.readChunk(root, 'clip.mp4', 4, 6);
    expect(Buffer.from(chunk).toString()).toBe('456789');
  });

  it('readChunk за концом файла возвращает короткий буфер', async () => {
    const chunk = await svc.readChunk(root, 'clip.mp4', 12, 100);
    expect(Buffer.from(chunk).toString()).toBe('cdef');
  });

  it('statFile/readChunk защищены realpath-проверкой (symlink вне корня)', async () => {
    await expect(svc.statFile(root, 'link-out.txt')).rejects.toThrow();
    await expect(svc.readChunk(root, 'link-out.txt', 0, 10)).rejects.toThrow();
  });
});

describe('FileService — безопасность путей', () => {
  it('«..»-побег за корень отклоняется', async () => {
    await expect(svc.listDir(root, '../outside')).rejects.toThrow();
    await expect(svc.readFile(root, '../outside/secret.txt')).rejects.toThrow();
  });

  it('symlink на файл вне корня отклоняется (realpath-проверка)', async () => {
    await expect(svc.readFile(root, 'link-out.txt')).rejects.toThrow();
  });

  it('неизвестный корень отклоняется', async () => {
    await expect(svc.listDir(outside, '')).rejects.toThrow('Неизвестный корень');
  });

  it('абсолютный подпуть не выводит за корень', async () => {
    // path.resolve(realRoot, '/etc') → '/etc', realpath → вне корня → ошибка.
    await expect(svc.readFile(root, '/etc/passwd')).rejects.toThrow();
  });
});
