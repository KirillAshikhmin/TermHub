// Управление системным сном macOS через `caffeinate`. Пока процесс жив — система
// не засыпает по простою; `set(false)` (или выход процесса) снимает удержание.
// Флаги -ims: idle + disk + system sleep (без -d, чтобы дисплей мог гаснуть).

import { spawn } from 'node:child_process';

/** Минимум, который нам нужен от дочернего процесса (для инъекции в тестах). */
export interface CaffeinateProc {
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
  kill(): void;
}

export type SpawnCaffeinate = () => CaffeinateProc;

function defaultSpawn(): CaffeinateProc {
  return spawn('caffeinate', ['-ims'], { stdio: 'ignore' });
}

export interface CaffeinateOpts {
  /** Фабрика процесса (тесты подменяют реальный spawn). */
  spawn?: SpawnCaffeinate;
  /** Поддержка платформы; по умолчанию — только macOS (`caffeinate`). */
  supported?: boolean;
}

/** Держит систему бодрствующей, пока активно. Идемпотентно, безопасно к повторам. */
export class Caffeinate {
  readonly supported: boolean;
  private readonly spawnFn: SpawnCaffeinate;
  private proc: CaffeinateProc | null = null;

  constructor(opts: CaffeinateOpts = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.supported = opts.supported ?? process.platform === 'darwin';
  }

  isActive(): boolean {
    return this.proc !== null;
  }

  set(on: boolean): void {
    if (on) this.start();
    else this.stop();
  }

  private start(): void {
    if (!this.supported || this.proc) return;
    const proc = this.spawnFn();
    this.proc = proc;
    // Выход/сбой процесса (в т.ч. ENOENT на не-mac) — снимаем активность.
    const clear = (): void => {
      if (this.proc === proc) this.proc = null;
    };
    proc.on('exit', clear);
    proc.on('error', clear);
  }

  private stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    try {
      proc.kill();
    } catch {
      // Процесс уже мёртв — идемпотентно.
    }
  }
}
