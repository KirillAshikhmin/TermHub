// Картинка из буфера клиента: файл в своём каталоге, имя выбирает агент.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FILE_MAX_BYTES, PASTE_KEEP_MS, PASTE_MAX_BYTES, PasteStore, fileExt, pasteExt } from '../src/paste-image.js';

let dir: string;
beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-paste-')), 'paste');
});
afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

const leftovers = (): string[] => fs.readdirSync(dir).filter((n) => n.startsWith('.part-'));

describe('картинка из буфера', () => {
  it('тип называет клиент, расширение выбирает агент; незнакомый тип — отказ', () => {
    expect(pasteExt('image/png')).toBe('png');
    expect(pasteExt('image/jpeg')).toBe('jpg');
    expect(pasteExt('WEBP')).toBe('webp');
    expect(() => pasteExt('image/svg+xml')).toThrow();
    expect(() => pasteExt('../../etc/passwd')).toThrow();
  });

  it('поток: файл 0600 в каталоге 0700, имя без пробелов и данных клиента', async () => {
    const store = new PasteStore({ dir, now: () => Date.UTC(2026, 10, 12, 9, 30, 5) });
    const file = await store.saveStream('image/png', Readable.from([Buffer.from('abc'), Buffer.from('def')]));
    expect(path.dirname(file)).toBe(dir);
    expect(path.basename(file)).toMatch(/^paste-20261112T093005-[0-9a-f]{6}\.png$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('abcdef');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(leftovers()).toEqual([]);
  });

  it('поток: пустое тело, чужой тип и превышение предела файла не оставляют', async () => {
    const store = new PasteStore({ dir });
    await expect(store.saveStream('image/png', Readable.from([]))).rejects.toThrow('Empty image');
    await expect(store.saveStream('text/html', Readable.from([Buffer.from('x')]))).rejects.toThrow();
    const big = Buffer.alloc(PASTE_MAX_BYTES / 2 + 1);
    await expect(store.saveStream('image/png', Readable.from([big, big]))).rejects.toThrow('too large');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('куски: путь приходит на последнем; сбитый порядок рвёт загрузку', async () => {
    const store = new PasteStore({ dir });
    expect(await store.chunk('upload-0001', 'image/jpeg', Buffer.from('ab'), 0, false)).toEqual({});
    const done = await store.chunk('upload-0001', 'image/jpeg', Buffer.from('cd'), 2, true);
    expect(fs.readFileSync(done.path!, 'utf8')).toBe('abcd');
    expect(done.path).toMatch(/\.jpg$/);
    await store.chunk('upload-0002', 'png', Buffer.from('ab'), 0, false);
    await expect(store.chunk('upload-0002', 'png', Buffer.from('cd'), 5, true)).rejects.toThrow('Invalid offset');
    // Загрузка сорвана целиком: продолжить её уже нельзя.
    await expect(store.chunk('upload-0002', 'png', Buffer.from('cd'), 2, true)).rejects.toThrow('No active upload');
    await expect(store.chunk('../x', 'png', Buffer.from('a'), 0, true)).rejects.toThrow('Invalid upload id');
    await expect(store.chunk('upload-0003', 'png', Buffer.alloc(0), 0, true)).rejects.toThrow('Empty image');
    expect(leftovers()).toEqual([]);
  });

  it('отжившие файлы убираются при следующей вставке, свежие и чужие остаются', async () => {
    let now = Date.UTC(2026, 10, 1);
    const store = new PasteStore({ dir, now: () => now });
    const old = await store.saveStream('png', Readable.from([Buffer.from('old')]));
    const past = new Date(now - PASTE_KEEP_MS - 1000);
    fs.utimesSync(old, past, past);
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine');
    now += 1000;
    const fresh = await store.saveStream('png', Readable.from([Buffer.from('new')]));
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true);
  });
});

describe('любой файл с устройства (G06)', () => {
  it('расширение берётся из имени клиента и очищается; остального имени на хосте нет', () => {
    expect(fileExt('report.PDF')).toBe('pdf');
    expect(fileExt('../../etc/passwd')).toBe('bin');
    expect(fileExt('archive.tar.gz')).toBe('gz');
    expect(fileExt('weird.p/ng')).toBe('bin');
    expect(fileExt('x.ext with space')).toBe('bin');
    expect(fileExt('noext')).toBe('bin');
    expect(fileExt('trailing.')).toBe('bin');
  });

  it('поток с именем: тип не картинка — не помеха, файл 0600, имя выбирает агент', async () => {
    const store = new PasteStore({ dir, now: () => Date.UTC(2026, 10, 12, 9, 30, 5) });
    const file = await store.saveStream('text/csv', Readable.from([Buffer.from('a,b\n1,2\n')]), 'таблица данных.CSV');
    expect(path.basename(file)).toMatch(/^paste-20261112T093005-[0-9a-f]{6}\.csv$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('a,b\n1,2\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(leftovers()).toEqual([]);
  });

  it('поток с именем: предел 50 МиБ, картинка без имени остаётся при 20', async () => {
    const store = new PasteStore({ dir });
    const piece = Buffer.alloc(FILE_MAX_BYTES / 2 + 1);
    await expect(store.saveStream('application/zip', Readable.from([piece, piece]), 'a.zip')).rejects.toThrow('too large');
    const mid = Buffer.alloc(PASTE_MAX_BYTES + 1);
    const ok = await store.saveStream('application/zip', Readable.from([mid]), 'a.zip');
    expect(fs.statSync(ok).size).toBe(mid.length);
    await expect(store.saveStream('image/png', Readable.from([mid]))).rejects.toThrow('too large');
    await expect(store.saveStream('application/zip', Readable.from([]), 'a.zip')).rejects.toThrow('Empty file');
    expect(leftovers()).toEqual([]);
  });

  it('куски с именем: первый кусок задаёт расширение и предел', async () => {
    const store = new PasteStore({ dir });
    await store.chunk('upload-9001', 'application/pdf', Buffer.from('ab'), 0, false, 'doc.pdf');
    const done = await store.chunk('upload-9001', 'application/pdf', Buffer.from('cd'), 2, true, 'doc.pdf');
    expect(done.path).toMatch(/\.pdf$/);
    expect(fs.readFileSync(done.path!, 'utf8')).toBe('abcd');
    await expect(store.chunk('upload-9002', 'application/pdf', Buffer.from('x'), 0, true)).rejects.toThrow(
      'Unsupported image type',
    );
    expect(leftovers()).toEqual([]);
  });
});
