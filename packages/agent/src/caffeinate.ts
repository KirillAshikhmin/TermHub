// Управление системным сном хоста. Пока дочерний процесс жив — система не засыпает по
// простою; `set(false)` (или выход процесса) снимает удержание.
//  • macOS: `caffeinate -ims` (idle + disk + system sleep; без -d — дисплей может гаснуть);
//  • Linux (systemd): `systemd-inhibit … sleep infinity` — блокирует sleep/idle, пока
//    жив дочерний `sleep`.
// Кросс-платформенно: команду и «поддерживается ли» выбираем по process.platform.

import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Минимум, который нам нужен от дочернего процесса (для инъекции в тестах). */
export interface CaffeinateProc {
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): void;
  kill(): void;
}

export type SpawnCaffeinate = () => CaffeinateProc;

/** Команда удержания сна для платформы (null — платформа не поддерживается). */
export function sleepInhibitorCmd(platform: NodeJS.Platform): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'caffeinate', args: ['-ims'] };
  if (platform === 'linux') {
    return {
      cmd: 'systemd-inhibit',
      args: ['--what=sleep:idle', '--who=TermHub', '--why=Remote terminal session active', '--mode=block', 'sleep', 'infinity'],
    };
  }
  return null;
}

/** Поддерживается ли удержание сна: macOS — всегда; Linux — только при работающем systemd
 *  (наличие /run/systemd/system → есть systemd-inhibit). Иначе тумблер скрыт. */
export function sleepInhibitSupported(platform: NodeJS.Platform): boolean {
  if (platform === 'darwin') return true;
  if (platform === 'linux') return fs.existsSync('/run/systemd/system');
  return false;
}

function defaultSpawn(): CaffeinateProc {
  const c = sleepInhibitorCmd(process.platform) ?? { cmd: 'caffeinate', args: ['-ims'] };
  return spawn(c.cmd, c.args, { stdio: 'ignore' });
}

export interface CaffeinateOpts {
  /** Фабрика процесса (тесты подменяют реальный spawn). */
  spawn?: SpawnCaffeinate;
  /** Поддержка платформы; по умолчанию — sleepInhibitSupported (macOS / Linux+systemd). */
  supported?: boolean;
}

/** Держит систему бодрствующей, пока активно. Идемпотентно, безопасно к повторам. */
export class Caffeinate {
  readonly supported: boolean;
  private readonly spawnFn: SpawnCaffeinate;
  private proc: CaffeinateProc | null = null;

  constructor(opts: CaffeinateOpts = {}) {
    this.spawnFn = opts.spawn ?? defaultSpawn;
    this.supported = opts.supported ?? sleepInhibitSupported(process.platform);
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
