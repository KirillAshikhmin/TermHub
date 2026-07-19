import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { initCrypto, generateIdentity, fingerprint, sign, type Identity } from '@termhub/protocol';
import { startRelay, sweepRateWindows, type RelayHandle } from '../src/index.js';

/** base64 обеих сторон — стандартный (Buffer), как в relay. */
function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Очередь сообщений сокета: текстовые → распарсенный JSON, бинарные → { binary }. */
interface Collector {
  next(): Promise<Record<string, unknown> & { binary?: Buffer }>;
}

function collect(ws: WebSocket): Collector {
  const queue: (Record<string, unknown> & { binary?: Buffer })[] = [];
  const waiters: ((v: Record<string, unknown> & { binary?: Buffer }) => void)[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
    const msg = isBinary ? { binary: buf } : (JSON.parse(buf.toString('utf8')) as Record<string, unknown>);
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const q = queue.shift();
        if (q) resolve(q);
        else waiters.push(resolve);
      }),
  };
}

function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  ws.on('error', () => {});
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Открывает соединение с произвольными заголовками (для проверки X-Forwarded-For). */
function openWithHeaders(port: number, headers: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers });
  ws.on('error', () => {});
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** true, если upgrade отклонён (429) — по error/unexpected-response вместо open. */
function expectRejected(port: number, headers: Record<string, string>): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers });
  open_sockets.push(ws);
  return new Promise((resolve) => {
    ws.on('open', () => resolve(false));
    ws.on('error', () => resolve(true));
    ws.on('unexpected-response', () => resolve(true));
  });
}

function closeEvent(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

let identity: Identity;

beforeAll(async () => {
  await initCrypto();
  identity = generateIdentity();
});

const open_handles: RelayHandle[] = [];
const open_sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of open_sockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
  for (const h of open_handles.splice(0)) await h.close();
});

async function relay(opts: Partial<Parameters<typeof startRelay>[0]> = {}): Promise<RelayHandle> {
  const h = await startRelay({ port: 0, silent: true, ...opts });
  open_handles.push(h);
  return h;
}

async function track(ws: WebSocket): Promise<WebSocket> {
  open_sockets.push(ws);
  return ws;
}

/** Полный register-хендшейк реального агента. */
async function registerAgent(
  port: number,
  id: Identity = identity,
): Promise<{ ws: WebSocket; col: Collector; agentId: string }> {
  const ws = await track(await open(port));
  const col = collect(ws);
  ws.send(JSON.stringify({ t: 'register', edPub: b64(id.edPub) }));
  const challenge = await col.next();
  expect(challenge.t).toBe('challenge');
  const nonce = Buffer.from(String(challenge.nonce), 'base64');
  ws.send(JSON.stringify({ t: 'prove', sig: b64(sign(id.edSec, nonce)) }));
  const registered = await col.next();
  expect(registered.t).toBe('registered');
  return { ws, col, agentId: String(registered.agentId) };
}

describe('relay register/challenge', () => {
  it('верная подпись → registered с корректным agentId', async () => {
    const h = await relay();
    const { agentId } = await registerAgent(h.port);
    expect(agentId).toBe(fingerprint(identity.edPub));
  });

  it('неверная подпись → error + close', async () => {
    const h = await relay();
    const ws = await track(await open(h.port));
    const col = collect(ws);
    ws.send(JSON.stringify({ t: 'register', edPub: b64(identity.edPub) }));
    await col.next(); // challenge
    ws.send(JSON.stringify({ t: 'prove', sig: b64(new Uint8Array(64)) }));
    const err = await col.next();
    expect(err.t).toBe('error');
    const code = await closeEvent(ws);
    expect(code).toBeGreaterThanOrEqual(1000);
  });

  it('повторный register того же agentId заменяет старое соединение', async () => {
    const h = await relay();
    const first = await registerAgent(h.port);
    const firstClosed = closeEvent(first.ws);
    const second = await registerAgent(h.port);
    expect(second.agentId).toBe(first.agentId);
    await firstClosed; // старое соединение закрыто relay
  });
});

describe('relay connect/forward', () => {
  it('два клиента к одному агенту → разные connId', async () => {
    const h = await relay();
    const agent = await registerAgent(h.port);

    const c1 = await track(await open(h.port));
    const c1col = collect(c1);
    c1.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    const open1 = await agent.col.next();
    expect(open1.t).toBe('client-open');
    expect((await c1col.next()).t).toBe('connected');

    const c2 = await track(await open(h.port));
    const c2col = collect(c2);
    c2.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    const open2 = await agent.col.next();
    expect(open2.t).toBe('client-open');
    expect((await c2col.next()).t).toBe('connected');

    expect(open1.connId).not.toBe(open2.connId);
  });

  it('бинарный форвардинг: client→agent c префиксом [connId], agent→client чистые байты', async () => {
    const h = await relay();
    const agent = await registerAgent(h.port);

    const client = await track(await open(h.port));
    const clientCol = collect(client);
    client.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    const opened = await agent.col.next();
    const connId = Number(opened.connId);
    await clientCol.next(); // connected

    // client → agent: relay ставит префикс [connId:u32 BE]
    const payload = Buffer.from('hello-terminal');
    client.send(payload, { binary: true });
    const toAgent = await agent.col.next();
    expect(toAgent.binary).toBeInstanceOf(Buffer);
    const framed = toAgent.binary as Buffer;
    expect(framed.readUInt32BE(0)).toBe(connId);
    expect(framed.subarray(4).equals(payload)).toBe(true);

    // agent → client: relay снимает префикс, клиент видит чистые байты
    const reply = Buffer.from('echo-back');
    const outbound = Buffer.alloc(4 + reply.length);
    outbound.writeUInt32BE(connId, 0);
    reply.copy(outbound, 4);
    agent.ws.send(outbound, { binary: true });
    const toClient = await clientCol.next();
    expect(toClient.binary).toBeInstanceOf(Buffer);
    expect((toClient.binary as Buffer).equals(reply)).toBe(true);
  });

  it('offline-агент → error при connect', async () => {
    const h = await relay();
    const client = await track(await open(h.port));
    const col = collect(client);
    client.send(JSON.stringify({ t: 'connect', agentId: 'NONEXISTENT' }));
    expect((await col.next()).t).toBe('error');
  });

  it('client-close от агента закрывает клиента', async () => {
    const h = await relay();
    const agent = await registerAgent(h.port);
    const client = await track(await open(h.port));
    collect(client);
    client.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    const opened = await agent.col.next();
    const clientClosed = closeEvent(client);
    agent.ws.send(JSON.stringify({ t: 'client-close', connId: opened.connId }));
    await clientClosed;
  });

  it('≤32 клиентов на агента: 33-й отклонён', async () => {
    const h = await relay();
    const agent = await registerAgent(h.port);
    for (let i = 0; i < 32; i++) {
      const c = await track(await open(h.port));
      const col = collect(c);
      c.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
      await agent.col.next(); // client-open
      expect((await col.next()).t).toBe('connected');
    }
    const extra = await track(await open(h.port));
    const col = collect(extra);
    extra.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    const res = await col.next();
    expect(res.t).toBe('error');
    expect(res.code).toBe('too-many-clients');
  });
});

describe('relay pair', () => {
  it('верный join доставляет pair-msg в обе стороны', async () => {
    const h = await relay();
    const agentWs = await track(await open(h.port));
    const agentCol = collect(agentWs);
    agentWs.send(JSON.stringify({ t: 'pair-open', roomId: 'RM01' }));

    const clientWs = await track(await open(h.port));
    const clientCol = collect(clientWs);
    clientWs.send(JSON.stringify({ t: 'pair-join', roomId: 'RM01' }));

    // client → agent
    clientWs.send(JSON.stringify({ t: 'pair-msg', data: b64(Buffer.from('c2a')) }));
    const atAgent = await agentCol.next();
    expect(atAgent.t).toBe('pair-msg');
    expect(Buffer.from(String(atAgent.data), 'base64').toString()).toBe('c2a');

    // agent → client
    agentWs.send(JSON.stringify({ t: 'pair-msg', data: b64(Buffer.from('a2c')) }));
    const atClient = await clientCol.next();
    expect(atClient.t).toBe('pair-msg');
    expect(Buffer.from(String(atClient.data), 'base64').toString()).toBe('a2c');
  });

  it('4-й join → отказ (лимит попыток)', async () => {
    const h = await relay();
    const agentWs = await track(await open(h.port));
    collect(agentWs);
    agentWs.send(JSON.stringify({ t: 'pair-open', roomId: 'RM02' }));

    const clientWs = await track(await open(h.port));
    const col = collect(clientWs);
    for (let i = 0; i < 4; i++) clientWs.send(JSON.stringify({ t: 'pair-join', roomId: 'RM02' }));
    const res = await col.next();
    expect(res.t).toBe('error');
    expect(res.code).toBe('too-many-attempts');
    expect(await closeEvent(clientWs)).toBeGreaterThanOrEqual(1000);
  });

  it('pair-open на занятый другим агентом roomId → отказ, первая комната цела', async () => {
    const h = await relay();
    const agent1 = await track(await open(h.port));
    const a1col = collect(agent1);
    agent1.send(JSON.stringify({ t: 'pair-open', roomId: 'RM04' }));

    // второй агент пытается занять тот же roomId — отказ, чужую комнату не трогаем
    const agent2 = await track(await open(h.port));
    const a2col = collect(agent2);
    agent2.send(JSON.stringify({ t: 'pair-open', roomId: 'RM04' }));
    const rejected = await a2col.next();
    expect(rejected.t).toBe('error');
    expect(rejected.code).toBe('room-taken');

    // первая комната цела: клиент джойнится и pair-msg доставляется первой паре
    const clientWs = await track(await open(h.port));
    collect(clientWs);
    clientWs.send(JSON.stringify({ t: 'pair-join', roomId: 'RM04' }));
    clientWs.send(JSON.stringify({ t: 'pair-msg', data: b64(Buffer.from('c2a')) }));
    const atAgent1 = await a1col.next();
    expect(atAgent1.t).toBe('pair-msg');
    expect(Buffer.from(String(atAgent1.data), 'base64').toString()).toBe('c2a');
  });

  it('истёкший TTL → join отклонён', async () => {
    const h = await relay({ pairTtlMs: 40 });
    const agentWs = await track(await open(h.port));
    const agentCol = collect(agentWs);
    agentWs.send(JSON.stringify({ t: 'pair-open', roomId: 'RM03' }));
    const expired = await agentCol.next(); // pair-closed по TTL
    expect(expired.t).toBe('pair-closed');

    const clientWs = await track(await open(h.port));
    const col = collect(clientWs);
    clientWs.send(JSON.stringify({ t: 'pair-join', roomId: 'RM03' }));
    const res = await col.next();
    expect(res.t).toBe('error');
    expect(res.code).toBe('no-room');
  });
});

describe('relay limits', () => {
  it('фрейм >16MiB рвёт соединение (1009)', async () => {
    // MAX_MESSAGE = 16 МБ (index.ts) — вмещает чтение файлов браузером; больше → 1009.
    const h = await relay();
    const ws = await track(await open(h.port));
    const closed = closeEvent(ws);
    ws.send(Buffer.alloc(16 * 1024 * 1024 + 1), { binary: true });
    expect(await closed).toBe(1009);
  });

  it('sweep rate-limit: запись с истёкшим окном удаляется, свежая остаётся', () => {
    const now = 1_000_000;
    const windowMs = 60_000;
    const rate = new Map<string, { count: number; windowStart: number }>([
      ['expired', { count: 5, windowStart: now - windowMs }], // ровно истекло
      ['old', { count: 3, windowStart: now - windowMs - 1 }], // давно истекло
      ['fresh', { count: 2, windowStart: now - 1_000 }], // ещё активно
    ]);
    sweepRateWindows(rate, now, windowMs);
    expect(rate.has('expired')).toBe(false);
    expect(rate.has('old')).toBe(false);
    expect(rate.has('fresh')).toBe(true);
    expect(rate.size).toBe(1);
  });

  it('rate-limit новых соединений по IP', async () => {
    const h = await relay({ rateLimit: { max: 2, windowMs: 60_000 } });
    await track(await open(h.port));
    await track(await open(h.port));
    // третье соединение отклоняется на upgrade
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/relay`);
    await track(ws);
    const rejected = await new Promise<boolean>((resolve) => {
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('unexpected-response', () => resolve(true));
    });
    expect(rejected).toBe(true);
  });
});

describe('relay trust-proxy (X-Forwarded-For)', () => {
  it('trustProxy: rate-limit бакетится по XFF — разные XFF получают разные бакеты', async () => {
    const h = await relay({ rateLimit: { max: 1, windowMs: 60_000 }, trustProxy: true });
    // Первый клиент за XFF 1.1.1.1 — разрешён.
    const first = await track(await openWithHeaders(h.port, { 'x-forwarded-for': '1.1.1.1' }));
    expect(first.readyState).toBe(WebSocket.OPEN);
    // Второй с ТЕМ ЖЕ XFF — тот же бакет исчерпан → отклонён.
    expect(await expectRejected(h.port, { 'x-forwarded-for': '1.1.1.1' })).toBe(true);
    // Третий с ДРУГИМ XFF — отдельный бакет → разрешён.
    const third = await track(await openWithHeaders(h.port, { 'x-forwarded-for': '2.2.2.2' }));
    expect(third.readyState).toBe(WebSocket.OPEN);
  });

  it('без trustProxy: XFF игнорируется, бакет по remoteAddress (защита от спуфинга)', async () => {
    const h = await relay({ rateLimit: { max: 1, windowMs: 60_000 } }); // trustProxy по умолчанию off
    await track(await openWithHeaders(h.port, { 'x-forwarded-for': '1.1.1.1' }));
    // Другой XFF, но тот же remoteAddress (127.0.0.1) → тот же бакет → отклонён.
    expect(await expectRejected(h.port, { 'x-forwarded-for': '2.2.2.2' })).toBe(true);
  });
});

describe('relay http', () => {
  it('GET /healthz → 200 ok, GET /api/mode → {mode:relay}', async () => {
    const h = await relay();
    const health = await fetch(`http://127.0.0.1:${h.port}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');
    const mode = await fetch(`http://127.0.0.1:${h.port}/api/mode`);
    expect(mode.status).toBe(200);
    expect(await mode.json()).toEqual({ mode: 'relay' });
  });

  it('без статики → отдаёт HTML-заглушку', async () => {
    const h = await relay();
    const res = await fetch(`http://127.0.0.1:${h.port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
