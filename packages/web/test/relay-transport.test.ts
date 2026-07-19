// @vitest-environment happy-dom
// Юнит-тесты RelayTransport БЕЗ реального relay/агента: FakeWebSocket — глухая
// эмуляция browser WebSocket (сама ничего не решает), ответы «агента» на другом
// конце строит сам тест через настоящую крипто @termhub/protocol (sessionKeys
// с ролью 'server', зеркально agent/relay-link.ts) — так можно расшифровать то,
// что клиент реально шлёт на wire, и проверить порядок кадров.
import {
  decodeFrame,
  fingerprint,
  FrameType,
  generateIdentity,
  initCrypto,
  jsonFrame,
  makeDecryptor,
  makeEncryptor,
  sessionKeys,
  type Identity,
} from '@termhub/protocol';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { b64, unb64 } from '../src/b64';
import { RelayTransport } from '../src/relay-transport';
import type { TermChannelOpts } from '../src/transport';

const td = new TextDecoder();
const te = new TextEncoder();

/**
 * Мини-эмуляция browser WebSocket. Ничего не знает про relay/агента — входящие
 * кадры доставляет тест вручную (triggerOpen/deliverText/deliverBinary), это
 * даёт полный детерминированный контроль над порядком событий.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType = '';
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Array<string | Uint8Array> = [];

  constructor(public readonly url: string) {
    sockets.push(this);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  deliverText(text: string): void {
    this.onmessage?.({ data: text });
  }

  deliverBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

let sockets: FakeWebSocket[] = [];
const createdTransports: RelayTransport[] = [];

beforeAll(async () => {
  await initCrypto();
});

beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  for (const transport of createdTransports) transport.close();
  createdTransports.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function noopOpts(): TermChannelOpts {
  return { cols: 80, rows: 24, onData: () => {}, onBell: () => {}, onEnd: () => {}, onStatus: () => {} };
}

function makeTransport(clientIdentity: Identity, agentIdentity: Identity): RelayTransport {
  const transport = new RelayTransport({
    url: 'ws://fake/relay',
    identity: clientIdentity,
    agent: { agentId: fingerprint(agentIdentity.edPub), edPub: b64(agentIdentity.edPub) },
    clientName: 'test-client',
  });
  createdTransports.push(transport);
  return transport;
}

/** connect → {connected} → клиент шлёт plaintext hello. Возвращает edPub клиента из hello. */
function driveToHelloSent(ws: FakeWebSocket): Uint8Array {
  ws.triggerOpen();
  ws.deliverText(JSON.stringify({ t: 'connected' }));
  const frame = decodeFrame(ws.sent[ws.sent.length - 1] as Uint8Array);
  const hello = JSON.parse(td.decode(frame.payload)) as { t: string; edPub: string };
  expect(hello.t).toBe('hello');
  return unb64(hello.edPub);
}

/** «Агент» отвечает hello-ok. Возвращает rx для расшифровки того, что клиент зашлёт дальше. */
function respondHelloOk(ws: FakeWebSocket, agentIdentity: Identity, clientEdPub: Uint8Array): Uint8Array {
  const { rx, tx } = sessionKeys('server', agentIdentity, clientEdPub);
  const agentEncryptor = makeEncryptor(tx);
  ws.deliverBinary(jsonFrame(FrameType.Data, 0, { t: 'hello-ok', header: b64(agentEncryptor.header) }));
  return rx;
}

describe('RelayTransport — onStreamReady: re-OPEN уходит раньше outbox', () => {
  it('первое подключение: DATA, набранная во время handshaking, доходит агенту ПОСЛЕ OPEN своего канала', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    const clientEdPub = driveToHelloSent(ws);

    // Пользователь открывает терминал и печатает ДО завершения хендшейка — канал
    // ещё не был OPEN-нут агенту, поэтому DATA осядет в outbox (state !== 'streaming').
    const term = transport.openTerm('work', noopOpts());
    term.write(te.encode('ls\n'));
    const sentBeforeStreaming = ws.sent.length;

    const rx = respondHelloOk(ws, agentIdentity, clientEdPub);

    // hello-fin (plaintext) — первый кадр после hello-ok.
    const finFrame = decodeFrame(ws.sent[sentBeforeStreaming] as Uint8Array);
    const fin = JSON.parse(td.decode(finFrame.payload)) as { t: string; header: string };
    expect(fin.t).toBe('hello-fin');

    // Дальше — ровно два зашифрованных кадра: re-OPEN терминала и DATA из outbox.
    const encryptedAfter = ws.sent.slice(sentBeforeStreaming + 1);
    expect(encryptedAfter).toHaveLength(2);

    const agentDecryptor = makeDecryptor(rx, unb64(fin.header));
    const first = decodeFrame(agentDecryptor.pull(encryptedAfter[0] as Uint8Array));
    const second = decodeFrame(agentDecryptor.pull(encryptedAfter[1] as Uint8Array));

    expect(first.type).toBe(FrameType.Open);
    expect(second.type).toBe(FrameType.Data);
    expect(second.channel).toBe(first.channel); // тот же канал, что был OPEN-нут
    expect(td.decode(second.payload)).toBe('ls\n');
  });

  it('реконнект: DATA, накопленная во время повторного handshaking, доходит агенту ПОСЛЕ re-OPEN', () => {
    vi.useFakeTimers();
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws1 = sockets[0]!;

    // Первое подключение доводим до streaming и открываем терминал уже «в потоке».
    const edPub1 = driveToHelloSent(ws1);
    respondHelloOk(ws1, agentIdentity, edPub1);
    expect(transport.isStreaming).toBe(true);
    const term = transport.openTerm('work', noopOpts());

    // Обрыв соединения — реконнект планируется с backoff (1с).
    ws1.close();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    const ws2 = sockets[1]!;

    const edPub2 = driveToHelloSent(ws2);
    // Печатаем во время повторного хендшейка — терминал уже существовал, но не re-OPEN-нут.
    term.write(te.encode('ls\n'));
    const sentBeforeStreaming = ws2.sent.length;

    const rx2 = respondHelloOk(ws2, agentIdentity, edPub2);

    const finFrame = decodeFrame(ws2.sent[sentBeforeStreaming] as Uint8Array);
    const fin = JSON.parse(td.decode(finFrame.payload)) as { t: string; header: string };
    const agentDecryptor = makeDecryptor(rx2, unb64(fin.header));

    const encryptedAfter = ws2.sent.slice(sentBeforeStreaming + 1);
    expect(encryptedAfter).toHaveLength(2);
    const first = decodeFrame(agentDecryptor.pull(encryptedAfter[0] as Uint8Array));
    const second = decodeFrame(agentDecryptor.pull(encryptedAfter[1] as Uint8Array));

    expect(first.type).toBe(FrameType.Open);
    expect(second.type).toBe(FrameType.Data);
    expect(second.channel).toBe(first.channel);
    expect(td.decode(second.payload)).toBe('ls\n');
  });
});

describe('RelayTransport — list() пока поток не установлен', () => {
  it('отклоняется сразу: без 10с ожидания и без постановки LIST в outbox', async () => {
    vi.useFakeTimers();
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;
    driveToHelloSent(ws); // state === 'handshaking', ещё не streaming

    expect(transport.isStreaming).toBe(false);
    const sentBefore = ws.sent.length;
    const timersBefore = vi.getTimerCount();

    await expect(transport.list()).rejects.toThrow();

    // Ни одного нового таймера (LIST_TIMEOUT_MS не запланирован) и ничего не отправлено/не в очереди.
    expect(vi.getTimerCount()).toBe(timersBefore);
    expect(ws.sent.length).toBe(sentBefore);
  });

  it('isStreaming: false до hello-ok, true сразу после hello-fin', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    expect(transport.isStreaming).toBe(false);
    const clientEdPub = driveToHelloSent(ws);
    expect(transport.isStreaming).toBe(false);
    respondHelloOk(ws, agentIdentity, clientEdPub);
    expect(transport.isStreaming).toBe(true);
  });
});
