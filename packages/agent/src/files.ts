// Файловый браузер: листинг директорий и чтение файлов в пределах корней сессий.
// Только чтение. Безопасность — realpath-проверка: реальный путь (после резолва
// symlink) обязан лежать внутри одного из корней (защита от ../ и symlink-побега).

import { constants as fsConstants } from 'node:fs';
import fsp, { type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileContent, FileEntry, FileInfo } from '@termhub/protocol';
import { openPathOnHost } from './host-open.js';
import { configDir } from './paths.js';

/** Лимиты инлайн-просмотра: больше — только скачивание (truncated). */
const TEXT_LIMIT = 5 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;

/** Расширение → MIME для картинок, которые показываем превью. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** Расширение → MIME для видео/аудио (плеер / потоковое скачивание). */
const MEDIA_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
};

/** Предел картинки, отдаваемой по абсолютному пути (миниатюры чата). */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
/** Потолок одного куска картинки (relay). */
const IMAGE_CHUNK_MAX = 4 * 1024 * 1024;
/** Расширения, с которыми путь вообще рассматривается как картинка. SVG здесь нет намеренно:
 *  это документ со скриптами, а не растр. */
const THUMB_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
/** Сколько первых байт нужно, чтобы узнать формат. */
const SNIFF_BYTES = 12;

/** Тип растровой картинки по сигнатуре содержимого; null — не png/jpeg/gif/webp.
 *  Расширению не верим: под именем `.png` может лежать что угодно. */
export function sniffImage(head: Uint8Array): string | null {
  const b = Buffer.from(head.buffer, head.byteOffset, head.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const sig = b.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** Временные каталоги сессий агентов этого пользователя. Сегодня известен один: Claude Code
 *  держит временные файлы сессии в `/tmp/claude-<uid>/<каталог проекта>/<id сессии>/`
 *  (замер 12.11.2026: имена подкаталогов совпадают с именами файлов бесед). У Codex и
 *  opencode своего каталога сессии не найдено — их здесь нет. */
export function agentTempDirs(uid: number | undefined = process.getuid?.(), base = '/tmp'): string[] {
  return uid === undefined ? [] : [path.join(base, `claude-${uid}`)];
}

/** Тип файла для просмотра (text уточняется по содержимому в readFile). */
export type FileKind = 'text' | 'image' | 'video' | 'audio' | 'binary';

function kindByExt(ext: string): FileKind {
  if (IMAGE_MIME[ext]) return 'image';
  const m = MEDIA_MIME[ext];
  if (m) return m.startsWith('video/') ? 'video' : 'audio';
  return 'binary';
}

function mimeByExt(ext: string): string {
  return IMAGE_MIME[ext] ?? MEDIA_MIME[ext] ?? 'application/octet-stream';
}

/** Похоже ли содержимое на бинарное: NUL-байт в первых 8 КБ. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

interface ChunkUpload {
  temp: string;
  handle: FileHandle;
  offset: number;
  timer?: ReturnType<typeof setTimeout>;
}

/** Обёртка над файловой системой в пределах корней (whitelist). */
export class FileService {
  private readonly roots: string[];
  private readonly uploads = new Map<string, ChunkUpload>();
  private readonly uploading = new Set<string>();
  private readonly opener: (filePath: string) => Promise<void>;
  /** Каталоги сверх корней, из которых отдаются ТОЛЬКО картинки (`readImage`): вложения
   *  TermHub и временный каталог агента. В проводник они не попадают. */
  private readonly imageDirs: string[];

  constructor(opts: { roots: string[]; opener?: (filePath: string) => Promise<void>; imageDirs?: string[] }) {
    this.roots = opts.roots;
    this.opener = opts.opener ?? openPathOnHost;
    this.imageDirs = opts.imageDirs ?? [path.join(configDir(), 'paste'), ...agentTempDirs()];
  }

  /** Реальные каталоги, из которых можно отдать картинку. Дополнительный каталог берётся,
   *  только если это настоящий каталог (не ссылка) самого пользователя: `/tmp` общий, и
   *  каталог с ожидаемым именем там мог завести кто угодно. */
  private async imageScopes(): Promise<string[]> {
    const out: string[] = [];
    for (const root of this.roots) {
      try {
        out.push(await fsp.realpath(root));
      } catch {
        // корня нет на диске — из него и отдавать нечего
      }
    }
    const uid = process.getuid?.();
    for (const dir of this.imageDirs) {
      try {
        const st = await fsp.lstat(dir);
        if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) continue;
        out.push(await fsp.realpath(dir));
      } catch {
        // каталога ещё нет
      }
    }
    return out;
  }

  /** Открывает картинку по абсолютному пути после всех проверок; дескриптор закрывает
   *  вызывающий. Порядок: вид пути → realpath → вложенность в разрешённый каталог →
   *  обычный файл → размер → сигнатура. Читается тот же дескриптор, что проверен. */
  private async openImage(file: string, within?: string): Promise<{ handle: FileHandle; size: number; mime: string }> {
    if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file)) throw new Error('Not an absolute path');
    if (!THUMB_EXT.has(path.extname(file).toLowerCase())) throw new Error('Not an image');
    const real = await fsp.realpath(file);
    const scopes = within === undefined ? await this.imageScopes() : [await fsp.realpath(within)];
    if (!scopes.some((dir) => real.startsWith(dir + path.sep))) throw new Error('Path outside allowed directories');
    // O_NOFOLLOW: последний компонент после realpath ссылкой быть не должен; O_NONBLOCK —
    // чтобы именованный канал под именем картинки не подвесил открытие.
    const handle = await fsp.open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new Error('Not a file');
      if (st.size > IMAGE_MAX_BYTES) throw new Error('Image is too large');
      const head = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(head, 0, SNIFF_BYTES, 0);
      const mime = sniffImage(head.subarray(0, bytesRead));
      if (!mime) throw new Error('Not an image');
      return { handle, size: st.size, mime };
    } catch (err) {
      await handle.close().catch(() => undefined);
      throw err;
    }
  }

  /** Читает `len` байт с `offset` из открытого файла (короткое чтение дочитывается). */
  private async readRange(handle: FileHandle, offset: number, len: number): Promise<Buffer> {
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const { bytesRead } = await handle.read(buf, got, len - got, offset + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return buf.subarray(0, got);
  }

  /** Картинка целиком по абсолютному пути (миниатюры чата, LAN). Отдаётся только растр
   *  png/jpeg/gif/webp до 20 МиБ из корней сессий и `imageDirs`; `within` (гость relay)
   *  сужает разрешённое до одного каталога. Тип — по содержимому. */
  async readImage(file: string, within?: string): Promise<{ mime: string; size: number; data: Buffer }> {
    const { handle, size, mime } = await this.openImage(file, within);
    try {
      const data = await this.readRange(handle, 0, size);
      return { mime, size: data.length, data };
    } finally {
      await handle.close();
    }
  }

  /** Кусок той же картинки (relay). Каждый кусок проходит все проверки заново: между
   *  запросами состояния нет, и файл за это время мог стать другим. */
  async imageChunk(
    file: string,
    offset: number,
    len: number,
    within?: string,
  ): Promise<{ mime: string; size: number; data: Buffer; eof: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
    const want = Math.min(Math.max(Math.trunc(Number.isFinite(len) ? len : 0), 0), IMAGE_CHUNK_MAX);
    const { handle, size, mime } = await this.openImage(file, within);
    try {
      const data = await this.readRange(handle, offset, Math.max(0, Math.min(want, size - offset)));
      return { mime, size, data, eof: offset + data.length >= size };
    } finally {
      await handle.close();
    }
  }

  /** Резолвит (root, subpath) в реальный путь, проверяя, что он внутри корня.
   *  Бросает при неизвестном корне или побеге за его пределы. */
  private async resolveSafe(root: string, subpath: string): Promise<string> {
    if (!this.roots.includes(root)) throw new Error('Unknown root');
    // subpath — относительный внутри корня; resolve схлопывает «..», realpath
    // резолвит symlink. Проверяем, что итог внутри реального корня.
    const realRoot = await fsp.realpath(root);
    const target = await fsp.realpath(path.resolve(realRoot, subpath));
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) {
      throw new Error('Path outside root');
    }
    return target;
  }

  /** Содержимое директории: папки первыми, затем файлы, обе группы по имени. */
  async listDir(root: string, subpath: string): Promise<FileEntry[]> {
    const dir = await this.resolveSafe(root, subpath);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const e of entries) {
      let stat;
      try {
        stat = await fsp.stat(path.join(dir, e.name));
      } catch {
        continue; // битый symlink / нет прав — пропускаем
      }
      if (!stat.isDirectory() && !stat.isFile()) continue; // сокеты/устройства — мимо
      result.push({
        name: e.name,
        kind: stat.isDirectory() ? 'dir' : 'file',
        size: stat.size,
        mtime: stat.mtimeMs,
        hidden: e.name.startsWith('.'),
      });
    }
    result.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
    );
    return result;
  }

  /** Содержимое файла для просмотра: текст, картинка (base64) или binary (для скачивания). */
  async readFile(root: string, subpath: string): Promise<FileContent> {
    const file = await this.resolveSafe(root, subpath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const ext = path.extname(file).toLowerCase();
    const imageMime = IMAGE_MIME[ext];

    if (imageMime) {
      if (stat.size > IMAGE_LIMIT) {
        return { kind: 'binary', mime: 'application/octet-stream', data: '', size: stat.size, truncated: true };
      }
      const buf = await fsp.readFile(file);
      return { kind: 'image', mime: imageMime, data: buf.toString('base64'), size: stat.size, truncated: false };
    }

    if (stat.size > TEXT_LIMIT) {
      return { kind: 'binary', mime: 'application/octet-stream', data: '', size: stat.size, truncated: true };
    }
    const buf = await fsp.readFile(file);
    if (looksBinary(buf)) {
      return {
        kind: 'binary',
        mime: 'application/octet-stream',
        data: buf.toString('base64'),
        size: stat.size,
        truncated: false,
      };
    }
    return { kind: 'text', mime: 'text/plain; charset=utf-8', data: buf.toString('utf8'), size: stat.size, truncated: false };
  }

  /** Метаданные файла без чтения содержимого (размер, mime, тип) — для стриминга. */
  async statFile(root: string, subpath: string): Promise<{ size: number; mime: string; kind: FileKind }> {
    const file = await this.resolveSafe(root, subpath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    const ext = path.extname(file).toLowerCase();
    return { size: stat.size, mime: mimeByExt(ext), kind: kindByExt(ext) };
  }

  /** Абсолютный путь файла после realpath-проверки (для LAN-стрима createReadStream). */
  async resolveFile(root: string, subpath: string): Promise<{ path: string; size: number; mime: string }> {
    const file = await this.resolveSafe(root, subpath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    return { path: file, size: stat.size, mime: mimeByExt(path.extname(file).toLowerCase()) };
  }

  /** Открывает обычный файл приложением хоста после roots/realpath-проверки. */
  async openOnHost(root: string, subpath: string): Promise<void> {
    const file = await this.resolveSafe(root, subpath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    await this.opener(file);
  }

  /** Чтение диапазона байт (для relay-чанков). */
  async readChunk(root: string, subpath: string, offset: number, len: number): Promise<Uint8Array> {
    const file = await this.resolveSafe(root, subpath);
    const fh = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(Math.max(0, len));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  /** Полные метаданные файла/папки (для «Свойства»). */
  async statFull(root: string, subpath: string): Promise<FileInfo> {
    const file = await this.resolveSafe(root, subpath);
    const st = await fsp.stat(file);
    return {
      name: path.basename(file),
      path: file,
      kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
      size: st.size,
      mtime: st.mtimeMs,
      ctime: st.ctimeMs,
      birthtime: st.birthtimeMs,
      atime: st.atimeMs,
      mode: modeString(st.mode),
    };
  }

  /** Удалить файл/папку (рекурсивно). Сам корень удалить нельзя. */
  async remove(root: string, subpath: string): Promise<void> {
    const file = await this.resolveSafe(root, subpath);
    if (file === (await fsp.realpath(root))) throw new Error('Cannot delete root');
    await fsp.rm(file, { recursive: true, force: false });
  }

  /** Переместить/переименовать в назначение (dest — путь относительно destRoot). */
  async move(root: string, subpath: string, destRoot: string, dest: string): Promise<void> {
    const src = await this.resolveSafe(root, subpath);
    const target = await this.resolveDest(destRoot, dest);
    try {
      await fsp.rename(src, target);
    } catch (e) {
      // Между разными ФС rename не работает (EXDEV) — копируем и удаляем исходник.
      if ((e as { code?: string }).code === 'EXDEV') {
        await fsp.cp(src, target, { recursive: true, errorOnExist: true, force: false });
        await fsp.rm(src, { recursive: true, force: true });
      } else throw e;
    }
  }

  /** Скопировать в назначение (рекурсивно). */
  async copy(root: string, subpath: string, destRoot: string, dest: string): Promise<void> {
    const src = await this.resolveSafe(root, subpath);
    const target = await this.resolveDest(destRoot, dest);
    await fsp.cp(src, target, { recursive: true, errorOnExist: true, force: false });
  }

  /** Записать текст в существующий файл (простое редактирование). */
  async writeFile(root: string, subpath: string, content: string): Promise<void> {
    const file = await this.resolveSafe(root, subpath);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('Not a file');
    await fsp.writeFile(file, content, 'utf8');
  }

  /** Создать каталог. `subpath` — путь вместе с именем нового каталога. Без `recursive`:
   *  существующий каталог/файл — честная ошибка, а не молчаливый успех. */
  async mkdir(root: string, subpath: string): Promise<void> {
    const target = await this.resolveDest(root, subpath);
    await fsp.mkdir(target);
  }

  /** Кусок загружаемого файла (relay: приходит чанками в FileOp).
   *  Пишем во временный файл рядом и переименовываем на последнем куске — при обрыве
   *  не остаётся «половинки» под настоящим именем. Существующий файл не перетираем. */
  async uploadChunk(root: string, subpath: string, data: Buffer, offset: number, last: boolean): Promise<void> {
    const target = await this.resolveDest(root, subpath);
    if (this.uploading.has(target)) throw new Error('Upload in progress');
    this.uploading.add(target);
    let upload = this.uploads.get(target);
    if (upload?.timer) clearTimeout(upload.timer);
    try {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
      if (offset === 0) {
        if (upload) await this.discardUpload(target, upload);
        await this.assertAbsent(target);
        if (new Set([...this.uploads.keys(), ...this.uploading]).size > 32) {
          throw new Error('Too many active uploads');
        }
        const temp = uploadTempPath(target);
        const handle = await fsp.open(temp, 'wx', 0o600);
        upload = { temp, handle, offset: 0 };
        this.uploads.set(target, upload);
      }
      if (!upload) throw new Error('No active upload');
      if (offset !== upload.offset) throw new Error('Invalid offset');
      // Пишем через эксклюзивно открытый дескриптор, не открывая путь повторно.
      await upload.handle.writeFile(data);
      upload.offset += data.length;
      if (last) {
        await upload.handle.close();
        await this.finishUpload(upload.temp, target);
        this.uploads.delete(target);
      } else {
        const current = upload;
        upload.timer = setTimeout(() => {
          void this.discardUpload(target, current).catch(() => undefined);
        }, 5 * 60 * 1000);
        upload.timer.unref();
      }
    } catch (err) {
      if (upload) await this.discardUpload(target, upload);
      throw err;
    } finally {
      this.uploading.delete(target);
    }
  }

  private async discardUpload(target: string, upload: ChunkUpload): Promise<void> {
    if (this.uploads.get(target) === upload) this.uploads.delete(target);
    if (upload.timer) clearTimeout(upload.timer);
    await upload.handle.close().catch(() => undefined);
    await fsp.rm(upload.temp, { force: true });
  }

  /** Приём файла потоком (LAN: тело POST идёт прямо на диск, без base64 и лимита JSON). */
  async uploadStream(root: string, subpath: string, stream: NodeJS.ReadableStream): Promise<void> {
    const target = await this.resolveDest(root, subpath);
    const temp = uploadTempPath(target);
    await this.assertAbsent(target);
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
      await pipeline(stream, handle.createWriteStream());
      await this.finishUpload(temp, target);
    } finally {
      await handle.close().catch(() => undefined);
      await fsp.rm(temp, { force: true });
    }
  }

  /** Требует отсутствия файла назначения, включая dangling symlink. */
  private async assertAbsent(target: string): Promise<void> {
    try {
      await fsp.lstat(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    throw new Error('File already exists');
  }

  /** Публикует файл атомарно, без перезаписи даже при конкурентном создании цели. */
  private async finishUpload(temp: string, target: string): Promise<void> {
    try {
      await fsp.link(temp, target);
    } finally {
      await fsp.rm(temp, { force: true });
    }
  }

  /** Резолв НЕсуществующего назначения: родитель обязан быть внутри корня (realpath). */
  private async resolveDest(root: string, subpath: string): Promise<string> {
    if (!this.roots.includes(root)) throw new Error('Unknown root');
    const realRoot = await fsp.realpath(root);
    const target = path.resolve(realRoot, subpath);
    const realParent = await fsp.realpath(path.dirname(target));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
      throw new Error('Destination outside root');
    }
    return path.join(realParent, path.basename(target));
  }
}

/** Имя временного файла загрузки рядом с целью: скрытый, с явным суффиксом — если
 *  загрузка оборвалась, понятно, что это и что его можно удалить. */
function uploadTempPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.termhub-part`);
}

/** mode → строка прав rwxr-xr-x (младшие 9 бит). */
function modeString(mode: number): string {
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 0; i < 9; i += 1) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}

/** Минимум для файловых операций (структурно; FileService удовлетворяет). */
export interface FileOpCtl {
  openOnHost(root: string, subpath: string): Promise<void>;
  statFull(root: string, subpath: string): Promise<FileInfo>;
  remove(root: string, subpath: string): Promise<void>;
  move(root: string, subpath: string, destRoot: string, dest: string): Promise<void>;
  copy(root: string, subpath: string, destRoot: string, dest: string): Promise<void>;
  writeFile(root: string, subpath: string, content: string): Promise<void>;
  mkdir(root: string, subpath: string): Promise<void>;
  uploadChunk(root: string, subpath: string, data: Buffer, offset: number, last: boolean): Promise<void>;
}

/** Диспетчер файловых операций — единая точка для server.ts и relay-link.ts. */
export async function runFileOp(files: FileOpCtl, req: Record<string, unknown>): Promise<unknown> {
  const root = String(req.root ?? '');
  const sub = String(req.path ?? '');
  switch (String(req.action ?? '')) {
    case 'open-host':
      return files.openOnHost(root, sub);
    case 'stat-full':
      return files.statFull(root, sub);
    case 'remove':
      return files.remove(root, sub);
    case 'move':
      return files.move(root, sub, String(req.destRoot ?? root), String(req.dest ?? ''));
    case 'copy':
      return files.copy(root, sub, String(req.destRoot ?? root), String(req.dest ?? ''));
    case 'write':
      return files.writeFile(root, sub, String(req.content ?? ''));
    case 'mkdir':
      return files.mkdir(root, sub);
    case 'upload-chunk': {
      // relay-путь загрузки: данные приходят кусками в base64 (JSON-кадр).
      const data = Buffer.from(String(req.data ?? ''), 'base64');
      const offset = Number(req.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid offset');
      return files.uploadChunk(root, sub, data, offset, req.last === true);
    }
    default:
      throw new Error('Unknown file operation');
  }
}
