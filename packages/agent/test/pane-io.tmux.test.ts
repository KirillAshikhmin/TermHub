// Шов: одноразовые чтение экрана и ввод на НАСТОЯЩЕМ tmux, на своём сокете
// (-L termhub-test-<uniq>, kill-server в teardown). В панели — не агент, а скрипт,
// который пишет в файл каждый полученный байт: по файлу и видно, что именно дошло.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { capturePane, PASTE_LIMIT, pasteText, sendKeys, clearBell } from '../src/pane-io.js';
import { runTmux } from '../src/tmux-run.js';
import { killTmuxServer } from './tmux-socket.js';

let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

/** Программа панели: сырой ввод, включённый bracketed paste, каждый кусок ввода —
 *  строкой hex в файл. */
const ECHO_JS = `
const fs = require('node:fs');
const out = process.argv[2];
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?2004h');
process.stdout.write('\\x1b[31mREADY\\x1b[0m\\r\\nsecond line\\r\\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(out, chunk.toString('hex') + '\\n'));
setInterval(() => {}, 1000);
`;

describe.skipIf(!tmuxAvailable)('pane-io — экран и ввод на настоящем tmux', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  const session = 'paneio';
  const altSession = 'paneio-alt';
  let dir: string;
  let received: string;

  function tmux(args: string[]): string {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`не дождались: ${what}`);
  }

  /** Всё, что получила программа панели, одной hex-строкой. */
  function receivedHex(): string {
    return fs.existsSync(received) ? fs.readFileSync(received, 'utf8').replace(/\n/g, '') : '';
  }

  function windowSize(name: string): string {
    return tmux(['display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}']).trim();
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-paneio-'));
    received = path.join(dir, 'received.hex');
    const script = path.join(dir, 'echo.cjs');
    fs.writeFileSync(script, ECHO_JS);
    tmux(['-f', '/dev/null', 'new-session', '-d', '-s', session, '-x', '100', '-y', '30', process.execPath, script, received]);
    tmux(['new-session', '-d', '-s', altSession, '-x', '80', '-y', '24', 'sh', '-c', "printf '\\033[?1049hALT SCREEN'; sleep 600"]);
    await waitFor(() => tmux(['capture-pane', '-p', '-t', `=${session}:`]).includes('READY'), 'программа панели готова');
    await waitFor(() => tmux(['capture-pane', '-p', '-t', `=${altSession}:`]).includes('ALT SCREEN'), 'альтернативный экран');
  });

  afterAll(() => {
    try {
      killTmuxServer(socketName);
    } catch {
      /* сервер уже завершён */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('отдаёт строки видимого экрана с оформлением, размер, адрес панели и обычный буфер', async () => {
    const shot = await capturePane(session, socketName);
    const [width, height] = tmux(['list-panes', '-t', `=${session}:`, '-F', '#{pane_width} #{pane_height}'])
      .trim()
      .split(' ')
      .map(Number);
    expect(shot.cols).toBe(width);
    expect(shot.rows).toBe(height);
    expect(shot.lines).toHaveLength(height!);
    expect(shot.lines[0]).toContain('READY');
    expect(shot.lines[0]).toContain('\x1b[31m');
    expect(shot.lines[1]).toBe('second line');
    expect(shot.alt).toBe(false);
    expect(shot.pane).toMatch(/^paneio:@\d+\.%\d+$/);
    expect(shot.command).not.toBe('');
  });

  it('называет альтернативный буфер и снимает его экран', async () => {
    const shot = await capturePane(altSession, socketName);
    expect(shot.alt).toBe(true);
    expect(shot.lines[0]).toContain('ALT SCREEN');
  });

  it('на несуществующей сессии — отказ, а не пустой экран', async () => {
    await expect(capturePane('no-such-session', socketName)).rejects.toThrow(/no-such-session/);
    await expect(sendKeys('no-such-session', socketName, Uint8Array.of(0x61))).rejects.toThrow();
  });

  it('sendKeys доводит байты до программы в панели', async () => {
    const before = receivedHex().length;
    await sendKeys(session, socketName, Uint8Array.of(0x68, 0x69, 0x1b, 0x5b, 0x5a));
    await waitFor(() => receivedHex().length >= before + 10, 'байты клавиш');
    expect(receivedHex().slice(before)).toBe('68691b5b5a');
  });

  it('sendKeys с адресом панели из снимка шлёт в неё же', async () => {
    const shot = await capturePane(session, socketName);
    const before = receivedHex().length;
    await sendKeys(session, socketName, Uint8Array.of(0x7a), shot.pane);
    await waitFor(() => receivedHex().length >= before + 2, 'байт клавиши');
    expect(receivedHex().slice(before)).toBe('7a');
  });

  it('pasteText: текст с переносами приходит одной вставкой, управляющие байты выброшены', async () => {
    const before = receivedHex().length;
    await pasteText(session, socketName, 'line one\nline \x1b[201~two\r\nтри');
    const expected =
      Buffer.from('\x1b[200~', 'utf8').toString('hex') +
      Buffer.from('line one\rline [201~two\rтри', 'utf8').toString('hex') +
      Buffer.from('\x1b[201~', 'utf8').toString('hex');
    await waitFor(() => receivedHex().length >= before + expected.length, 'вставка');
    expect(receivedHex().slice(before)).toBe(expected);
  });

  /** Текст ровно в `bytes` байтов UTF-8: кириллица, эмодзи и переносы строк. */
  function bigText(bytes: number): string {
    const line = 'строка запроса — line of the request 🚀 знаки ё и 👩‍💻\n';
    const size = Buffer.byteLength(line);
    const text = line.repeat(Math.floor(bytes / size));
    return text + 'x'.repeat(bytes - Buffer.byteLength(text));
  }

  for (const [label, bytes] of [
    ['4 КиБ', 4 * 1024],
    ['20 КиБ', 20 * 1024],
    ['64 КиБ (предел вставки)', PASTE_LIMIT - 12],
  ] as const) {
    it(`pasteText: текст ${label} доходит целиком и одной вставкой`, async () => {
      const text = bigText(bytes);
      expect(Buffer.byteLength(text)).toBe(bytes);
      const before = receivedHex().length;
      await pasteText(session, socketName, text);
      const expected = Buffer.from(`\x1b[200~${text.replace(/\n/g, '\r')}\x1b[201~`, 'utf8').toString('hex');
      await waitFor(() => receivedHex().length >= before + expected.length, `вставка ${label}`);
      const got = receivedHex().slice(before);
      expect(got.length).toBe(expected.length);
      expect(got === expected).toBe(true);
    });
  }

  it('pasteText: сверх предела вставки — отказ, в панель ничего не уходит', async () => {
    const before = receivedHex().length;
    await expect(pasteText(session, socketName, bigText(PASTE_LIMIT))).rejects.toThrow(/too long to paste/);
    await sendKeys(session, socketName, Uint8Array.of(0x79));
    await waitFor(() => receivedHex().length >= before + 2, 'байт после отказа');
    expect(receivedHex().slice(before)).toBe('79');
  });

  it('sendKeys: байтов больше, чем помещается в одну команду tmux, доходят все и по порядку', async () => {
    const bytes = new Uint8Array(9000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = 0x61 + (i % 26);
    const before = receivedHex().length;
    await sendKeys(session, socketName, bytes);
    const expected = Buffer.from(bytes).toString('hex');
    await waitFor(() => receivedHex().length >= before + expected.length, 'байты клавиш');
    expect(receivedHex().slice(before) === expected).toBe(true);
  });

  it('pasteText: обрыв на втором куске — отказ, а вставка всё равно закрыта', async () => {
    const text = bigText(8 * 1024);
    const before = receivedHex().length;
    let calls = 0;
    const flaky: typeof runTmux = (args, opts) => {
      if (args[0] === 'send-keys' && ++calls === 2) {
        return Promise.reject(new Error('tmux send-keys failed: server exited unexpectedly'));
      }
      return runTmux(args, opts);
    };
    await expect(pasteText(session, socketName, text, undefined, flaky)).rejects.toThrow(/server exited unexpectedly/);
    expect(calls).toBe(3);
    const open = Buffer.from('\x1b[200~').toString('hex');
    const close = Buffer.from('\x1b[201~').toString('hex');
    await waitFor(() => receivedHex().slice(before).endsWith(close), 'закрывающая скобка вставки');
    const got = receivedHex().slice(before);
    const whole = Buffer.from(text.replace(/\n/g, '\r'), 'utf8').toString('hex');
    expect(got.startsWith(open)).toBe(true);
    const part = got.slice(open.length, -close.length);
    expect(part.length).toBeGreaterThan(0);
    expect(part.length).toBeLessThan(whole.length);
    expect(whole.startsWith(part)).toBe(true);
  });

  it('отказ tmux назван словами: ни командной строки, ни отправленных байтов в сообщении', async () => {
    const hex = new Array<string>(600).fill('d0');
    const err = await runTmux(['send-keys', '-t', '%987654', '-H', ...hex], { socketName }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/^tmux send-keys failed: /);
    expect(err!.message).toContain("can't find pane");
    expect(err!.message).not.toContain('d0 d0');
    expect(err!.message).not.toContain('-H');
    expect(err!.message.length).toBeLessThan(300);
    expect(String((err as { cmd?: unknown }).cmd ?? '')).not.toContain('d0 d0');
  });

  it('чтение экрана и ввод не меняют размер окна и не подключают клиента', async () => {
    const size = windowSize(session);
    await capturePane(session, socketName);
    await sendKeys(session, socketName, Uint8Array.of(0x71));
    await pasteText(session, socketName, 'a\nb');
    await capturePane(session, socketName);
    expect(windowSize(session)).toBe(size);
    expect(tmux(['list-clients', '-t', `=${session}:`]).trim()).toBe('');
  });

  // Флаг звонка гасит клиент, показавший окно; чат клиентом не бывает — гасит агент.
  it('clearBell гасит флаг звонка окна, не оставляет клиента и не трогает размер окна', async () => {
    tmux(['new-session', '-d', '-s', 'bell', '-x', '90', '-y', '30', "sh -c 'sleep 0.3; printf \"\\a\"; sleep 60'"]);
    const flag = (): string => tmux(['list-windows', '-t', '=bell', '-F', '#{window_bell_flag} #{window_width}x#{window_height}']).trim();
    for (let i = 0; i < 40 && !flag().startsWith('1'); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(flag()).toBe('1 90x30');
    await clearBell('bell', socketName);
    expect(flag()).toBe('0 90x30');
    expect(tmux(['list-clients']).trim()).toBe('');
    // Нет такой сессии — молча, без исключения.
    await expect(clearBell('no-such-session', socketName)).resolves.toBeUndefined();
    tmux(['kill-session', '-t', '=bell']);
  });
});
