// Интерактивная команда `termhub setup`: собирает конфиг, генерирует секреты,
// по желанию дописывает ~/.tmux.conf и `tm`/`tml` в rc текущего шелла (~/.zshrc | ~/.bashrc).
// Побочные эффекты вынесены в runSetup; чистая логика (строки конфигов, парсинг)
// экспортируется отдельно и покрыта тестами.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import webpush from 'web-push';
import { initCrypto, fingerprint } from '@termhub/protocol';
import {
  configDir,
  hashPassword,
  loadIdentity,
  saveConfig,
  TMUX_SOCKET,
} from './config.js';
import type { TermhubConfig } from './config.js';

const DEFAULT_PORT = 7710;
const DEFAULT_ROOT = '~/projects';
const VAPID_SUBJECT = 'mailto:termhub@localhost';
// `tm [имя]` — присоединиться к сессии (создать при отсутствии). Имя берётся из
// аргумента, иначе — из имени текущего каталога, поэтому это функция, а не alias.
// Сокет -L TMUX_SOCKET — тот же, что использует агент (см. config.TMUX_SOCKET).
const TM_FUNCTION = `tm() { tmux -L ${TMUX_SOCKET} new -As "\${1:-\$(basename "\$PWD")}"; }`;
// `tml` — выбор сессии из списка на выделенном сокете (то же, что видит дашборд),
// `tmc` — экран закрытия сессий. Общий сбор списка вынесен в `_th_rows`/`_th_show`,
// чтобы обе команды показывали одно и то же и не разъезжались при правках.
//
// Сессии сгруппированы по рабочему каталогу: сначала группа текущего каталога,
// затем остальные по алфавиту пути. Номер выбирается вводом; при выборе сессии из
// другого каталога `tml` сперва переходит туда, иначе `tm` без аргументов в
// следующий раз создал бы сессию с именем не того каталога.
//
// Рядом с именем — заголовок панели (#{pane_title}), то же, что стоит в заголовке
// вкладки веб-интерфейса, вместе с ведущим индикатором Claude Code (брайлевый
// спиннер = работает, ✳ = ждёт реакции). Индикатор не срезаем: отдельной
// анимированной точки в статичном списке нет, и сам по себе он несёт смысл.
// Заголовок, совпавший с именем сессии, не дублируем.
//
// Звонок — из #{window_bell_flag} по окнам, тем же источником, что и у агента:
// #{session_alerts} не подходит, он не отличает звонок от активности и тишины.
// Строки B/S склеиваются в один поток, чтобы обойтись двумя вызовами tmux.
//
// Закрытие: в `tml` — отрицательным номером и только с подтверждением (туда идут
// подключаться, промах дорог), в `tmc` — просто номером, потому что экран для того
// и открыт, о чём говорит его рамка. `tmc` перечитывает список на каждом круге:
// после закрытия нумерация сдвигается, и работа по устаревшим номерам убила бы не
// ту сессию. Имя всегда с префиксом `=` — иначе tmux матчит по префиксу и `Sprut`
// попал бы в `Sprut1`.
//
// Это функции, а не алиасы: нужен и ввод, и `cd`, меняющий каталог вызывающего
// шелла (в подоболочке переход бы потерялся). Переменные с префиксом `_th_` — в
// POSIX sh нет `local`, а блок обязан работать и в bash, и в zsh.
// Разделитель — табуляция: она не встречается в путях tmux, в отличие от пробела.
// Рамка и 🔔 записаны октальными кодами UTF-8 — так блок остаётся ASCII-текстом и
// не страдает при копировании в rc-файл с другой локалью.
const TML_FUNCTION = [
  "_th_rows() {",
  "  _th_tab=$(printf '\\t')",
  `  _th_w=$(tmux -L ${TMUX_SOCKET} list-windows -a -F "#{session_name}\${_th_tab}#{window_bell_flag}" 2>/dev/null)`,
  `  _th_s=$(tmux -L ${TMUX_SOCKET} list-sessions -F "#{session_path}\${_th_tab}#{session_name}\${_th_tab}#{pane_title}" 2>/dev/null)`,
  "  [ -z \"$_th_s\" ] && return 1",
  "  { printf '%s\\n' \"$_th_w\" | sed 's/^/B/'; printf '%s\\n' \"$_th_s\" | sed 's/^/S/'; } |",
  "  awk -v tab=\"$_th_tab\" -v cur=\"$PWD\" '",
  "    BEGIN { FS = tab }",
  "    /^B/ { n = substr($1, 2); if ($2 == \"1\") bell[n] = 1; next }",
  "    /^S/ {",
  "      p = substr($1, 2); name = $2; title = $3;",
  "      label = sprintf(\"%-16s\", name);",
  "      rest = title; sub(/^[^ ]+ /, \"\", rest);",
  "      if (rest == name && title != name) label = label \"  \" substr(title, 1, index(title, \" \") - 1);",
  "      else if (title != \"\" && title != name) label = label \"  \" title;",
  "      if (bell[name]) label = label \"  \\360\\237\\224\\224\";",
  "      printf \"%d%s%s%s%s%s%s\\n\", (p == cur ? 0 : 1), tab, p, tab, name, tab, label;",
  "    }' |",
  "  sort -t\"$_th_tab\" -k1,1n -k2,2 -k3,3 | cut -f2-",
  "}",
  "_th_show() {",
  "  _th_i=0",
  "  _th_prev=",
  "  while IFS=\"$_th_tab\" read -r _th_dir _th_name _th_label; do",
  "    [ -z \"$_th_name\" ] && continue",
  "    if [ \"$_th_dir\" != \"$_th_prev\" ]; then",
  "      if [ \"$_th_dir\" = \"$PWD\" ]; then printf '\\n%s (current)\\n' \"$_th_dir\"",
  "      else printf '\\n%s\\n' \"$_th_dir\"; fi",
  "      _th_prev=$_th_dir",
  "    fi",
  "    _th_i=$((_th_i + 1))",
  "    printf '  %2d) %s\\n' \"$_th_i\" \"$_th_label\"",
  "  done <<_THEOF",
  "$1",
  "_THEOF",
  "}",
  "_th_field() { printf '%s\\n' \"$1\" | cut -f\"$2\"; }",
  "_th_kill() {",
  `  if tmux -L ${TMUX_SOCKET} kill-session -t "=$1" 2>/dev/null; then printf 'Closed %s\\n' "$1"`,
  "  else printf 'Could not close %s\\n' \"$1\"; fi",
  "}",
  "tml() {",
  "  _th_tab=$(printf '\\t')",
  "  _th_all=$(_th_rows) || { printf 'No termhub sessions.\\n'; return 0; }",
  "  _th_show \"$_th_all\"",
  "  printf '\\nSession number (-N closes, Enter cancels): '",
  "  read -r _th_pick",
  "  [ -z \"$_th_pick\" ] && return 0",
  "  _th_neg=0",
  "  case \"$_th_pick\" in -*) _th_neg=1; _th_pick=${_th_pick#-};; esac",
  "  case \"$_th_pick\" in '' | *[!0-9]*) printf 'Enter a number.\\n'; return 1;; esac",
  "  _th_sel=$(printf '%s\\n' \"$_th_all\" | sed -n \"${_th_pick}p\")",
  "  if [ -z \"$_th_sel\" ]; then printf 'No session with that number.\\n'; return 1; fi",
  "  _th_dir=$(_th_field \"$_th_sel\" 1)",
  "  _th_name=$(_th_field \"$_th_sel\" 2)",
  "  if [ \"$_th_neg\" = 1 ]; then",
  "    printf 'Close session %s? [y/N] ' \"$_th_name\"",
  "    read -r _th_yes",
  "    case \"$_th_yes\" in [yY] | [yY][eE][sS]) _th_kill \"$_th_name\";; *) printf 'Cancelled.\\n';; esac",
  "    return 0",
  "  fi",
  "  if [ \"$_th_dir\" != \"$PWD\" ]; then",
  "    cd \"$_th_dir\" || { printf 'Cannot enter %s\\n' \"$_th_dir\"; return 1; }",
  "  fi",
  "  tm \"$_th_name\"",
  "}",
  "tmc() {",
  "  _th_tab=$(printf '\\t')",
  "  while :; do",
  "    _th_all=$(_th_rows) || { printf 'No termhub sessions.\\n'; return 0; }",
  "    printf '\\n\\342\\224\\214\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\220\\n'",
  "    printf '\\342\\224\\202  Close sessions \\342\\200\\224 enter a number to close    \\342\\224\\202\\n'",
  "    printf '\\342\\224\\202  Use tml to attach to a session              \\342\\224\\202\\n'",
  "    printf '\\342\\224\\224\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\200\\342\\224\\230\\n'",
  "    _th_show \"$_th_all\"",
  "    printf '\\nNumber to close (Enter exits): '",
  "    read -r _th_pick || return 0",
  "    [ -z \"$_th_pick\" ] && return 0",
  "    case \"$_th_pick\" in *[!0-9]*) printf 'Enter a number.\\n'; continue;; esac",
  "    _th_sel=$(printf '%s\\n' \"$_th_all\" | sed -n \"${_th_pick}p\")",
  "    if [ -z \"$_th_sel\" ]; then printf 'No session with that number.\\n'; continue; fi",
  "    _th_kill \"$(_th_field \"$_th_sel\" 2)\"",
  "  done",
  "}",
].join('\n');

/** Строки, которые setup добавляет в ~/.tmux.conf (только отсутствующие). */
export const TMUX_CONF_LINES = [
  'set -g mouse on',
  'set -g window-size latest',
  'set -g history-limit 50000',
  'set -g monitor-bell on',
  'set -g default-terminal "tmux-256color"',
  // Focus-events: tmux сообщает приложениям (vim и пр.) о фокусе/расфокусе окна
  // терминала — нужно для focus-tracking внутри сессий (в т.ч. в web-терминале).
  'set -g focus-events on',
  // Проброс заголовка (OSC 0/2 из приложения → pane title #T) во внешний
  // терминал — иначе вкладка IDEA/iTerm не переименовывается внутри tmux.
  'set -g set-titles on',
  'set -g set-titles-string "#T"',
  // Отзывчивость и цвет.
  'set -s escape-time 10', // ESC без 500мс-задержки — vim/TUI не «тупят» по сети
  'set -as terminal-features ",*:RGB"', // truecolor для приложений внутри tmux
  // Эргономика клиента (телефон/браузер, мульти-девайс).
  'set -g status-position top', // статус-бар наверх (снизу на телефоне клавиатура/жесты)
  'set -g set-clipboard on', // копирование из сессии → буфер OS через OSC 52
  'setw -g aggressive-resize on', // размер окна под активного клиента, а не под самого мелкого
  // Нумерация окон/панелей с 1 и без дыр.
  'set -g base-index 1',
  'setw -g pane-base-index 1',
  'set -g renumber-windows on',
  // Статус-бар: приглушённый тёмный фон + светлый читаемый текст вместо
  // ярко-зелёного дефолта (палитра Nord). Точные оттенки — за счёт truecolor.
  "set -g status-style 'bg=#2e3440 fg=#d8dee9'",
  "set -g window-status-current-style 'bg=#4c566a fg=#eceff4 bold'", // активное окно
  "set -g window-status-style 'fg=#9aa2b1'", // неактивные окна приглушённо
  "set -g window-status-activity-style 'fg=#ebcb8b'", // флаг активности — тёплый акцент
  "set -g message-style 'bg=#4c566a fg=#eceff4'", // строка команд/сообщений
];

/** Строки из TMUX_CONF_LINES, которых ещё нет в существующем содержимом. */
export function missingTmuxLines(existing: string): string[] {
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  return TMUX_CONF_LINES.filter((l) => !present.has(l));
}

/** Маркер-комментарий блока termhub в ~/.zshrc. */
export const ZSH_MARKER = '# termhub';

/** Блок для ~/.zshrc: маркер + функции tm и tml. */
export function zshAliasBlock(): string {
  return `${ZSH_MARKER}\n${TM_FUNCTION}\n${TML_FUNCTION}\n`;
}

/** Есть ли уже блок termhub в rc-файле. */
export function hasZshMarker(existing: string): boolean {
  return existing.split('\n').some((l) => l.trim() === ZSH_MARKER);
}

/** rc-файл для алиасов по текущему шеллу ($SHELL). zsh → ~/.zshrc; bash и прочее → ~/.bashrc.
 *  Синтаксис блока (функции tm и tml) POSIX-совместим — годится и для bash, и для zsh. */
export function shellRcFile(shell: string | undefined, home: string): { path: string; label: string } {
  const name = (shell ?? '').split('/').pop() ?? '';
  if (name === 'zsh') return { path: path.join(home, '.zshrc'), label: '~/.zshrc' };
  return { path: path.join(home, '.bashrc'), label: '~/.bashrc' };
}

/** Разворачивает ведущий ~ в домашний каталог. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Парсит ввод корней сессий (через запятую) с разворотом ~; пустой ввод — fallback. */
export function parseSessionRoots(input: string, fallback: string): string[] {
  const raw = input.trim().length > 0 ? input : fallback;
  return raw
    .split(',')
    .map((s) => expandHome(s.trim()))
    .filter((s) => s.length > 0);
}

/** Корни, которые не абсолютны после разворота ~ — setup их переспрашивает:
 *  относительный путь зависит от cwd агента и в dirs() даёт ENOENT. */
export function relativeRoots(roots: string[]): string[] {
  return roots.filter((r) => !path.isAbsolute(r));
}

/** Дописывает недостающие строки в файл, аккуратно добавляя перевод строки перед блоком. */
function appendToFile(file: string, block: string): void {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, prefix + block);
}

async function askRequired(rl: readline.Interface, prompt: string): Promise<string> {
  for (;;) {
    const value = (await rl.question(prompt)).trim();
    if (value.length > 0) return value;
    console.log('Value is required, try again.');
  }
}

async function askNumber(rl: readline.Interface, label: string, def: number): Promise<number> {
  const raw = (await rl.question(`${label} [${def}]: `)).trim();
  if (raw.length === 0) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}

async function askYesNo(rl: readline.Interface, prompt: string, def: boolean): Promise<boolean> {
  const hint = def ? 'Y/n' : 'y/N';
  const raw = (await rl.question(`${prompt} [${hint}]: `)).trim().toLowerCase();
  if (raw.length === 0) return def;
  return raw === 'y' || raw === 'yes' || raw === 'д' || raw === 'да';
}

async function maybePatchTmux(rl: readline.Interface): Promise<void> {
  const file = path.join(os.homedir(), '.tmux.conf');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = missingTmuxLines(existing);
  if (missing.length === 0) {
    console.log('~/.tmux.conf: all required lines are already present.');
    return;
  }
  console.log('\n~/.tmux.conf is missing lines:');
  for (const line of missing) console.log('  ' + line);
  if (!(await askYesNo(rl, 'Append them?', true))) return;
  appendToFile(file, missing.join('\n') + '\n');
  console.log('✓ ~/.tmux.conf updated.');
}

async function maybePatchShellRc(rl: readline.Interface): Promise<void> {
  const { path: file, label } = shellRcFile(process.env.SHELL, os.homedir());
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (hasZshMarker(existing)) {
    console.log(`${label}: tm alias already configured (marker # termhub).`);
    return;
  }
  // Полное тело tml длинное — в предложении показываем только назначение, сам блок
  // всё равно записывается целиком.
  console.log(`\nSuggested additions to ${label}:\n  ${TM_FUNCTION}\n  tml() { ... }  # pick a session, grouped by directory`);
  if (!(await askYesNo(rl, 'Add?', true))) return;
  appendToFile(file, zshAliasBlock());
  console.log(`✓ ${label} updated (restart your shell or run \`source ${label}\`).`);
}

/** Предупреждает, что агент слушает HTTP без шифрования: пароль и cookie идут по
 *  LAN в открытом виде. Осознанный компромисс v1 — но пользователь должен знать. */
export function warnCleartextHttp(host: string, port: number): void {
  console.warn(
    `\n⚠ TermHub is serving HTTP without encryption on ${host}:${port}. Password and cookie are sent\n` +
      '  over the local network in cleartext. For access outside a trusted LAN, enable TLS\n' +
      '  (docs/notifications.md: mkcert / tailscale cert) or use relay/Tailscale.',
  );
}

/** Интерактивная настройка агента. */
export async function runSetup(): Promise<void> {
  await initCrypto();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('TermHub — initial agent setup.\n');

    const password = await askRequired(rl, 'Password for the web interface (LAN): ');
    const port = await askNumber(rl, 'Agent port', DEFAULT_PORT);
    let sessionRoots: string[] = [];
    for (;;) {
      const rootsInput = await rl.question(`Session directory roots (comma-separated) [${DEFAULT_ROOT}]: `);
      sessionRoots = parseSessionRoots(rootsInput, DEFAULT_ROOT);
      const relative = relativeRoots(sessionRoots);
      if (relative.length === 0) break;
      console.log(`Absolute paths required (or with a leading ~): ${relative.join(', ')}`);
    }
    for (const root of sessionRoots) {
      if (!fs.existsSync(root)) console.warn(`⚠ Directory does not exist: ${root}`);
    }
    const relayInput = (await rl.question('Relay URL for external access (Enter to skip): ')).trim();
    const relayUrl = relayInput.length > 0 ? relayInput : null;

    const vapid = webpush.generateVAPIDKeys();
    const config: TermhubConfig = {
      port,
      host: '0.0.0.0',
      passwordHash: hashPassword(password),
      cookieSecret: crypto.randomBytes(32).toString('hex'),
      sessionRoots,
      tls: null,
      relayUrl,
      vapid: { publicKey: vapid.publicKey, privateKey: vapid.privateKey, subject: VAPID_SUBJECT },
      locale: null,
    };
    saveConfig(config);
    const identity = loadIdentity();

    console.log(`\n✓ Config saved: ${configDir()}`);
    console.log(`  Agent fingerprint: ${fingerprint(identity.edPub)}`);

    if (!config.tls) warnCleartextHttp(config.host, config.port);

    await maybePatchTmux(rl);
    await maybePatchShellRc(rl);

    console.log('\nDone. Start the agent: termhub start');
  } finally {
    rl.close();
  }
}
