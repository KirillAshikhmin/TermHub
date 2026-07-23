import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { encodeFrame, jsonFrame, decodeFrame, FrameType } from '@termhub/protocol';
import { AgentServer } from '../src/server.js';
import { SessionService } from '../src/sessions.js';
import { wireTerminalWs } from '../src/bridge.js';
import { hashPassword } from '../src/config.js';
import type { TermhubConfig } from '../src/config.js';

/** Доступен ли tmux (иначе describe пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

/** В LAN один WS на терминал → channel всегда 0. */
const CHANNEL = 0;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await delay(100);
  }
  return pred();
}

function fixtureConfig(over: Partial<TermhubConfig> = {}): TermhubConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    passwordHash: hashPassword('secret'),
    cookieSecret: 'bridge-cookie-secret',
    sessionRoots: [],
    tls: null,
    relayUrl: null,
    vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:termhub@localhost' },
    locale: null,
    ...over,
  };
}

describe.skipIf(!tmuxAvailable)('TerminalBridge — реальный tmux + WS (изолированный сокет)', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  let root: string;
  let server: AgentServer;
  let base: string;

  function tmux(args: string[]): string {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
  }

  // send-keys/capture-pane принимают target-pane, где префикс «=» (точный матч
  // сессии) не парсится — цель задаём именем сессии (единственная, коллизий нет).
  function capturePane(): string {
    return tmux(['capture-pane', '-p', '-t', 'bridge']);
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-bridge-'));
    fs.mkdirSync(path.join(root, 'work'));
    tmux(['new-session', '-d', '-s', 'bridge', '-c', path.join(root, 'work')]);

    const sessions = new SessionService({ roots: [root], socketName });
    server = new AgentServer({ config: fixtureConfig({ sessionRoots: [root] }), sessions });
    server.attachTerminalWs(wireTerminalWs({ socketName }));
    const port = await server.listen();
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    try {
      tmux(['kill-server']);
    } catch {
      // сервер мог уже не работать
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    const match = /termhub=[^;]+/.exec(setCookie);
    if (!match) throw new Error('cookie termhub отсутствует в ответе логина');
    return match[0];
  }

  it('RESIZE→attach: send-keys виден в WS-DATA, DATA пишется в pty, закрытие WS не убивает сессию', async () => {
    const cookie = await login();
    const wsUrl = `${base.replace('http', 'ws')}/ws/term/bridge`;
    const ws = new WebSocket(wsUrl, { headers: { cookie } });

    let output = '';
    const decoder = new TextDecoder();
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(new Uint8Array(data));
      if (frame.type === FrameType.Data) output += decoder.decode(frame.payload, { stream: true });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    // Первое сообщение обязано быть RESIZE — оно спавнит pty и делает attach.
    ws.send(jsonFrame(FrameType.Resize, CHANNEL, { cols: 80, rows: 24 }));
    await delay(600); // дать pty заспавниться и приаттачиться к сессии

    // Ввод в сессию извне (tmux send-keys) → должен долететь до WS-клиента как DATA.
    tmux(['send-keys', '-t', 'bridge', 'echo hello-bridge', 'Enter']);
    expect(await waitFor(() => output.includes('hello-bridge'), 5000)).toBe(true);

    // DATA от WS-клиента → pty.write → команда выполняется в сессии.
    ws.send(encodeFrame({ type: FrameType.Data, channel: CHANNEL, payload: new TextEncoder().encode('echo by-ws\r') }));
    expect(await waitFor(() => capturePane().includes('by-ws'), 5000)).toBe(true);

    // Закрытие WS → dispose → отсоединение pty, но сессия остаётся жить.
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    await delay(300);
    const list = tmux(['list-sessions', '-F', '#{session_name}']);
    expect(list).toContain('bridge');
  }, 25000);

  it('подключение восстанавливает историю: строки выше текущего экрана + RESET', async () => {
    const cookie = await login();

    // Готовим историю: MARK-TOP уедет далеко за 24-строчный экран (плейн-attach его не
    // покажет — только текущий экран у дна). Восстановление обязано дотянуть его из tmux.
    tmux(['send-keys', '-t', 'bridge', 'echo MARK-TOP-UNIQUE; seq 1 300; echo MARK-BOTTOM', 'Enter']);
    expect(await waitFor(() => capturePane().includes('MARK-BOTTOM'), 8000)).toBe(true);
    await delay(300); // prompt вернулся, история зафиксирована

    const wsUrl = `${base.replace('http', 'ws')}/ws/term/bridge`;
    const ws = new WebSocket(wsUrl, { headers: { cookie } });
    let output = '';
    const decoder = new TextDecoder();
    ws.on('message', (data: Buffer) => {
      const frame = decodeFrame(new Uint8Array(data));
      if (frame.type === FrameType.Data) output += decoder.decode(frame.payload, { stream: true });
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.send(jsonFrame(FrameType.Resize, CHANNEL, { cols: 80, rows: 24 }));

    // MARK-TOP (за экраном) должен прийти клиенту, с RESET-префиксом (очистка перед перерисовкой).
    expect(await waitFor(() => output.includes('MARK-TOP-UNIQUE'), 8000)).toBe(true);
    expect(output).toContain('\x1b[3J');

    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  }, 30000);
});
