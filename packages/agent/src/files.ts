// Файловый браузер: листинг директорий и чтение файлов в пределах корней сессий.
// Только чтение. Безопасность — realpath-проверка: реальный путь (после резолва
// symlink) обязан лежать внутри одного из корней (защита от ../ и symlink-побега).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileContent, FileEntry, FileInfo } from '@termhub/protocol';

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

/** Обёртка над файловой системой в пределах корней (whitelist). */
export class FileService {
  private readonly roots: string[];

  constructor(opts: { roots: string[] }) {
    this.roots = opts.roots;
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
    const temp = uploadTempPath(target);
    if (offset === 0) {
      await this.assertAbsent(target);
      await fsp.writeFile(temp, data);
    } else {
      await fsp.appendFile(temp, data);
    }
    if (last) await this.finishUpload(temp, target);
  }

  /** Приём файла потоком (LAN: тело POST идёт прямо на диск, без base64 и лимита JSON). */
  async uploadStream(root: string, subpath: string, stream: NodeJS.ReadableStream): Promise<void> {
    const target = await this.resolveDest(root, subpath);
    const temp = uploadTempPath(target);
    await this.assertAbsent(target);
    const handle = await fsp.open(temp, 'w');
    try {
      const writable = handle.createWriteStream();
      await pipeline(stream, writable);
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
    } finally {
      await handle.close().catch(() => undefined);
    }
    await this.finishUpload(temp, target);
  }

  /** Требует отсутствия файла назначения (загрузка не должна молча затирать). */
  private async assertAbsent(target: string): Promise<void> {
    const exists = await fsp
      .stat(target)
      .then(() => true)
      .catch(() => false);
    if (exists) throw new Error('File already exists');
  }

  /** Переносит временный файл на место назначения (с повторной проверкой отсутствия). */
  private async finishUpload(temp: string, target: string): Promise<void> {
    try {
      await this.assertAbsent(target);
      await fsp.rename(temp, target);
    } catch (err) {
      await fsp.rm(temp, { force: true });
      throw err;
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
  return path.join(path.dirname(target), `.${path.basename(target)}.termhub-part`);
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
      if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
      return files.uploadChunk(root, sub, data, offset, req.last === true);
    }
    default:
      throw new Error('Unknown file operation');
  }
}
