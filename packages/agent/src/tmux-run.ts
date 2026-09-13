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

/** Запускает tmux и отдаёт stdout. Отказ — исключение с прикреплённым stderr: только
 *  так его потом прочитает isNoServerError. */
export function runTmux(args: string[], opts: TmuxRunOptions = {}): Promise<string> {
  const full = opts.socketName ? ['-L', opts.socketName, ...args] : args;
  return new Promise((resolve, reject) => {
    const options = { encoding: 'utf8' as const, maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 0 };
    execFile('tmux', full, options, (err, stdout, stderr) => {
      if (err) {
        (err as TmuxError).stderr = stderr;
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}
