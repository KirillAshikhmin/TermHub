// «Не спать при закрытой крышке» (только macOS). Обычный caffeinate держит Mac от сна по
// простою, но закрытая крышка усыпляет его всё равно. Системная настройка `SleepDisabled`
// (её же ставит утилита Fermata приватным вызовом IOPMSetSystemPowerSetting) отключает
// сон целиком — и по крышке тоже. Штатный путь к ней — `pmset -a disablesleep 1`, и ему
// нужны права root.
//
// Агент работает от пользователя, поэтому зовёт `sudo -n /usr/bin/pmset -a disablesleep N`
// — без запроса пароля. Разрешение на РОВНО эти две команды владелец выдаёт один раз
// правилом sudoers (его печатает `termhub lid-awake`); без правила режим виден, но не
// включается, и интерфейс говорит, что нужна настройка.
//
// Режим опасен тем, что закрытый ноутбук греется в сумке, поэтому он сам себя снимает:
// как только крышку закрыли и снова открыли — настройка возвращается. Она же возвращается
// при остановке агента, а после падения — при следующем старте (по метке на диске).

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PMSET = '/usr/bin/pmset';
/** Файл правила sudoers, который предлагает создать `termhub lid-awake`. */
export const SUDOERS_FILE = '/etc/sudoers.d/termhub-lidawake';

/** Запуск команды: код выхода и stdout. Не бросает — сбой запуска это ненулевой код. */
export type RunCommand = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

const defaultRun: RunCommand = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });

/** Строка правила sudoers: только две точные команды, ничего шире. */
export function sudoersRule(user: string): string {
  return `${user} ALL=(root) NOPASSWD: ${PMSET} -a disablesleep 0, ${PMSET} -a disablesleep 1`;
}

/** Команда, которой владелец один раз выдаёт разрешение (печатает CLI). */
export function sudoersInstallCommand(user: string): string {
  return (
    `echo '${sudoersRule(user)}' | sudo tee ${SUDOERS_FILE} >/dev/null` +
    ` && sudo chmod 440 ${SUDOERS_FILE} && sudo visudo -cf ${SUDOERS_FILE}`
  );
}

/** Закрыта ли крышка, по выводу `ioreg -r -k AppleClamshellState`; undefined — не узнать
 *  (настольный Mac, незнакомый вывод). */
export function parseClamshell(stdout: string): boolean | undefined {
  const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(stdout);
  return m ? m[1] === 'Yes' : undefined;
}

export interface LidAwakeOpts {
  platform?: NodeJS.Platform;
  run?: RunCommand;
  /** Метка «настройку включили мы» — чтобы вернуть её после падения агента. */
  markerFile?: string;
  /** Период опроса крышки, мс. */
  pollMs?: number;
  log?: (message: string) => void;
}

export interface LidAwakeState {
  /** Платформа умеет (macOS). */
  lidSupported: boolean;
  /** Разрешение sudoers выдано — режим можно включать. */
  lidReady: boolean;
  /** Режим включён. */
  lid: boolean;
}

/** Сколько верить прошлой проверке разрешения: владелец выдаёт его при работающем агенте,
 *  и после выдачи режим должен заработать без перезапуска. */
const READY_TTL_MS = 15_000;

export class LidAwake {
  readonly supported: boolean;
  private readonly run: RunCommand;
  private readonly markerFile: string;
  private readonly pollMs: number;
  private readonly log: (message: string) => void;
  private active = false;
  private ready = false;
  private readyAt = 0;
  private readyCheck: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Крышку закрывали при включённом режиме: следующее открытие его снимает. */
  private closedSeen = false;

  constructor(opts: LidAwakeOpts = {}) {
    this.supported = (opts.platform ?? process.platform) === 'darwin';
    this.run = opts.run ?? defaultRun;
    this.markerFile = opts.markerFile ?? path.join(os.homedir(), '.termhub', 'lid-awake.on');
    this.pollMs = opts.pollMs ?? 2000;
    this.log = opts.log ?? ((line): void => console.warn(line));
  }

  /** Состояние для интерфейса. Разрешение перепроверяется в фоне, ответ не ждёт. */
  state(): LidAwakeState {
    if (this.supported) void this.refreshReady();
    return { lidSupported: this.supported, lidReady: this.ready, lid: this.active };
  }

  /** Проверка разрешения sudoers: `sudo -n -l <команда>` отвечает кодом 0, если её можно
   *  выполнить без пароля. Саму настройку проверка не трогает. */
  refreshReady(force = false): Promise<void> {
    if (!this.supported) return Promise.resolve();
    if (this.readyCheck) return this.readyCheck;
    if (!force && Date.now() - this.readyAt < READY_TTL_MS) return Promise.resolve();
    this.readyCheck = this.run('sudo', ['-n', '-l', PMSET, '-a', 'disablesleep', '1'])
      .then(({ code }) => {
        this.ready = code === 0;
        this.readyAt = Date.now();
      })
      .finally(() => {
        this.readyCheck = null;
      });
    return this.readyCheck;
  }

  /** Старт агента: настройка, оставшаяся включённой после падения, возвращается. */
  async recover(): Promise<void> {
    if (!this.supported || !fs.existsSync(this.markerFile)) return;
    this.log('lid-awake: sleep was left disabled by a previous run, restoring it');
    await this.write(false);
  }

  /** Включить или выключить. true — настройка применена. */
  async set(on: boolean): Promise<boolean> {
    if (!this.supported) return false;
    if (on === this.active) return true;
    if (on) {
      await this.refreshReady(true);
      if (!this.ready) return false;
    }
    if (!(await this.write(on))) return false;
    this.active = on;
    this.closedSeen = false;
    if (on) this.watch();
    else this.unwatch();
    return true;
  }

  /** Синхронное снятие при остановке агента: ждать там некого, команда уходит и всё. */
  release(): void {
    if (!this.active) return;
    this.active = false;
    this.unwatch();
    void this.write(false);
  }

  private async write(on: boolean): Promise<boolean> {
    const { code } = await this.run('sudo', ['-n', PMSET, '-a', 'disablesleep', on ? '1' : '0']);
    if (code !== 0) {
      this.log(`lid-awake: pmset disablesleep ${on ? 1 : 0} failed with code ${code}`);
      return false;
    }
    try {
      if (on) {
        fs.mkdirSync(path.dirname(this.markerFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(this.markerFile, '', { mode: 0o600 });
      } else fs.rmSync(this.markerFile, { force: true });
    } catch {
      // Метка — страховка на случай падения; без неё режим работает так же.
    }
    return true;
  }

  private watch(): void {
    this.unwatch();
    this.timer = setInterval(() => void this.checkLid(), this.pollMs);
    this.timer.unref?.();
  }

  private unwatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Крышку закрыли, а потом открыли — режим своё отработал и снимается. Включённый при
   *  открытой крышке режим ждёт: его включают как раз перед тем, как закрыть. */
  async checkLid(): Promise<void> {
    if (!this.active) return;
    const { code, stdout } = await this.run('ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '4']);
    const closed = code === 0 ? parseClamshell(stdout) : undefined;
    if (closed === undefined || !this.active) return;
    if (closed) {
      this.closedSeen = true;
      return;
    }
    if (!this.closedSeen) return;
    this.log('lid-awake: the lid was opened, sleep is allowed again');
    await this.set(false);
  }
}
