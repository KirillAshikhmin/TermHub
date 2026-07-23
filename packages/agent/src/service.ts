// Команда `termhub service install|uninstall|status`: автозапуск агента.
//  • macOS: LaunchAgent — plist в ~/Library/LaunchAgents, регистрация через
//    `launchctl bootstrap` (uninstall — `bootout`, status — `launchctl print`).
//  • Linux: systemd user-юнит в ~/.config/systemd/user, `systemctl --user enable --now`
//    (uninstall — `disable --now`, status — `is-active`); enable-linger для старта на
//    загрузке без активной сессии. Диспетчеризация по process.platform.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

const execFileAsync = util.promisify(execFile);

/** Label LaunchAgent'а (одновременно — служебное имя в launchd gui/$UID/<label>). */
export const SERVICE_LABEL = 'dev.termhub.agent';

/** Путь к plist в ~/Library/LaunchAgents. */
export function plistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
}

/** Путь к общему логу stdout/stderr агента. */
export function logPath(): string {
  return path.join(os.homedir(), 'Library', 'Logs', 'termhub.log');
}

/** Абсолютный путь к bin/termhub.js — вычисляется от расположения ЭТОГО модуля
 *  (dist/service.js), а не от cwd: dist/service.js → ../../bin/termhub.js → <пакет>/bin/termhub.js. */
export function binPath(): string {
  return path.resolve(fileURLToPath(import.meta.url), '../../bin/termhub.js');
}

/** Экранирует спецсимволы XML в текстовых узлах plist. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Входные данные для генерации plist (чистая функция — без обращений к файловой системе). */
export interface BuildPlistOpts {
  /** Путь к бинарю node (process.execPath). */
  execPath: string;
  /** Абсолютный путь к bin/termhub.js. */
  binPath: string;
  /** Абсолютный путь к лог-файлу (используется и для stdout, и для stderr). */
  logPath: string;
  /** Домашний каталог — WorkingDirectory агента. */
  home: string;
  /** PATH окружения на момент установки: launchd даёт процессам голый
   *  /usr/bin:/bin:/usr/sbin:/sbin, в котором нет Homebrew-tmux. */
  path: string;
  /** UTF-8 локаль для агента: без LANG tmux считает локаль не-UTF8 и заменяет
   *  табы-разделители в format-выводе на «_» — парсер списка сессий ломается. */
  lang: string;
}

/** Генерирует содержимое plist LaunchAgent. */
export function buildPlist(opts: BuildPlistOpts): string {
  const args = [opts.execPath, opts.binPath, 'start'];
  const argsXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(opts.path)}</string>
    <key>LANG</key>
    <string>${escapeXml(opts.lang)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(opts.logPath)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.home)}</string>
</dict>
</plist>
`;
}

// ── launchctl (macOS) ──────────────────────────────────────────────────────────

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Запускает launchctl (execFile — без shell) и нормализует результат: код возврата
 *  всегда число (0 при успехе), даже если сам процесс упал. */
async function launchctl(args: string[]): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync('launchctl', args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Числовой UID текущего пользователя (launchd gui/$UID). */
function currentUid(): number {
  if (!process.getuid) {
    throw new Error('process.getuid unavailable: `termhub service` works only on macOS.');
  }
  return process.getuid();
}

/** Статус сервиса по коду возврата и выводу `launchctl print`. */
export type ServiceStatus = 'running' | 'loaded' | 'not-installed';

/** Разбирает результат `launchctl print gui/$UID/<label>` в статус сервиса. */
export function parseStatus(exitCode: number, stdout: string): ServiceStatus {
  if (exitCode !== 0) return 'not-installed';
  return /state = running/.test(stdout) ? 'running' : 'loaded';
}

// ── Подкоманды (macOS / launchd) ─────────────────────────────────────────────

async function macInstallCommand(): Promise<number> {
  const plist = plistPath();
  const log = logPath();
  const content = buildPlist({
    execPath: process.execPath,
    binPath: binPath(),
    logPath: log,
    home: os.homedir(),
    path: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    lang: process.env.LANG ?? 'en_US.UTF-8',
  });

  try {
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(plist, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write LaunchAgent (${plist}): ${message}`);
    return 1;
  }

  const result = await launchctl(['bootstrap', `gui/${currentUid()}`, plist]);
  if (result.code !== 0) {
    if (/already bootstrapped|already loaded|Input\/output error/i.test(result.stderr)) {
      console.error(
        `The service appears to be already installed (${SERVICE_LABEL}). To reinstall, first run: termhub service uninstall`,
      );
    } else {
      console.error(`launchctl bootstrap failed: ${result.stderr.trim() || `code ${result.code}`}`);
    }
    return 1;
  }

  console.log(`✓ LaunchAgent installed: ${plist}`);
  console.log(`  Log: ${log}`);
  console.log('  The agent will start at login and restart on crash (KeepAlive).');
  console.log('  Stop and disable autostart: termhub service uninstall');
  return 0;
}

/** true, если ошибка bootout означает «сервис и так не зарегистрирован в launchd»
 *  (не настоящая ошибка — просто нечего снимать). */
export function isNotFoundError(stderr: string): boolean {
  return /No such process|Could not find|not found/i.test(stderr);
}

async function macUninstallCommand(): Promise<number> {
  const result = await launchctl(['bootout', `gui/${currentUid()}/${SERVICE_LABEL}`]);
  if (result.code !== 0 && !isNotFoundError(result.stderr)) {
    console.error(`launchctl bootout failed: ${result.stderr.trim() || `code ${result.code}`}`);
    console.error('The service is still registered in launchd; the plist was not removed.');
    return 1;
  }

  const plist = plistPath();
  if (fs.existsSync(plist)) fs.rmSync(plist);
  console.log(`✓ LaunchAgent removed: ${plist}`);
  return 0;
}

async function macStatusCommand(): Promise<number> {
  const result = await launchctl(['print', `gui/${currentUid()}/${SERVICE_LABEL}`]);
  const status = parseStatus(result.code, result.stdout);
  if (status === 'running') {
    console.log(`Service is running (${SERVICE_LABEL}).`);
    return 0;
  }
  if (status === 'loaded') {
    console.log(`Service is loaded but not running (${SERVICE_LABEL}).`);
    return 0;
  }
  console.log('Service is not installed. Install with: termhub service install');
  return 1;
}

// ── systemd --user (Linux) ─────────────────────────────────────────────────────

/** Путь к user-юниту systemd (~/.config/systemd/user/<label>.service). */
export function systemdUnitPath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`);
}

/** Экранирует значение для unit-файла: спецификатор systemd «%», кавычка, бэкслеш; берёт в кавычки
 *  (пути/PATH со спецсимволами не должны ломать ExecStart/Environment). */
function sdQuote(v: string): string {
  return '"' + v.replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Входные данные генерации unit (чистая функция — без ФС). */
export interface BuildUnitOpts {
  /** Путь к node (process.execPath). */
  execPath: string;
  /** Абсолютный путь к bin/termhub.js. */
  binPath: string;
  /** Домашний каталог — WorkingDirectory. */
  home: string;
  /** PATH на момент установки: у systemd user-сервиса свой скудный PATH без tmux/claude. */
  path: string;
  /** UTF-8 локаль: без неё tmux портит табы-разделители в format-выводе (парсер списка ломается). */
  lang: string;
}

/** Генерирует содержимое systemd user-юнита. Логи — в journald (journalctl --user). */
export function buildUnit(opts: BuildUnitOpts): string {
  return `[Unit]
Description=TermHub agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${sdQuote(opts.execPath)} ${sdQuote(opts.binPath)} start
Restart=on-failure
RestartSec=2
WorkingDirectory=${sdQuote(opts.home)}
Environment=${sdQuote(`PATH=${opts.path}`)}
Environment=${sdQuote(`LANG=${opts.lang}`)}

[Install]
WantedBy=default.target
`;
}

/** Запускает systemctl --user (execFile — без shell), нормализует результат. */
async function systemctl(args: string[]): Promise<CmdResult> {
  try {
    const { stdout, stderr } = await execFileAsync('systemctl', args);
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const code = typeof e.code === 'number' ? e.code : 1;
    return { code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** Статус по наличию unit-файла и выводу `systemctl --user is-active`. */
export function parseSystemdStatus(unitExists: boolean, isActiveOut: string): ServiceStatus {
  if (!unitExists) return 'not-installed';
  return isActiveOut.trim() === 'active' ? 'running' : 'loaded';
}

async function linuxInstallCommand(): Promise<number> {
  const unit = systemdUnitPath();
  const content = buildUnit({
    execPath: process.execPath,
    binPath: binPath(),
    home: os.homedir(),
    path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    lang: process.env.LANG ?? 'C.UTF-8', // на Linux C.UTF-8 гарантированно доступна и UTF-8
  });

  try {
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Failed to write systemd unit (${unit}): ${message}`);
    return 1;
  }

  await systemctl(['--user', 'daemon-reload']);
  const enable = await systemctl(['--user', 'enable', '--now', SERVICE_LABEL]);
  if (enable.code !== 0) {
    console.error(`systemctl --user enable failed: ${enable.stderr.trim() || `code ${enable.code}`}`);
    console.error('  A user systemd instance is required (logind session / XDG_RUNTIME_DIR set).');
    return 1;
  }

  // enable-linger: агент стартует на загрузке и живёт без активной сессии (headless-сервер).
  const user = os.userInfo().username;
  const linger = await execFileAsync('loginctl', ['enable-linger', user]).then(
    () => true,
    () => false,
  );

  console.log(`✓ systemd user service installed: ${unit}`);
  console.log(`  Logs: journalctl --user -u ${SERVICE_LABEL} -f`);
  console.log('  The agent starts at boot and restarts on crash (Restart=on-failure).');
  if (!linger) {
    console.log('  ⚠ Could not enable lingering (needed to autostart at boot without login).');
    console.log(`    Run manually: sudo loginctl enable-linger ${user}`);
  }
  console.log('  Stop and disable autostart: termhub service uninstall');
  return 0;
}

async function linuxUninstallCommand(): Promise<number> {
  const disable = await systemctl(['--user', 'disable', '--now', SERVICE_LABEL]);
  const unit = systemdUnitPath();
  if (fs.existsSync(unit)) fs.rmSync(unit);
  await systemctl(['--user', 'daemon-reload']);
  // «не загружен/не найден» — не ошибка (нечего снимать); иное просто сообщаем.
  if (disable.code !== 0 && !/not loaded|not found|No such file|does not exist/i.test(disable.stderr)) {
    console.error(`systemctl --user disable reported: ${disable.stderr.trim() || `code ${disable.code}`}`);
  }
  console.log(`✓ systemd user service removed: ${unit}`);
  console.log(`  Note: user lingering (if enabled) left as-is — disable with: sudo loginctl disable-linger ${os.userInfo().username}`);
  return 0;
}

async function linuxStatusCommand(): Promise<number> {
  const unitExists = fs.existsSync(systemdUnitPath());
  const active = await systemctl(['--user', 'is-active', SERVICE_LABEL]);
  const status = parseSystemdStatus(unitExists, active.stdout);
  if (status === 'running') {
    console.log(`Service is running (${SERVICE_LABEL}).`);
    return 0;
  }
  if (status === 'loaded') {
    console.log(`Service is installed but not running (${SERVICE_LABEL}). Logs: journalctl --user -u ${SERVICE_LABEL}`);
    return 0;
  }
  console.log('Service is not installed. Install with: termhub service install');
  return 1;
}

// ── Диспетчер ──────────────────────────────────────────────────────────────────

/** Точка входа команды `termhub service install|uninstall|status` (macOS + Linux). */
export async function serviceCommand(args: string[]): Promise<number> {
  const impl =
    process.platform === 'darwin'
      ? { install: macInstallCommand, uninstall: macUninstallCommand, status: macStatusCommand }
      : process.platform === 'linux'
        ? { install: linuxInstallCommand, uninstall: linuxUninstallCommand, status: linuxStatusCommand }
        : null;
  if (!impl) {
    console.error('The `termhub service` command is supported on macOS (launchd) and Linux (systemd --user).');
    return 1;
  }
  const sub = args[0];
  if (sub === 'install') return impl.install();
  if (sub === 'uninstall') return impl.uninstall();
  if (sub === 'status') return impl.status();
  console.error('Usage: termhub service install|uninstall|status');
  return 1;
}
