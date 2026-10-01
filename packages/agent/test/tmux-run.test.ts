// Модуль существует ради одного различения: «сервера tmux нет» — это пустой список
// сессий, а всё прочее — сбой, который обязан уйти наверх. Поэтому тут и проверяется
// ровно оно: сперва на формах ошибок, потом на живом tmux, который эти формы печатает.

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { runTmux, isNoServerError } from '../src/tmux-run.js';

/** Отказ tmux в том виде, в каком его отдаёт execFile: код выхода и stderr. */
function failure(stderr: string, code: unknown = 1): Error {
  return Object.assign(new Error('tmux failed'), { code, stderr });
}

describe('isNoServerError', () => {
  it('«no server running» с кодом 1 — сервера нет', () => {
    expect(isNoServerError(failure('no server running on /tmp/tmux-501/termhub-test\n'))).toBe(true);
  });

  it('«error connecting … (No such file or directory)» с кодом 1 — сервера нет', () => {
    expect(isNoServerError(failure('error connecting to /tmp/tmux-501/x (No such file or directory)\n'))).toBe(true);
  });

  it('чужая ошибка tmux с кодом 1 — не «сервера нет»', () => {
    expect(isNoServerError(failure("can't find session: main\n"))).toBe(false);
    expect(isNoServerError(failure('unknown option -- Q\n'))).toBe(false);
    expect(isNoServerError(failure('duplicate session: main\n'))).toBe(false);
  });

  it('то же сообщение при другом исходе вызова — не «сервера нет»', () => {
    // Убитый по таймауту вызов приходит вовсе без кода выхода, а в stderr к тому моменту
    // успевает попасть что угодно: одного текста для ответа «сессий нет» мало.
    const killed = Object.assign(new Error('tmux killed'), {
      killed: true,
      signal: 'SIGTERM',
      stderr: 'no server running on /tmp/tmux-501/termhub-test\n',
    });
    expect(isNoServerError(killed)).toBe(false);
    expect(isNoServerError(failure('no server running\n', 2))).toBe(false);
  });

  it('сбой без stderr (самого tmux нет) — не «сервера нет»', () => {
    expect(isNoServerError(Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }))).toBe(false);
    expect(isNoServerError(new Error('boom'))).toBe(false);
  });
});

/** Доступен ли tmux в песочнице (иначе describe пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

describe.skipIf(!tmuxAvailable)('runTmux — реальный tmux (изолированный сокет)', () => {
  // Свой сокет на прогон: на «termhub» и на сокете по умолчанию живут сессии владельца.
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;

  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // сервер мог не подниматься — не ошибка
    }
  });

  it('сокета нет → отказ, который распознаётся как «сервера нет»', async () => {
    const err = await runTmux(['list-sessions'], { socketName }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect(isNoServerError(err)).toBe(true);
  });

  it('сервер поднят → stdout вызова; ошибка живого сервера — не «сервера нет»', async () => {
    await runTmux(['new-session', '-d', '-s', 'probe'], { socketName });
    expect(await runTmux(['list-sessions', '-F', '#{session_name}'], { socketName })).toBe('probe\n');

    const err = await runTmux(['kill-session', '-t', '=absent'], { socketName }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeDefined();
    expect(isNoServerError(err)).toBe(false);
    // stderr доезжает до вызывающего — на нём и держится всё различение.
    expect(String((err as { stderr?: unknown }).stderr)).toMatch(/absent/);
  });
});
