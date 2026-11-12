// Единственная форма запуска tmux в агенте: execFile без оболочки (аргументы уходят
// массивом, подстановки команд не бывает), изолированный сокет через «-L» и общее
// распознавание «сервера нет». Форма была написана дважды — в sessions.ts и в определителе
// транскриптов — и при первой же правке разъехалась бы: одна сторона чинила бы предел
// вывода, другая — разбор stderr.

import { execFile } from 'node:child_process';

/** Отказ tmux: exit-код и stderr — по ним и отличается «сервера нет» от настоящего сбоя. */
export interface TmuxError extends Error {
  code?: number | string;
  stderr?: string;
}

/** Потолок вывода: list-panes на живом сервере не приближается к нему и близко, а без
 *  предела вывод чужого процесса стал бы неограниченным буфером в памяти агента. */
const MAX_BUFFER = 4 * 1024 * 1024;

/** Что tmux печатает, когда сервера нет: «no server running on <сокет>», а при мёртвом
 *  сокете — «error connecting to <сокет> (No such file or directory)». */
const NO_SERVER_RE = /no server running|error connecting|no such file or directory/i;

/** «Сервера нет» — не сбой, а пустой список: сессий ещё (или уже) не существует.
 *  Признак — exit 1 ВМЕСТЕ с одним из сообщений tmux: одного текста мало, под него
 *  попадает и убитый по таймауту вызов, и чужая ошибка, упомянувшая файл. */
export function isNoServerError(err: unknown): boolean {
  const e = err as TmuxError;
  const stderr = typeof e.stderr === 'string' ? e.stderr : '';
  return e.code === 1 && NO_SERVER_RE.test(stderr);
}

export interface TmuxRunOptions {
  /** Сокет tmux; без него — сокет по умолчанию. */
  socketName?: string;
  /** Предел ожидания; 0 (по умолчанию) — ждать сколько понадобится. */
  timeoutMs?: number;
}

/** Предел текста причины: stderr чужого процесса в ответ клиенту целиком не едет. */
const REASON_LIMIT = 200;

/** Причина сбоя запуска словами. Сообщение `execFile` («Command failed: <вся командная
 *  строка>») сюда не попадает никогда: в аргументах tmux едет ввод пользователя, и вместе
 *  с сообщением он оказался бы в логе и на экране клиента. Берётся первая строка stderr,
 *  без неё — срок, сигнал или код выхода. */
export function failureReason(err: unknown): string {
  const e = err as TmuxError & { killed?: boolean; signal?: string | null; cmd?: string };
  const line = (typeof e?.stderr === 'string' ? e.stderr : '')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '');
  if (line) return line.slice(0, REASON_LIMIT);
  if (e?.killed) return 'timed out';
  if (typeof e?.signal === 'string' && e.signal !== '') return `killed by ${e.signal}`;
  if (e?.code === 'ENOENT') return 'tmux is not installed';
  if (e?.code === 'E2BIG') return 'argument list too long';
  if (typeof e?.cmd === 'string') return `exit code ${String(e.code ?? 'unknown')}`;
  const text = err instanceof Error ? err.message : String(err);
  return text.length > REASON_LIMIT ? `${text.slice(0, REASON_LIMIT)}…` : text;
}

/** Запускает tmux и отдаёт stdout. Отказ — исключение с прикреплённым stderr: только
 *  так его потом прочитает isNoServerError. Сообщение отказа — `tmux <команда> failed:
 *  <причина>`, без аргументов: командная строка в нём не остаётся (и поле `cmd` снято). */
export function runTmux(args: string[], opts: TmuxRunOptions = {}): Promise<string> {
  const full = opts.socketName ? ['-L', opts.socketName, ...args] : args;
  return new Promise((resolve, reject) => {
    const options = { encoding: 'utf8' as const, maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 0 };
    execFile('tmux', full, options, (err, stdout, stderr) => {
      if (err) {
        const failure = err as TmuxError & { cmd?: string };
        failure.stderr = stderr;
        failure.message = `tmux ${args.find((arg) => !arg.startsWith('-')) ?? ''} failed: ${failureReason(failure)}`;
        delete failure.cmd;
        // Стек начинается прежним сообщением — с той же командной строкой.
        failure.stack = `${failure.name}: ${failure.message}`;
        reject(failure);
        return;
      }
      resolve(stdout);
    });
  });
}
