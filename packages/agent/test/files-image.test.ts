// Картинка по абсолютному пути (миниатюры чата): что агент вправе отдать и что — нет.
// Всё на временных каталогах; настоящие `~/.termhub/paste` и каталог агента не читаются.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileService, IMAGE_MAX_BYTES, agentTempDirs, sniffImage } from '../src/files.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let base: string;
let root: string;
let paste: string;
let temp: string;
let outside: string;
let files: FileService;

beforeEach(async () => {
  base = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'th-image-')));
  root = path.join(base, 'root');
  paste = path.join(base, 'paste');
  temp = path.join(base, 'agent-tmp');
  outside = path.join(base, 'outside');
  for (const dir of [root, paste, temp, outside]) await fsp.mkdir(dir);
  files = new FileService({ roots: [root], imageDirs: [paste, temp] });
});
afterEach(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe('sniffImage — тип по содержимому', () => {
  it('узнаёт четыре формата по сигнатуре и ничего больше', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
    expect(sniffImage(SVG)).toBeNull();
    expect(sniffImage(Buffer.from('RIFF\x04\x00\x00\x00WAVEfmt ', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.from('BM\x00\x00\x00\x00', 'latin1'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });
});

describe('agentTempDirs — временный каталог агента', () => {
  it('называет каталог Claude Code этого пользователя и только его', () => {
    expect(agentTempDirs(503, '/tmp')).toEqual(['/tmp/claude-503']);
  });
});

describe('FileService.readImage', () => {
  it('отдаёт картинку из корня сессий, каталога вложений и временного каталога агента', async () => {
    await fsp.writeFile(path.join(root, 'shot.png'), PNG);
    await fsp.writeFile(path.join(paste, 'paste-1.jpg'), JPEG);
    await fsp.mkdir(path.join(temp, 'slug', 'session'), { recursive: true });
    await fsp.writeFile(path.join(temp, 'slug', 'session', 'a.webp'), WEBP);

    const png = await files.readImage(path.join(root, 'shot.png'));
    expect(png.mime).toBe('image/png');
    expect(png.size).toBe(PNG.length);
    expect(Buffer.compare(png.data, PNG)).toBe(0);
    expect((await files.readImage(path.join(paste, 'paste-1.jpg'))).mime).toBe('image/jpeg');
    expect((await files.readImage(path.join(temp, 'slug', 'session', 'a.webp'))).mime).toBe('image/webp');
  });

  it('тип берётся из содержимого, а не из расширения', async () => {
    await fsp.writeFile(path.join(root, 'really-gif.png'), GIF);
    expect((await files.readImage(path.join(root, 'really-gif.png'))).mime).toBe('image/gif');
  });

  it('файл вне разрешённых каталогов не отдаётся', async () => {
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    await expect(files.readImage(path.join(outside, 'secret.png'))).rejects.toThrow('Path outside allowed directories');
  });

  it('выход через «..» отклоняется', async () => {
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    await expect(files.readImage(`${root}/../outside/secret.png`)).rejects.toThrow('Path outside allowed directories');
  });

  it('символическая ссылка наружу отклоняется — и на файл, и на каталог', async () => {
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    await fsp.symlink(path.join(outside, 'secret.png'), path.join(root, 'link.png'));
    await fsp.symlink(outside, path.join(paste, 'dir'));
    await expect(files.readImage(path.join(root, 'link.png'))).rejects.toThrow('Path outside allowed directories');
    await expect(files.readImage(path.join(paste, 'dir', 'secret.png'))).rejects.toThrow('Path outside allowed directories');
  });

  it('не картинка по содержимому не отдаётся, даже с расширением картинки', async () => {
    await fsp.writeFile(path.join(root, 'notes.png'), 'just some text, not an image');
    await fsp.writeFile(path.join(root, 'vector.png'), SVG);
    await expect(files.readImage(path.join(root, 'notes.png'))).rejects.toThrow('Not an image');
    await expect(files.readImage(path.join(root, 'vector.png'))).rejects.toThrow('Not an image');
  });

  it('SVG и прочие расширения не отдаются вовсе', async () => {
    await fsp.writeFile(path.join(root, 'vector.svg'), SVG);
    await fsp.writeFile(path.join(root, 'data.bin'), PNG);
    await expect(files.readImage(path.join(root, 'vector.svg'))).rejects.toThrow('Not an image');
    await expect(files.readImage(path.join(root, 'data.bin'))).rejects.toThrow('Not an image');
  });

  it('файл больше 20 МиБ не отдаётся', async () => {
    expect(IMAGE_MAX_BYTES).toBe(20 * 1024 * 1024);
    const big = path.join(root, 'big.png');
    await fsp.writeFile(big, PNG);
    await fsp.truncate(big, IMAGE_MAX_BYTES + 1);
    await expect(files.readImage(big)).rejects.toThrow('Image is too large');
    await fsp.truncate(big, IMAGE_MAX_BYTES);
    expect((await files.readImage(big)).size).toBe(IMAGE_MAX_BYTES);
  });

  it('несуществующий файл, каталог и относительный путь — отказ', async () => {
    await fsp.mkdir(path.join(root, 'dir.png'));
    // Сбой файловой системы — своим словом: системного кода и пути в тексте нет.
    await expect(files.readImage(path.join(root, 'missing.png'))).rejects.toThrow(/^Image unavailable$/);
    await fsp.writeFile(path.join(root, 'plain.txt'), 'x');
    await expect(files.readImage(path.join(root, 'plain.txt', 'x.png'))).rejects.toThrow(/^Image unavailable$/);
    await expect(files.readImage(path.join(root, 'dir.png'))).rejects.toThrow('Not a file');
    await expect(files.readImage('shot.png')).rejects.toThrow('Not an absolute path');
    await expect(files.readImage(`${root}/a\0.png`)).rejects.toThrow('Not an absolute path');
  });

  it('`within` сужает разрешённое до одного каталога: остальное закрыто', async () => {
    const shared = path.join(root, 'shared');
    await fsp.mkdir(shared);
    await fsp.writeFile(path.join(shared, 'in.png'), PNG);
    await fsp.writeFile(path.join(root, 'sibling.png'), PNG);
    await fsp.writeFile(path.join(paste, 'p.png'), PNG);
    expect((await files.readImage(path.join(shared, 'in.png'), shared)).mime).toBe('image/png');
    await expect(files.readImage(path.join(root, 'sibling.png'), shared)).rejects.toThrow('Path outside allowed directories');
    await expect(files.readImage(path.join(paste, 'p.png'), shared)).rejects.toThrow('Path outside allowed directories');
  });

  it('дополнительный каталог, подменённый ссылкой, разрешённым не считается', async () => {
    const fake = path.join(base, 'fake-tmp');
    await fsp.symlink(outside, fake);
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    const svc = new FileService({ roots: [root], imageDirs: [fake] });
    await expect(svc.readImage(path.join(fake, 'secret.png'))).rejects.toThrow('Path outside allowed directories');
  });
});

describe('FileService.imageChunk — та же проверка на каждый кусок', () => {
  it('отдаёт файл кусками с типом и размером, конец помечен', async () => {
    const body = Buffer.concat([PNG, Buffer.alloc(100, 7)]);
    await fsp.writeFile(path.join(root, 'shot.png'), body);
    const first = await files.imageChunk(path.join(root, 'shot.png'), 0, 64);
    expect(first.mime).toBe('image/png');
    expect(first.size).toBe(body.length);
    expect(first.eof).toBe(false);
    const second = await files.imageChunk(path.join(root, 'shot.png'), 64, 64);
    expect(second.eof).toBe(true);
    expect(Buffer.compare(Buffer.concat([first.data, second.data]), body)).toBe(0);
  });

  it('чужой путь и не картинка — отказ и на куске', async () => {
    await fsp.writeFile(path.join(outside, 'secret.png'), PNG);
    await fsp.writeFile(path.join(root, 'notes.png'), 'text');
    await expect(files.imageChunk(path.join(outside, 'secret.png'), 0, 64)).rejects.toThrow('Path outside allowed directories');
    await expect(files.imageChunk(path.join(root, 'notes.png'), 0, 64)).rejects.toThrow('Not an image');
    await expect(files.imageChunk(path.join(root, 'notes.png'), -1, 64)).rejects.toThrow();
  });
});
