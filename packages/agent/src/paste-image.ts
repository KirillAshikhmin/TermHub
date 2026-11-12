// Картинка из буфера обмена клиента (и любой файл с устройства, если клиент назвал имя). Агент в панели (Claude Code, Codex) читает буфер
// хоста, а картинка лежит в буфере браузера на другом устройстве — поэтому клиент
// загружает её сюда, получает путь файла и вставляет этот путь в терминал: оба агента
// превращают вставленный путь картинки во вложение.
//
// Файлы кладутся в свой каталог (`~/.termhub/paste`, 0700), имя выбирает агент — клиент
// называет только тип. Место назначения от запроса не зависит, поэтому право гостя здесь —
// то же, что на ввод в терминал. Старые файлы убираются при следующей вставке.

import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { configDir } from './paths.js';

/** Предел размера картинки. */
export const PASTE_MAX_BYTES = 20 * 1024 * 1024;
/** Предел размера файла произвольного типа (загрузка с именем). */
export const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** Сколько живёт вставленный файл: агент читает его при вставке, дольше он не нужен. */
export const PASTE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Недогруженная кусками картинка бросается через это время тишины. */
const PART_IDLE_MS = 60_000;
const MAX_PARTS = 8;

const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', jpg: 'jpg', gif: 'gif', webp: 'webp' };

/** Расширение файла по названному клиентом типу (`png`, `image/png`); незнакомый — ошибка. */
export function pasteExt(type: string): string {
  const ext = EXT[type.toLowerCase().replace(/^image\//, '')];
  if (!ext) throw new Error('Unsupported image type');
  return ext;
}

/** Расширение по исходному имени файла клиента: только последний хвост из латиницы и цифр,
 *  в нижнем регистре; сам путь и остальное имя на хост не попадают. Нет хвоста — `bin`. */
export function fileExt(name: string): string {
  const found = /\.([A-Za-z0-9]{1,10})$/.exec(name.trim());
  return found ? found[1]!.toLowerCase() : 'bin';
}

/** Что и с каким пределом принимается: без имени — картинка по названному типу, с именем —
 *  любой файл, расширение берётся из имени. */
function kindOf(type: string, name: string | undefined): { ext: string; max: number; noun: string } {
  if (name === undefined || name === '') return { ext: pasteExt(type), max: PASTE_MAX_BYTES, noun: 'Image' };
  return { ext: fileExt(name), max: FILE_MAX_BYTES, noun: 'File' };
}

interface Part {
  temp: string;
  handle: fsp.FileHandle;
  ext: string;
  max: number;
  noun: string;
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
}

export class PasteStore {
  private readonly dir: string;
  private readonly parts = new Map<string, Part>();
  private readonly now: () => number;

  constructor(opts: { dir?: string; now?: () => number } = {}) {
    this.dir = opts.dir ?? path.join(configDir(), 'paste');
    this.now = opts.now ?? Date.now;
  }

  /** LAN: тело запроса потоком. Возвращает путь файла. `name` — исходное имя файла клиента:
   *  с ним принимается любой тип (до 50 МиБ), без него — только картинка. */
  async saveStream(type: string, stream: NodeJS.ReadableStream, name?: string): Promise<string> {
    const { ext, max, noun } = kindOf(type, name);
    const temp = await this.tempPath();
    const handle = await fsp.open(temp, 'wx', 0o600);
    let size = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > max ? new Error(`${noun} is too large`) : null, chunk);
      },
    });
    try {
      await pipeline(stream, limit, handle.createWriteStream());
      if (size === 0) throw new Error(`Empty ${noun.toLowerCase()}`);
      return await this.publish(temp, ext);
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.rm(temp, { force: true });
    }
  }

  /** Relay: файл кусками, по порядку. Путь файла — в ответе на последний кусок. `name` —
   *  как у `saveStream`; решает первый кусок. */
  async chunk(
    id: string,
    type: string,
    data: Buffer,
    offset: number,
    last: boolean,
    name?: string,
  ): Promise<{ path?: string }> {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new Error('Invalid upload id');
    let part = this.parts.get(id);
    if (part?.timer) clearTimeout(part.timer);
    try {
      if (offset === 0) {
        if (part) await this.discard(id, part);
        if (this.parts.size >= MAX_PARTS) throw new Error('Too many active uploads');
        const { ext, max, noun } = kindOf(type, name);
        const temp = await this.tempPath();
        part = { temp, handle: await fsp.open(temp, 'wx', 0o600), ext, max, noun, offset: 0 };
        this.parts.set(id, part);
      }
      if (!part) throw new Error('No active upload');
      if (offset !== part.offset) throw new Error('Invalid offset');
      if (part.offset + data.length > part.max) throw new Error(`${part.noun} is too large`);
      await part.handle.writeFile(data);
      part.offset += data.length;
      if (!last) {
        const current = part;
        part.timer = setTimeout(() => void this.discard(id, current).catch(() => undefined), PART_IDLE_MS);
        part.timer.unref?.();
        return {};
      }
      if (part.offset === 0) throw new Error(`Empty ${part.noun.toLowerCase()}`);
      await part.handle.close();
      this.parts.delete(id);
      try {
        return { path: await this.publish(part.temp, part.ext) };
      } finally {
        await fsp.rm(part.temp, { force: true });
      }
    } catch (err) {
      if (part) await this.discard(id, part);
      throw err;
    }
  }

  private async discard(id: string, part: Part): Promise<void> {
    if (this.parts.get(id) === part) this.parts.delete(id);
    if (part.timer) clearTimeout(part.timer);
    await part.handle.close().catch(() => undefined);
    await fsp.rm(part.temp, { force: true });
  }

  private async tempPath(): Promise<string> {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    return path.join(this.dir, `.part-${randomBytes(8).toString('hex')}`);
  }

  /** Имя файла — время и случайный хвост: в нём нет ни пробелов, ни данных клиента. */
  private async publish(temp: string, ext: string): Promise<string> {
    await this.sweep();
    const stamp = new Date(this.now()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
    const target = path.join(this.dir, `paste-${stamp}-${randomBytes(3).toString('hex')}.${ext}`);
    await fsp.link(temp, target);
    return target;
  }

  /** Убирает отжившие файлы. Сбой уборки вставке не мешает. */
  private async sweep(): Promise<void> {
    try {
      const edge = this.now() - PASTE_KEEP_MS;
      for (const name of await fsp.readdir(this.dir)) {
        if (!name.startsWith('paste-')) continue;
        const file = path.join(this.dir, name);
        const stat = await fsp.stat(file);
        if (stat.mtimeMs < edge) await fsp.rm(file, { force: true });
      }
    } catch {
      // каталог недоступен — следующая вставка попробует снова
    }
  }
}
