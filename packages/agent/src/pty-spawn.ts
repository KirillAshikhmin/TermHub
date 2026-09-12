// Свой клиент pty вместо node-pty.spawn(). Причина — две протечки дескрипторов
// в node-pty 1.1.0 на macOS (`pty_posix_spawn` в src/unix/pty.cc): открытый в
// родителе slave закрывается только у ребёнка (`addclose` действует на него), а
// резервный ptmx из low_fds не закрывается вовсе — цикл уборки `for (; count > 0;
// count--)` при типичном count === 0 не выполняется ни разу. Агент живёт неделями,
// и три потерянных fd на каждое подключение упираются в системный лимит pty.
//
// Здесь пара открывается напрямую (openpty), процесс поднимает обычный
// child_process.spawn, а закрываем оба конца мы сами.

import { spawn as spawnProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import tty from 'node:tty';
import * as nodePty from 'node-pty';

/** Нативная часть node-pty в её d.ts не объявлена: описываем ровно то, что зовём. */
interface PtyNative {
  open(cols: number, rows: number): { master: number; slave: number; pty: string };
  resize(fd: number, cols: number, rows: number): void;
}

const ptyNative = (nodePty as unknown as { native: PtyNative }).native;

/** Пускач из поставки node-pty: делает open() своего tty и тем назначает процессу
 *  управляющий терминал. Без него tmux не получает SIGWINCH и не узнаёт о resize,
 *  а сам Node назначить ctty не умеет. Каталоги перебираем те же, что и node-pty. */
function findSpawnHelper(): string {
  const libDir = path.dirname(createRequire(import.meta.url).resolve('node-pty'));
  const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`];
  for (const relative of ['..', '.']) {
    for (const dir of dirs) {
      const candidate = path.resolve(libDir, relative, dir, 'spawn-helper');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('node-pty spawn-helper not found: terminal cannot be started');
}

const helperPath = findSpawnHelper();

export interface PtyDisposable {
  dispose(): void;
}

/** Ровно та часть контракта node-pty, которой пользуются мосты. */
export interface PtyClient {
  readonly pid: number | undefined;
  onData(cb: (chunk: Buffer) => void): PtyDisposable;
  onExit(cb: () => void): PtyDisposable;
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  /** Закрывает pty и гасит клиента. Идемпотентно: повторный вызов — не ошибка. */
  destroy(): void;
}

export interface SpawnPtyOptions {
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
  /** Процесс не запустился (нет бинаря, нет прав): наружу это приходит как exit. */
  onError?: (err: Error) => void;
}

/** Очередь записи в master: ядро отвечает EAGAIN, когда его буфер полон, и
 *  потерянный на этом кусок ввода — это потерянные нажатия пользователя. */
class WriteQueue {
  private readonly chunks: Buffer[] = [];
  private offset = 0;
  private busy = false;
  private closed = false;

  constructor(private readonly fd: number) {}

  push(data: string | Uint8Array): void {
    if (this.closed) return;
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    if (buf.byteLength === 0) return;
    this.chunks.push(buf);
    if (!this.busy) this.flush();
  }

  close(): void {
    this.closed = true;
    this.chunks.length = 0;
  }

  private flush(): void {
    const head = this.chunks[0];
    if (this.closed || head === undefined) {
      this.busy = false;
      return;
    }
    this.busy = true;
    fs.write(this.fd, head, this.offset, (err, written) => {
      if (err) {
        // EAGAIN — буфер ядра полон: уступаем циклу событий и пробуем снова.
        if ((err as NodeJS.ErrnoException).code === 'EAGAIN') {
          setImmediate(() => this.flush());
          return;
        }
        // Остальное значит мёртвый pty: дописывать некуда и незачем.
        this.close();
        this.busy = false;
        return;
      }
      this.offset += written;
      if (this.offset >= head.byteLength) {
        this.chunks.shift();
        this.offset = 0;
      }
      this.flush();
    });
  }
}

export function spawnPty(file: string, args: string[], opts: SpawnPtyOptions): PtyClient {
  const pair = ptyNative.open(opts.cols, opts.rows);
  let child;
  try {
    // helper ждёт argv как <cwd> <file> <args...>; пустой cwd означает «не менять».
    // detached делает процесс лидером сессии — без этого назначить ctty нельзя.
    child = spawnProcess(helperPath, ['', file, ...args], {
      stdio: [pair.slave, pair.slave, pair.slave],
      env: opts.env,
      detached: true,
    });
  } finally {
    // Копия родителя не нужна ни при успехе (у ребёнка своя), ни при отказе.
    try {
      fs.closeSync(pair.slave);
    } catch {
      // slave уже закрыт — закрытие идемпотентно
    }
  }

  const master = new tty.ReadStream(pair.master);
  // EIO прилетает на смерти клиента: это штатный конец, а не сбой потока.
  master.on('error', () => {});
  const writes = new WriteQueue(pair.master);

  const exitCbs = new Set<() => void>();
  let exited = false;
  const fireExit = (): void => {
    if (exited) return;
    exited = true;
    writes.close();
    for (const cb of [...exitCbs]) cb();
  };
  child.on('exit', fireExit);
  child.on('error', (err: Error) => {
    opts.onError?.(err);
    fireExit();
  });

  let destroyed = false;

  return {
    get pid(): number | undefined {
      return child.pid;
    },
    onData(cb: (chunk: Buffer) => void): PtyDisposable {
      const handler = (chunk: Buffer): void => cb(chunk);
      master.on('data', handler);
      return { dispose: (): void => void master.off('data', handler) };
    },
    onExit(cb: () => void): PtyDisposable {
      exitCbs.add(cb);
      return { dispose: (): void => void exitCbs.delete(cb) };
    },
    write(data: string | Uint8Array): void {
      if (destroyed) return;
      writes.push(data);
    },
    resize(cols: number, rows: number): void {
      if (destroyed) return;
      try {
        ptyNative.resize(pair.master, cols, rows);
      } catch {
        // pty уже мёртв — размер ему без надобности
      }
    },
    pause(): void {
      master.pause();
    },
    resume(): void {
      master.resume();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      writes.close();
      // Порядок как у node-pty: сначала перестаём читать мёртвый fd, потом сигнал.
      master.destroy();
      try {
        child.kill('SIGHUP');
      } catch {
        // клиент уже вышел — гашение идемпотентно
      }
    },
  };
}
