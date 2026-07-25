// RelayLink против НАСТОЯЩЕГО relay (startRelay на ephemeral-порту). Клиентская
// сторона написана прямо здесь на сыром ws + @termhub/protocol: пейринг по коду
// (верный/неверный секрет), hello незнакомца → ERROR, и полный happy-path
// hello→hello-ok→hello-fin→secretstream→LIST.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  initCrypto,
  generateIdentity,
  fingerprint,
  parsePairingCode,
  pairKey,
  sealPair,
  openPair,
  sessionKeys,
  sign,
  handshakeTranscript,
  makeEncryptor,
  makeDecryptor,
  encodeFrame,
  decodeFrame,
  jsonFrame,
  frameJson,
  FrameType,
  type Identity,
  type SessionInfo,
} from '@termhub/protocol';
import { startRelay, type RelayHandle } from '../../relay/src/index.js';
import { RelayLink } from '../src/relay-link.js';
import { SessionService } from '../src/sessions.js';
import type { TerminalHandle } from '../src/bridge.js';
import { saveAuthorized, loadAuthorized } from '../src/config.js';
import type { AuthorizedDevice } from '../src/config.js';

/** Доступен ли tmux (иначе happy-LIST пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

const SANDBOX_SESSION = 'relaylink-sandbox';
const td = new TextDecoder();
const te = new TextEncoder();

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function unb64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
/** hello-fin С ПОДПИСЬЮ транскрипта (челлендж ‖ header клиента ‖ header агента):
 *  без неё агент в streaming не пускает — это и есть защита от переигрывания сессии. */
function finFrame(
  clientId: Identity,
  clientEnc: { header: Uint8Array },
  ok: { header: string; nonce: string },
): Uint8Array {
  const sig = sign(clientId.edSec, handshakeTranscript(unb64(ok.nonce), clientEnc.header, unb64(ok.header)));
  return dataJsonFrame({ t: 'hello-fin', header: b64(clientEnc.header), sig: b64(sig) });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Плоский DATA-фрейм с JSON-нагрузкой (plaintext-хендшейк). */
function dataJsonFrame(obj: unknown): Uint8Array {
  return encodeFrame({ type: FrameType.Data, channel: 0, payload: te.encode(JSON.stringify(obj)) });
}

/** Очередь сообщений сокета: текст → JSON, бинарь → { binary }. */
interface Msg {
  t?: string;
  binary?: Buffer;
  [k: string]: unknown;
}
interface Collector {
  next(): Promise<Msg>;
}
function collect(ws: WebSocket): Collector {
  const queue: Msg[] = [];
  const waiters: ((m: Msg) => void)[] = [];
  ws.on('message', (data: Buffer, isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
    const msg: Msg = isBinary ? { binary: buf } : (JSON.parse(buf.toString('utf8')) as Msg);
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return {
    next: () =>
      new Promise<Msg>((resolve) => {
        const q = queue.shift();
        if (q) resolve(q);
        else waiters.push(resolve);
      }),
  };
}

const openSockets: WebSocket[] = [];
function open(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  openSockets.push(ws);
  ws.on('error', () => {});
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Подключает клиента к агенту через relay (connect с ретраем до 'connected'). */
async function connectClient(port: number, agentId: string): Promise<{ ws: WebSocket; col: Collector }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ws = await open(port);
    const col = collect(ws);
    ws.send(JSON.stringify({ t: 'connect', agentId }));
    const first = await col.next();
    if (first.t === 'connected') return { ws, col };
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    await delay(50);
  }
  throw new Error('не удалось подключиться к агенту через relay');
}

/** Джойнит pair-комнату (ретрай на no-room, пока агент не откроет её на relay).
 *  Успех join не подтверждается сообщением, а провал (no-room) закрывает сокет —
 *  поэтому детектируем по 'close', НЕ трогая collector (иначе повисший waiter
 *  украл бы ответный pair-msg агента). */
async function ensureJoined(port: number, roomId: string): Promise<{ ws: WebSocket; col: Collector }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ws = await open(port);
    const col = collect(ws);
    let closed = false;
    ws.on('close', () => {
      closed = true;
    });
    ws.send(JSON.stringify({ t: 'pair-join', roomId }));
    await delay(150);
    if (!closed) return { ws, col };
    await delay(60);
  }
  throw new Error('не удалось войти в pair-комнату');
}

let agentIdentity: Identity;
let agentId: string;
let relayHandle: RelayHandle;
let link: RelayLink;
let sessions: SessionService;
let termhubDir: string;
let root: string;
const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
}

beforeAll(async () => {
  await initCrypto();
  agentIdentity = generateIdentity();
  agentId = fingerprint(agentIdentity.edPub);

  termhubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-relaylink-'));
  process.env.TERMHUB_DIR = termhubDir;

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-relaylink-root-'));
  fs.mkdirSync(path.join(root, 'work'));
  if (tmuxAvailable) tmux(['new-session', '-d', '-s', SANDBOX_SESSION, '-c', path.join(root, 'work')]);

  sessions = new SessionService({ roots: [root], socketName });
  relayHandle = await startRelay({ port: 0, silent: true });
  link = new RelayLink({
    url: `ws://127.0.0.1:${relayHandle.port}/relay`,
    identity: agentIdentity,
    authorized: () => loadAuthorized(),
    sessions,
  });
  link.start();
});

afterAll(async () => {
  await link.stop();
  await relayHandle.close();
  if (tmuxAvailable) {
    try {
      tmux(['kill-server']);
    } catch {
      /* сервер мог уже не работать */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(termhubDir, { recursive: true, force: true });
  delete process.env.TERMHUB_DIR;
});

beforeEach(() => {
  saveAuthorized([]);
});

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
});

describe('RelayLink — пейринг по коду', () => {
  it('верный секрет: агент сохраняет устройство и возвращает свой edPub', async () => {
    const clientId = generateIdentity();
    const p = await link.openPairing();
    const { roomId, secret } = parsePairingCode(p.code);
    const key = pairKey(secret);

    const { ws, col } = await ensureJoined(relayHandle.port, roomId);
    // Клиент шлёт hello, зашифрованный ключом пейринга.
    const helloBox = sealPair(key, { edPub: b64(clientId.edPub), name: 'laptop' });
    ws.send(JSON.stringify({ t: 'pair-msg', data: b64(helloBox) }));

    // Агент отвечает pair-msg со своим edPub + ok, и резолвит done.
    const reply = await col.next();
    expect(reply.t).toBe('pair-msg');
    const decoded = openPair<{ edPub: string; ok: boolean }>(key, unb64(String(reply.data)));
    expect(decoded.ok).toBe(true);
    expect(decoded.edPub).toBe(b64(agentIdentity.edPub));

    const device = await p.done;
    expect(device.name).toBe('laptop');
    expect(device.fingerprint).toBe(fingerprint(clientId.edPub));
    expect(device.edPub).toBe(b64(clientId.edPub));

    const stored = loadAuthorized();
    expect(stored.some((d) => d.fingerprint === fingerprint(clientId.edPub))).toBe(true);
  });

  it('неверный секрет: openPair бросает, устройство не сохраняется, done не резолвится', async () => {
    const clientId = generateIdentity();
    const p = await link.openPairing();
    const { roomId } = parsePairingCode(p.code);
    // Ключ из ЗАВЕДОМО другого секрета (12 символов алфавита пейринга).
    const wrongKey = pairKey('MNPQRSTVWXYZ');

    const { ws, col } = await ensureJoined(relayHandle.port, roomId);
    const badBox = sealPair(wrongKey, { edPub: b64(clientId.edPub), name: 'attacker' });
    ws.send(JSON.stringify({ t: 'pair-msg', data: b64(badBox) }));

    // Агент не должен ответить и не должен сохранить устройство.
    const outcome = await Promise.race([
      col.next().then(() => 'reply' as const),
      p.done.then(() => 'resolved' as const, () => 'rejected' as const),
      delay(300).then(() => 'silent' as const),
    ]);
    expect(outcome).toBe('silent');
    expect(loadAuthorized()).toEqual([]);
  });
});

describe('RelayLink — обслуживание клиента', () => {
  it('hello незнакомца (fingerprint не в authorized) → ERROR-фрейм', async () => {
    const stranger = generateIdentity();
    const { ws, col } = await connectClient(relayHandle.port, agentId);
    ws.send(dataJsonFrame({ t: 'hello', edPub: b64(stranger.edPub), name: 'stranger' }), { binary: true });

    const msg = await col.next();
    expect(msg.binary).toBeInstanceOf(Buffer);
    const frame = decodeFrame(new Uint8Array(msg.binary as Buffer));
    expect(frame.type).toBe(FrameType.Error);
    const err = JSON.parse(td.decode(frame.payload)) as { code: string };
    expect(err.code).toBe('unauthorized');
  });

  it.skipIf(!tmuxAvailable)(
    'известный клиент: hello→hello-ok→hello-fin→secretstream→LIST возвращает сессии песочницы',
    async () => {
      const clientId = generateIdentity();
      const device: AuthorizedDevice = {
        name: 'known-laptop',
        edPub: b64(clientId.edPub),
        fingerprint: fingerprint(clientId.edPub),
        addedAt: Date.now(),
      };
      saveAuthorized([device]);

      const { ws, col } = await connectClient(relayHandle.port, agentId);

      // 1. hello (plaintext DATA-фрейм)
      ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: device.name }), { binary: true });

      // 2. hello-ok c header push-потока агента
      const okMsg = await col.next();
      const okFrame = decodeFrame(new Uint8Array(okMsg.binary as Buffer));
      expect(okFrame.type).toBe(FrameType.Data);
      const ok = JSON.parse(td.decode(okFrame.payload)) as { t: string; header: string; nonce: string };
      expect(ok.t).toBe('hello-ok');

      // 3. Ключи сессии клиента (role=client) + свои потоки
      const { rx, tx } = sessionKeys('client', clientId, agentIdentity.edPub);
      const clientDec = makeDecryptor(rx, unb64(ok.header));
      const clientEnc = makeEncryptor(tx);

      // 4. hello-fin c header клиента
      ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

      // 5. LIST (первый secretstream-chunk)
      ws.send(clientEnc.push(encodeFrame({ type: FrameType.List, channel: 0, payload: new Uint8Array(0) })), {
        binary: true,
      });

      // 6. LIST_RESULT (расшифровываем) содержит сессию песочницы
      const listMsg = await col.next();
      const listFrame = decodeFrame(clientDec.pull(new Uint8Array(listMsg.binary as Buffer)));
      expect(listFrame.type).toBe(FrameType.ListResult);
      const result = frameJson<{ sessions: SessionInfo[] }>(listFrame);
      expect(result.sessions.some((s) => s.name === SANDBOX_SESSION)).toBe(true);
    },
    25000,
  );

  it.skipIf(!tmuxAvailable)(
    'CREATE создаёт сессию и подтверждается кадром CreateOk',
    async () => {
      const clientId = generateIdentity();
      const device: AuthorizedDevice = {
        name: 'creator',
        edPub: b64(clientId.edPub),
        fingerprint: fingerprint(clientId.edPub),
        addedAt: Date.now(),
      };
      saveAuthorized([device]);

      const { ws, col } = await connectClient(relayHandle.port, agentId);
      ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: device.name }), { binary: true });
      const okMsg = await col.next();
      const ok = JSON.parse(td.decode(decodeFrame(new Uint8Array(okMsg.binary as Buffer)).payload)) as {
        header: string;
        nonce: string;
      };
      const { rx, tx } = sessionKeys('client', clientId, agentIdentity.edPub);
      const clientDec = makeDecryptor(rx, unb64(ok.header));
      const clientEnc = makeEncryptor(tx);
      ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

      // CREATE валидной сессии (root известен, подкаталог work существует).
      ws.send(clientEnc.push(jsonFrame(FrameType.Create, 0, { name: 'created-x', root, dir: 'work', preset: 'zsh' })), {
        binary: true,
      });

      const createMsg = await col.next();
      const createFrame = decodeFrame(clientDec.pull(new Uint8Array(createMsg.binary as Buffer)));
      expect(createFrame.type).toBe(FrameType.CreateOk);
      expect(frameJson<{ session: string }>(createFrame).session).toBe('created-x');
      // Сессия реально создана на изолированном сокете.
      expect(tmux(['list-sessions', '-F', '#{session_name}'])).toContain('created-x');
    },
    25000,
  );

  it('гость со scope: CREATE отклоняется кадром Error(create-failed), а не тишиной', async () => {
    const clientId = generateIdentity();
    const device: AuthorizedDevice = {
      name: 'scoped-guest',
      edPub: b64(clientId.edPub),
      fingerprint: fingerprint(clientId.edPub),
      addedAt: Date.now(),
      scope: { session: 'sess-1', write: true, files: false },
    };
    saveAuthorized([device]);

    const { ws, col } = await connectClient(relayHandle.port, agentId);
    ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: device.name }), { binary: true });
    const okMsg = await col.next();
    const ok = JSON.parse(td.decode(decodeFrame(new Uint8Array(okMsg.binary as Buffer)).payload)) as {
      header: string;
      nonce: string;
    };
    const { rx, tx } = sessionKeys('client', clientId, agentIdentity.edPub);
    const clientDec = makeDecryptor(rx, unb64(ok.header));
    const clientEnc = makeEncryptor(tx);
    ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

    // Гостю создание запрещено: агент шлёт Error(create-failed), а не молчит — иначе
    // клиент, ждущий CreateOk, крутит спиннер до тайм-аута.
    ws.send(clientEnc.push(jsonFrame(FrameType.Create, 0, { name: 'nope', root, dir: 'work', preset: 'zsh' })), {
      binary: true,
    });
    const msg = await col.next();
    const frame = decodeFrame(clientDec.pull(new Uint8Array(msg.binary as Buffer)));
    expect(frame.type).toBe(FrameType.Error);
    expect(frameJson<{ code: string }>(frame).code).toBe('create-failed');
  }, 25000);

  it('replay: записанный хендшейк + поток НЕ проигрываются повторно (свежесть челленджа)', async () => {
    const clientId = generateIdentity();
    const device: AuthorizedDevice = {
      name: 'recorded',
      edPub: b64(clientId.edPub),
      fingerprint: fingerprint(clientId.edPub),
      addedAt: Date.now(),
    };
    saveAuthorized([device]);

    // ── Сеанс 1: записываем ровно то, что уходит от клиента (как это видит relay).
    const first = await connectClient(relayHandle.port, agentId);
    const recHello = dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: device.name });
    first.ws.send(recHello, { binary: true });
    const ok1 = JSON.parse(td.decode(decodeFrame(new Uint8Array((await first.col.next()).binary as Buffer)).payload)) as {
      header: string;
      nonce: string;
    };
    const { rx: rx1, tx: tx1 } = sessionKeys('client', clientId, agentIdentity.edPub);
    const dec1 = makeDecryptor(rx1, unb64(ok1.header));
    const enc1 = makeEncryptor(tx1);
    const recFin = finFrame(clientId, enc1, ok1);
    first.ws.send(recFin, { binary: true });
    const recList = enc1.push(encodeFrame({ type: FrameType.List, channel: 0, payload: new Uint8Array(0) }));
    first.ws.send(recList, { binary: true });
    // Убеждаемся, что в ЖИВОЙ сессии это работает (иначе тест ничего не доказывает).
    expect(decodeFrame(dec1.pull(new Uint8Array((await first.col.next()).binary as Buffer))).type).toBe(
      FrameType.ListResult,
    );
    first.ws.close();

    // ── Сеанс 2: недоверенный relay переигрывает записанные байты как есть.
    const replay = await connectClient(relayHandle.port, agentId);
    replay.ws.send(recHello, { binary: true }); // hello статичен — пройдёт
    await replay.col.next(); // hello-ok, но уже с ДРУГИМ челленджем
    replay.ws.send(recFin, { binary: true }); // подпись над СТАРЫМ челленджем
    replay.ws.send(recList, { binary: true }); // записанная команда

    // Агент обязан отвергнуть хендшейк: приходит PLAINTEXT ERROR (bad-signature),
    // а не расшифрованный ListResult, и сессия закрывается.
    const msg = await Promise.race([
      replay.col.next(),
      delay(3000).then(() => ({ t: 'silence' }) as Msg),
    ]);
    expect(msg.binary).toBeDefined(); // агент ответил кадром отказа
    const rejectFrame = decodeFrame(new Uint8Array(msg.binary as Buffer));
    expect(rejectFrame.type).toBe(FrameType.Error);
    expect(frameJson<{ code: string }>(rejectFrame).code).toBe('bad-signature');

    // И главное: записанная команда НЕ исполнилась — ListResult в потоке не приходит.
    const after = await Promise.race([
      replay.col.next().then(() => 'more-data' as const),
      new Promise<'closed'>((resolve) => replay.ws.once('close', () => resolve('closed'))),
      delay(1500).then(() => 'silence' as const),
    ]);
    expect(after).not.toBe('more-data');
  }, 25000);

  it('отзыв действует на ЖИВОЕ соединение: следующий кадр отвергается, Share не выдаёт код', async () => {
    const clientId = generateIdentity();
    const device: AuthorizedDevice = {
      name: 'to-revoke',
      edPub: b64(clientId.edPub),
      fingerprint: fingerprint(clientId.edPub),
      addedAt: Date.now(),
    };
    saveAuthorized([device]);

    const { ws, col } = await connectClient(relayHandle.port, agentId);
    ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: device.name }), { binary: true });
    const okMsg = await col.next();
    const ok = JSON.parse(td.decode(decodeFrame(new Uint8Array(okMsg.binary as Buffer)).payload)) as {
      header: string;
      nonce: string;
    };
    const { rx, tx } = sessionKeys('client', clientId, agentIdentity.edPub);
    const clientDec = makeDecryptor(rx, unb64(ok.header));
    const clientEnc = makeEncryptor(tx);
    ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

    // До отзыва LIST работает.
    ws.send(clientEnc.push(encodeFrame({ type: FrameType.List, channel: 0, payload: new Uint8Array(0) })), {
      binary: true,
    });
    const listFrame = decodeFrame(clientDec.pull(new Uint8Array((await col.next()).binary as Buffer)));
    expect(listFrame.type).toBe(FrameType.ListResult);

    // Отзываем устройство «снаружи» (как это делает `termhub revoke` / HTTP-эндпоинт).
    saveAuthorized([]);
    await delay(1200); // больше REVOKE_RECHECK_MS — снимок допущенных обновится

    // Следующий кадр отвергается: раньше отозванный клиент продолжал работать и мог
    // через Share выписать себе новый код пейринга, обходя отзыв навсегда.
    const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
    ws.send(clientEnc.push(jsonFrame(FrameType.Share, 0, {})), { binary: true });
    const gotShare = await Promise.race([
      col.next().then((m) => decodeFrame(clientDec.pull(new Uint8Array(m.binary as Buffer))).type),
      closed.then(() => 'closed' as const),
      delay(3000).then(() => 'silence' as const),
    ]);
    expect(gotShare).not.toBe(FrameType.ShareResult); // кода пейринга не выдали
  }, 25000);
});

describe('RelayLink — мультиплекс каналов и idle-таймаут', () => {
  it('pre-hello idle-таймаут: молчащего клиента агент закрывает и освобождает слот', async () => {
    const idleIdentity = generateIdentity();
    const idleId = fingerprint(idleIdentity.edPub);
    const idleLink = new RelayLink({
      url: `ws://127.0.0.1:${relayHandle.port}/relay`,
      identity: idleIdentity,
      authorized: () => loadAuthorized(),
      sessions,
      helloTimeoutMs: 200,
    });
    idleLink.start();
    try {
      const { ws } = await connectClient(relayHandle.port, idleId);
      // Клиент НЕ шлёт hello — сидит в hello-фазе. Агент должен закрыть слот по таймауту;
      // relay при client-close агента рвёт клиента кодом 4000.
      const code = await Promise.race([
        new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c))),
        delay(3000).then(() => -1),
      ]);
      expect(code).toBe(4000);
    } finally {
      await idleLink.stop();
    }
  });

  it('мультиплекс: OPEN двух каналов, DATA роутится по каналу, client-close диспозит все терминалы', async () => {
    // Фейковый терминал: считает dispose и эхом гонит write→onData (канал зашит агентом в замыкание).
    let disposeCount = 0;
    const fakeAttach = (opts: {
      session: string;
      socketName?: string;
      cols: number;
      rows: number;
      onData: (b: Uint8Array) => void;
      onExit: () => void;
      onBell: (session: string) => void;
    }): TerminalHandle => ({
      write: (b: Uint8Array) => opts.onData(b),
      resize: () => {},
      pause: () => {},
      resume: () => {},
      dispose: () => {
        disposeCount += 1;
      },
    });

    const muxIdentity = generateIdentity();
    const muxId = fingerprint(muxIdentity.edPub);
    const muxLink = new RelayLink({
      url: `ws://127.0.0.1:${relayHandle.port}/relay`,
      identity: muxIdentity,
      authorized: () => loadAuthorized(),
      sessions,
      attach: fakeAttach,
    });
    muxLink.start();

    const clientId = generateIdentity();
    saveAuthorized([
      {
        name: 'mux-laptop',
        edPub: b64(clientId.edPub),
        fingerprint: fingerprint(clientId.edPub),
        addedAt: Date.now(),
      },
    ]);

    try {
      const { ws, col } = await connectClient(relayHandle.port, muxId);

      // Хендшейк hello → hello-ok → hello-fin → два secretstream-потока.
      ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub), name: 'mux-laptop' }), { binary: true });
      const okFrame = decodeFrame(new Uint8Array((await col.next()).binary as Buffer));
      const ok = JSON.parse(td.decode(okFrame.payload)) as { t: string; header: string; nonce: string };
      expect(ok.t).toBe('hello-ok');
      const { rx, tx } = sessionKeys('client', clientId, muxIdentity.edPub);
      const clientDec = makeDecryptor(rx, unb64(ok.header));
      const clientEnc = makeEncryptor(tx);
      ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

      const push = (bytes: Uint8Array): void => ws.send(clientEnc.push(bytes), { binary: true });
      const nextFrame = async () => decodeFrame(clientDec.pull(new Uint8Array((await col.next()).binary as Buffer)));

      // OPEN на каналах 1 и 2 (порядок сохраняется потоком).
      push(jsonFrame(FrameType.Open, 1, { session: 'sess-1' }));
      push(jsonFrame(FrameType.Open, 2, { session: 'sess-2' }));
      const ok1 = await nextFrame();
      expect(ok1.type).toBe(FrameType.OpenOk);
      expect(ok1.channel).toBe(1);
      const ok2 = await nextFrame();
      expect(ok2.type).toBe(FrameType.OpenOk);
      expect(ok2.channel).toBe(2);

      // DATA на канал 1 → фейк эхом возвращает по каналу 1 (изоляция каналов).
      push(encodeFrame({ type: FrameType.Data, channel: 1, payload: te.encode('ping-ch1') }));
      const echo = await nextFrame();
      expect(echo.type).toBe(FrameType.Data);
      expect(echo.channel).toBe(1);
      expect(td.decode(echo.payload)).toBe('ping-ch1');

      // client-close (закрытие ws клиента) → relay шлёт client-close агенту → dispose обоих терминалов.
      ws.close();
      for (let i = 0; i < 150 && disposeCount < 2; i += 1) await delay(20);
      expect(disposeCount).toBe(2);
    } finally {
      await muxLink.stop();
    }
  });
});

/** Фейковый терминал: считает dispose, эхом гонит write→onData. */
function makeFakeAttach(onDispose?: () => void) {
  return (opts: {
    session: string;
    socketName?: string;
    cols: number;
    rows: number;
    onData: (b: Uint8Array) => void;
    onExit: () => void;
    onBell: (session: string) => void;
  }): TerminalHandle => ({
    write: (b: Uint8Array) => opts.onData(b),
    resize: () => {},
    pause: () => {},
    resume: () => {},
    dispose: () => onDispose?.(),
  });
}

describe('RelayLink — hardening (pending-cap, revoke)', () => {
  it('pending-cap: >8 не завершивших streaming → новый отклонён; после streaming слот освобождается', async () => {
    const capIdentity = generateIdentity();
    const capId = fingerprint(capIdentity.edPub);
    const clientId = generateIdentity();
    saveAuthorized([
      { name: 'cap-laptop', edPub: b64(clientId.edPub), fingerprint: fingerprint(clientId.edPub), addedAt: Date.now() },
    ]);
    const capLink = new RelayLink({
      url: `ws://127.0.0.1:${relayHandle.port}/relay`,
      identity: capIdentity,
      authorized: () => loadAuthorized(),
      sessions,
      helloTimeoutMs: 30_000, // не мешает pending-клиентам во время теста
    });
    capLink.start();

    try {
      // 8 pending-клиентов: подключились и молчат (state='hello').
      const pending: { ws: WebSocket; col: Collector }[] = [];
      for (let i = 0; i < 8; i += 1) pending.push(await connectClient(relayHandle.port, capId));
      await delay(250); // дать агенту обработать все 8 client-open

      // 9-й сверх лимита → агент шлёт client-close → relay рвёт клиента кодом 4000.
      const ninth = await connectClient(relayHandle.port, capId);
      const code9 = await Promise.race([
        new Promise<number>((resolve) => ninth.ws.on('close', (c: number) => resolve(c))),
        delay(3000).then(() => -1),
      ]);
      expect(code9).toBe(4000);

      // Один pending завершает handshake до streaming → освобождает pending-слот.
      const promoter = pending[0]!;
      promoter.ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub) }), { binary: true });
      const okFrame = decodeFrame(new Uint8Array((await promoter.col.next()).binary as Buffer));
      const ok = JSON.parse(td.decode(okFrame.payload)) as { t: string; header: string; nonce: string };
      expect(ok.t).toBe('hello-ok');
      const { tx } = sessionKeys('client', clientId, capIdentity.edPub);
      const clientEnc = makeEncryptor(tx);
      promoter.ws.send(finFrame(clientId, clientEnc, ok), { binary: true });
      await delay(250); // дать агенту дойти до streaming (pending 8 → 7)

      // Теперь новый клиент принимается (pending под лимитом) — не закрывается.
      const tenth = await connectClient(relayHandle.port, capId);
      const code10 = await Promise.race([
        new Promise<number>((resolve) => tenth.ws.on('close', (c: number) => resolve(c))),
        delay(500).then(() => -1),
      ]);
      expect(code10).toBe(-1);
    } finally {
      await capLink.stop();
    }
  }, 20000);

  it('revoke при живой сессии: новый OPEN отклоняется (ERROR revoked) и сессия закрывается', async () => {
    const revokeIdentity = generateIdentity();
    const revokeId = fingerprint(revokeIdentity.edPub);
    const clientId = generateIdentity();
    saveAuthorized([
      { name: 'rev-laptop', edPub: b64(clientId.edPub), fingerprint: fingerprint(clientId.edPub), addedAt: Date.now() },
    ]);
    const revokeLink = new RelayLink({
      url: `ws://127.0.0.1:${relayHandle.port}/relay`,
      identity: revokeIdentity,
      authorized: () => loadAuthorized(),
      sessions,
      attach: makeFakeAttach(),
    });
    revokeLink.start();

    try {
      const { ws, col } = await connectClient(relayHandle.port, revokeId);

      // Хендшейк до streaming.
      ws.send(dataJsonFrame({ t: 'hello', edPub: b64(clientId.edPub) }), { binary: true });
      const okFrame = decodeFrame(new Uint8Array((await col.next()).binary as Buffer));
      const ok = JSON.parse(td.decode(okFrame.payload)) as { t: string; header: string; nonce: string };
      expect(ok.t).toBe('hello-ok');
      const { rx, tx } = sessionKeys('client', clientId, revokeIdentity.edPub);
      const clientDec = makeDecryptor(rx, unb64(ok.header));
      const clientEnc = makeEncryptor(tx);
      ws.send(finFrame(clientId, clientEnc, ok), { binary: true });

      const push = (bytes: Uint8Array): void => ws.send(clientEnc.push(bytes), { binary: true });
      const nextFrame = async () => decodeFrame(clientDec.pull(new Uint8Array((await col.next()).binary as Buffer)));

      // OPEN канала 1 — пока авторизован → OpenOk.
      push(jsonFrame(FrameType.Open, 1, { session: 'sess-1' }));
      const ok1 = await nextFrame();
      expect(ok1.type).toBe(FrameType.OpenOk);

      // Отзыв устройства при живом streaming-коннекте.
      saveAuthorized([]);

      // Новый OPEN канала 2 → зашифрованный ERROR revoked, затем закрытие сессии.
      push(jsonFrame(FrameType.Open, 2, { session: 'sess-2' }));
      const errFrame = await nextFrame();
      expect(errFrame.type).toBe(FrameType.Error);
      expect(errFrame.channel).toBe(2);
      expect(frameJson<{ code: string }>(errFrame).code).toBe('revoked');

      // Сессия закрывается: relay рвёт клиента (client-close агента → 4000).
      const code = await Promise.race([
        new Promise<number>((resolve) => ws.on('close', (c: number) => resolve(c))),
        delay(3000).then(() => -1),
      ]);
      expect(code).toBe(4000);
    } finally {
      await revokeLink.stop();
    }
  }, 20000);
});
