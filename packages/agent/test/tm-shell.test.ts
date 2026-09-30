// Живой прогон шелл-функции `tm` под POSIX sh (и под bash/zsh, если они есть) с
// подложным `tmux` в PATH: скрипт отдаёт «занятые» имена как `list-sessions -F
// '#{session_name}'` (файл, по имени на строку; пустой файл = сервер не запущен) и
// логирует каждый вызов — по одному аргументу на строку. Живой tmux здесь не нужен —
// attach потребовал бы tty, а правило именования видно по тому, что `tm` спросил и что
// создал (`new`). Настоящий сокет `termhub` и дефолтный сервер tmux не затрагиваются.
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tmFunction } from '../src/setup.js';

const SOCKET = 'termhub-test-tm';
// Строка-разделитель вызовов в логе: за ней — аргументы вызова, по одному на строку.
const CALL = '#call';

// Подложный tmux: `-L <сокет>` пропускается; `list-sessions -F '#{session_name}'`
// печатает файл занятых имён (пустой → «no server running», exit 1, как у tmux без
// сервера); `new` всегда успешен; всё остальное — exit 2.
const FAKE_TMUX = `#!/bin/sh
printf '%s\\n' '${CALL}' "$@" >> "$TH_LOG"
if [ "$1" = -L ]; then shift 2; fi
case "$1" in
  list-sessions)
    [ "$2" = -F ] || exit 2
    [ -s "$TH_TAKEN" ] || { echo 'no server running' >&2; exit 1; }
    if [ "$3" = '#{session_name}' ]; then cat "$TH_TAKEN"
    else awk '{ printf "$%d\\t%s\\n", NR, $0 }' "$TH_TAKEN"; fi
    ;;
  new|attach) exit 0 ;;
  *) exit 2 ;;
esac
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-tm-'));
const bin = path.join(tmp, 'bin');
const logFile = path.join(tmp, 'tmux.log');
const takenFile = path.join(tmp, 'taken');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'tmux'), FAKE_TMUX, { mode: 0o755 });

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function hasShell(shell: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${shell}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

type Call = string[];

/** Запускает `tm <args>` в каталоге `<tmp>/<folder>` (под `-e`, если `errexit`) и
 *  возвращает вызовы подложного tmux — каждый как массив аргументов. */
function runTm(
  shell: string,
  args: string,
  taken: string[],
  { folder = 'MyProject', errexit = false }: { folder?: string; errexit?: boolean } = {},
): Call[] {
  const cwd = path.join(tmp, folder);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(takenFile, taken.map((n) => `${n}\n`).join(''));
  fs.writeFileSync(logFile, '');
  execFileSync(shell, [...(errexit ? ['-e'] : []), '-c', `${tmFunction(SOCKET)}\ntm ${args}`], {
    cwd,
    env: { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, TH_LOG: logFile, TH_TAKEN: takenFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const text = fs.readFileSync(logFile, 'utf8');
  const calls: Call[] = [];
  for (const line of (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')) {
    if (line === CALL) calls.push([]);
    else if (calls.length > 0) calls[calls.length - 1]!.push(line);
  }
  return calls;
}

const LIST: Call = ['-L', SOCKET, 'list-sessions', '-F', '#{session_name}'];
const NEW = (name: string): Call => ['-L', SOCKET, 'new', '-s', name];

const shells = ['sh', 'bash', 'zsh'].filter(hasShell);

describe.each(shells)('tm под %s: нумерация имени папки через подложный tmux', (shell) => {
  it('занято MyProject → список сессий, затем new -s MyProject1', () => {
    expect(runTm(shell, '', ['MyProject'])).toEqual([LIST, NEW('MyProject1')]);
  });

  it('заняты MyProject и MyProject1 → new -s MyProject2', () => {
    expect(runTm(shell, '', ['MyProject', 'MyProject1']).at(-1)).toEqual(NEW('MyProject2'));
  });

  it('сервера нет (список пуст) → new -s MyProject, имя папки как есть', () => {
    expect(runTm(shell, '', [])).toEqual([LIST, NEW('MyProject')]);
  });

  it('под errexit (-e) отсутствие сервера не роняет оболочку: new -s MyProject', () => {
    expect(runTm(shell, '', [], { errexit: true })).toEqual([LIST, NEW('MyProject')]);
  });

  it('совпадение только дословное: заняты MyProject1 и MyProjectX → new -s MyProject', () => {
    expect(runTm(shell, '', ['MyProject1', 'MyProjectX', 'xMyProject']).at(-1)).toEqual(NEW('MyProject'));
  });

  it('папка foo.bar при занятом foo.bar → new -s foo.bar1 (точка в цели tmux — разделитель)', () => {
    expect(runTm(shell, '', ['foo.bar'], { folder: 'foo.bar' }).at(-1)).toEqual(NEW('foo.bar1'));
  });

  it('пробел в имени папки: new -s получает имя одним аргументом', () => {
    expect(runTm(shell, '', ['My Project'], { folder: 'My Project' })).toEqual([LIST, NEW('My Project1')]);
  });

  it('tm foo — создаёт отсутствующую сессию, не подключаясь к foo1', () => {
    expect(runTm(shell, 'foo', ['foo1'])).toEqual([LIST, NEW('foo')]);
  });

  it('tm foo.bar — точное подключение к существующей сессии с точкой', () => {
    expect(runTm(shell, 'foo.bar', ['foo', 'foo.bar'])).toEqual([LIST, ['-L', SOCKET, 'list-sessions', '-F', '#{session_id}\t#{session_name}'], ['-L', SOCKET, 'attach', '-t', '$2:']]);
  });
  it.each(['$1', '01', 'with space', 'проект', '[ab]*?', 'a:b'])('attaches by ID for literal name %s', (name) => {
    expect(runTm(shell, "'" + name + "'", ['1', name]).at(-1)).toEqual(['-L', SOCKET, 'attach', '-t', '$2:']);
  });
  it('escapes tmux formats when creating a literal hash name', () => {
    expect(runTm(shell, "'#hash'", []).at(-1)).toEqual(NEW('##hash'));
  });

  it('escapes a terminal command separator in a new name', () => {
    expect(runTm(shell, "'foo;'", []).at(-1)).toEqual(NEW('foo\\;'));
  });

});
