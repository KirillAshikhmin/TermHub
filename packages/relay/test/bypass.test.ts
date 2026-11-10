// Обходы удушения потока: транспорт короткими запросами, раздача бандла кусками и порт
// маскировки. Всё — на живом relay на случайном порту, без моков сети.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import net from 'node:net';
import { WebSocket } from 'ws';
import {
  initCrypto,
  generateIdentity,
  fingerprint,
  sign,
  PollSocket,
  POLL_DOWN_CHUNK,
  disguisePreface,
  type Identity,
} from '@termhub/protocol';
import { startRelay, type RelayHandle } from '../src/index.js';
import { startDisguiseProxy, type DisguiseProxyHandle } from '../src/disguise-port.js';
import { bootIndex, CHUNK_BYTES } from '../src/static.js';

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

let identity: Identity;
beforeAll(async () => {
  await initCrypto();
  identity = generateIdentity();
});

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function relay(opts: Partial<Parameters<typeof startRelay>[0]> = {}): Promise<RelayHandle> {
  const handle = await startRelay({ port: 0, silent: true, ...opts });
  closers.push(() => handle.close());
  return handle;
}

interface Inbox {
  next(): Promise<string | Buffer>;
}

/** Очередь входящих поверх любого из двух сокетов. */
function inboxOf(onMessage: (push: (m: string | Buffer) => void) => void): Inbox {
  const queue: Array<string | Buffer> = [];
  const waiters: Array<(m: string | Buffer) => void> = [];
  onMessage((m) => {
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const q = queue.shift();
        if (q !== undefined) resolve(q);
        else waiters.push(resolve);
      }),
  };
}

function wsInbox(ws: WebSocket): Inbox {
  return inboxOf((push) => ws.on('message', (data: Buffer, isBinary: boolean) => push(isBinary ? data : data.toString('utf8'))));
}

function pollInbox(sock: PollSocket): Inbox {
  return inboxOf((push) => {
    sock.onmessage = (ev) => push(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data));
  });
}

function openWs(url: string, options?: object): Promise<WebSocket> {
  const ws = new WebSocket(url, options as never);
  closers.push(() => ws.terminate());
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function openPoll(port: number): Promise<PollSocket> {
  const sock = new PollSocket(`ws://127.0.0.1:${port}/relay`);
  closers.push(() => sock.close());
  return new Promise((resolve, reject) => {
    sock.onopen = () => resolve(sock);
    sock.onclose = () => reject(new Error('poll socket closed before open'));
  });
}

/** Регистрирует агента на данном сокете (ws или poll — relay разницы не видит). */
async function register(send: (text: string) => void, inbox: Inbox): Promise<string> {
  send(JSON.stringify({ t: 'register', edPub: b64(identity.edPub) }));
  const challenge = JSON.parse((await inbox.next()) as string) as { nonce: string };
  send(JSON.stringify({ t: 'prove', sig: b64(sign(identity.edSec, Buffer.from(challenge.nonce, 'base64'))) }));
  const done = JSON.parse((await inbox.next()) as string) as { t: string; agentId: string };
  expect(done.t).toBe('registered');
  expect(done.agentId).toBe(fingerprint(identity.edPub));
  return done.agentId;
}

describe('транспорт короткими запросами', () => {
  it('клиент на запросах и агент на WebSocket обмениваются бинарём в обе стороны', async () => {
    const handle = await relay();
    const agent = await openWs(`ws://127.0.0.1:${handle.port}/relay`);
    const agentIn = wsInbox(agent);
    const agentId = await register((t) => agent.send(t), agentIn);

    const client = await openPoll(handle.port);
    const clientIn = pollInbox(client);
    client.send(JSON.stringify({ t: 'connect', agentId }));
    expect(JSON.parse((await agentIn.next()) as string)).toEqual({ t: 'client-open', connId: 1 });
    expect(JSON.parse((await clientIn.next()) as string)).toEqual({ t: 'connected' });

    // вверх: больше одного куска запроса; вниз: десятки кусков по POLL_DOWN_CHUNK
    const up = Buffer.from(Uint8Array.from({ length: 50_000 }, (_, i) => (i * 7) & 255));
    client.send(up);
    const atAgent = (await agentIn.next()) as Buffer;
    expect(atAgent.readUInt32BE(0)).toBe(1);
    expect(atAgent.subarray(4).equals(up)).toBe(true);

    const down = Buffer.from(Uint8Array.from({ length: POLL_DOWN_CHUNK * 20 + 123 }, (_, i) => (i * 13) & 255));
    agent.send(Buffer.concat([Buffer.from([0, 0, 0, 1]), down]), { binary: true });
    agent.send(Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from('tail')]), { binary: true });
    expect(((await clientIn.next()) as Buffer).equals(down)).toBe(true);
    expect(((await clientIn.next()) as Buffer).toString()).toBe('tail');
  });

  it('агент на запросах регистрируется, клиент на WebSocket его находит', async () => {
    const handle = await relay();
    const agent = await openPoll(handle.port);
    const agentIn = pollInbox(agent);
    const agentId = await register((t) => agent.send(t), agentIn);

    const client = await openWs(`ws://127.0.0.1:${handle.port}/relay`);
    const clientIn = wsInbox(client);
    client.send(JSON.stringify({ t: 'connect', agentId }));
    expect(JSON.parse((await agentIn.next()) as string)).toEqual({ t: 'client-open', connId: 1 });
    expect(JSON.parse((await clientIn.next()) as string)).toEqual({ t: 'connected' });
    client.send(Buffer.from('ping'), { binary: true });
    const got = (await agentIn.next()) as Buffer;
    expect(got.subarray(4).toString()).toBe('ping');
  });

  it('закрытие сервером доезжает клиенту кодом, уход клиента — агенту', async () => {
    const handle = await relay();
    const lone = await openPoll(handle.port);
    const closed = new Promise<number>((resolve) => {
      lone.onclose = (ev) => resolve(ev.code);
    });
    lone.send(JSON.stringify({ t: 'connect', agentId: 'NOSUCHAGENT' }));
    expect(await closed).toBe(4004);

    const agent = await openWs(`ws://127.0.0.1:${handle.port}/relay`);
    const agentIn = wsInbox(agent);
    const agentId = await register((t) => agent.send(t), agentIn);
    const client = await openPoll(handle.port);
    client.send(JSON.stringify({ t: 'connect', agentId }));
    expect(JSON.parse((await agentIn.next()) as string)).toEqual({ t: 'client-open', connId: 1 });
    client.close();
    expect(JSON.parse((await agentIn.next()) as string)).toEqual({ t: 'client-close', connId: 1 });
  });

  it('каждый ответ закрывает соединение, а неизвестная сессия — 410', async () => {
    const handle = await relay();
    const opened = await fetch(`http://127.0.0.1:${handle.port}/relay/open`, { method: 'POST' });
    expect(opened.headers.get('connection')).toBe('close');
    const { sid } = (await opened.json()) as { sid: string };
    expect(sid).toMatch(/^[0-9a-f]{32}$/);
    const gone = await fetch(`http://127.0.0.1:${handle.port}/relay/down?sid=${'0'.repeat(32)}&seq=0&ack=0`);
    expect(gone.status).toBe(410);
    const mode = (await (await fetch(`http://127.0.0.1:${handle.port}/api/mode`)).json()) as Record<string, unknown>;
    expect(mode).toEqual({ mode: 'relay', chunked: false, transport: 'ws' });
  });
});

describe('раздача бандла кусками', () => {
  function bundle(): { dir: string; js: Buffer } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-chunks-'));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'assets'));
    // несжимаемое содержимое — чтобы кусков было много
    const js = crypto.randomBytes(70_000);
    fs.writeFileSync(path.join(dir, 'assets', 'main-abc.js'), js);
    fs.writeFileSync(
      path.join(dir, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" crossorigin href="./assets/main-x.css"></head>' +
        '<body><div id="app"></div><script type="module" crossorigin src="./assets/main-abc.js"></script></body></html>',
    );
    return { dir, js };
  }

  it('файл собирается из кусков не больше лимита и совпадает с исходным', async () => {
    const { dir, js } = bundle();
    const handle = await relay({ staticDir: dir, chunked: true });
    const base = `http://127.0.0.1:${handle.port}`;
    const first = await fetch(`${base}/_c/0/assets/main-abc.js`);
    expect(first.status).toBe(200);
    expect(first.headers.get('connection')).toBe('close');
    expect(first.headers.get('x-content-type')).toBe('text/javascript; charset=utf-8');
    const total = Number(first.headers.get('x-chunks'));
    expect(total).toBeGreaterThan(5);
    const parts = [Buffer.from(await first.arrayBuffer())];
    for (let i = 1; i < total; i++) parts.push(Buffer.from(await (await fetch(`${base}/_c/${i}/assets/main-abc.js`)).arrayBuffer()));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(CHUNK_BYTES);
    expect(zlib.gunzipSync(Buffer.concat(parts)).equals(js)).toBe(true);
    expect((await fetch(`${base}/_c/${total}/assets/main-abc.js`)).status).toBe(404);
    expect((await fetch(`${base}/_c/0/..%2f..%2fetc%2fpasswd`)).status).toBe(404);
    expect((await fetch(`${base}/__sw-chunked`)).status).toBe(404);
  });

  it('index.html отдаёт загрузчик вместо прямых ссылок на бандл', async () => {
    const { dir } = bundle();
    const handle = await relay({ staticDir: dir, chunked: true });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).not.toContain('type="module"');
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).toMatch(/<script src="\.\/boot\.js\?v=[0-9a-f]{8}" data-js="\.\/assets\/main-abc\.js" data-css="\.\/assets\/main-x\.css"><\/script>/);
    const boot = await fetch(`http://127.0.0.1:${handle.port}/boot.js`);
    expect(boot.headers.get('content-type')).toContain('javascript');
    expect(await boot.text()).toContain('__sw-chunked');
    const mode = (await (await fetch(`http://127.0.0.1:${handle.port}/api/mode`)).json()) as Record<string, unknown>;
    expect(mode.chunked).toBe(true);
  });

  it('без режима кусков relay отдаёт бандл как раньше', async () => {
    const { dir } = bundle();
    const handle = await relay({ staticDir: dir });
    const html = await (await fetch(`http://127.0.0.1:${handle.port}/`)).text();
    expect(html).toContain('type="module"');
    // /_c/… без режима — обычный путь статики: SPA-fallback на index.html, не кусок
    expect((await fetch(`http://127.0.0.1:${handle.port}/_c/0/assets/main-abc.js`)).headers.get('x-chunks')).toBeNull();
  });

  it('bootIndex не трогает страницу без модульного скрипта', () => {
    const plain = '<html><body><p>stub</p></body></html>';
    expect(bootIndex(plain)).toBe(plain);
  });
});

describe('порт маскировки', () => {
  async function proxyTo(port: number): Promise<DisguiseProxyHandle> {
    const proxy = await startDisguiseProxy({ port: 0, upstreamHost: '127.0.0.1', upstreamPort: port });
    closers.push(() => proxy.close());
    return proxy;
  }

  it.each(['ssh', 'rdp', 'dns'] as const)('%s: после преамбулы идёт обычный WebSocket', async (kind) => {
    const handle = await relay();
    const proxy = await proxyTo(handle.port);
    const ws = await openWs(`ws://127.0.0.1:${handle.port}/relay`, {
      createConnection: () => {
        const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
        raw.write(disguisePreface(kind));
        return raw;
      },
    });
    const inbox = wsInbox(ws);
    expect(await register((t) => ws.send(t), inbox)).toBe(fingerprint(identity.edPub));
  });

  it('соединение без преамбулы рвётся', async () => {
    const handle = await relay();
    const proxy = await proxyTo(handle.port);
    const raw = net.connect({ host: '127.0.0.1', port: proxy.port });
    const closed = new Promise<void>((resolve) => raw.on('close', () => resolve()));
    raw.on('error', () => undefined);
    raw.write('GET /relay HTTP/1.1\r\nHost: x\r\n\r\n');
    await closed;
  });
});
