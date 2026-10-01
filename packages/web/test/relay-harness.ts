// Общая обвязка тестов RelayTransport БЕЗ реального relay/агента: FakeWebSocket — глухая
// эмуляция browser WebSocket (сама ничего не решает), ответы «агента» на другом конце
// строит тест через настоящую крипто @termhub/protocol (sessionKeys с ролью 'server',
// зеркально agent/relay-link.ts) — так можно расшифровать то, что клиент реально шлёт
// на wire, и проверить порядок кадров.
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
  sign,
  serverHandshakeTranscript,
  type Identity,
} from '@termhub/protocol';
import { afterEach, beforeAll, beforeEach, expect, vi } from 'vitest';

import { b64, unb64 } from '../src/b64';
import { RelayTransport } from '../src/relay-transport';

const td = new TextDecoder();

/**
 * Мини-эмуляция browser WebSocket. Ничего не знает про relay/агента — входящие
 * кадры доставляет тест вручную (triggerOpen/deliverText/deliverBinary), это
 * даёт полный детерминированный контроль над порядком событий.
 */
export class FakeWebSocket {
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

/** Созданные за тест сокеты в порядке подключения (реконнект добавляет следующий). */
export const sockets: FakeWebSocket[] = [];
const createdTransports: RelayTransport[] = [];

/** Регистрирует хуки набора: крипто, подмену WebSocket и уборку транспортов. */
export function installRelayHarness(): void {
  beforeAll(async () => {
    await initCrypto();
  });

  beforeEach(() => {
    sockets.length = 0;
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    for (const transport of createdTransports) transport.close();
    createdTransports.length = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export function makeTransport(clientIdentity: Identity, agentIdentity: Identity): RelayTransport {
  const transport = new RelayTransport({
    url: 'ws://fake/relay',
    identity: clientIdentity,
    agent: { agentId: fingerprint(agentIdentity.edPub), edPub: b64(agentIdentity.edPub) },
    clientName: 'test-client',
  });
  createdTransports.push(transport);
  return transport;
}

/** Разобранный клиентский hello: edPub для ECDH и челлендж, которым агент обязан
 *  подписать свой hello-ok. */
export interface ClientHello {
  edPub: Uint8Array;
  nonce: Uint8Array;
}

/** connect → {connected} → клиент шлёт plaintext hello. Возвращает edPub и челлендж. */
export function driveToHelloSent(ws: FakeWebSocket): ClientHello {
  ws.triggerOpen();
  ws.deliverText(JSON.stringify({ t: 'connected' }));
  const frame = decodeFrame(ws.sent[ws.sent.length - 1] as Uint8Array);
  const hello = JSON.parse(td.decode(frame.payload)) as { t: string; edPub: string; nonce: string };
  expect(hello.t).toBe('hello');
  return { edPub: unb64(hello.edPub), nonce: unb64(hello.nonce) };
}

/** Фиксированный челлендж для тестов (в проде — случайные 32 байта). */
export const NONCE = new Uint8Array(32).fill(7);

/** hello-ok, ПОДПИСАННЫЙ агентом челленджем клиента. Без валидной подписи клиент в
 *  streaming не входит — это и защищает его от переигрывания записанного потока. */
export function helloOkFrame(agentIdentity: Identity, serverHeader: Uint8Array, clientNonce: Uint8Array): Uint8Array {
  return jsonFrame(FrameType.Data, 0, {
    t: 'hello-ok',
    header: b64(serverHeader),
    nonce: b64(NONCE),
    sig: b64(sign(agentIdentity.edSec, serverHandshakeTranscript(clientNonce, serverHeader))),
  });
}

/** «Агент» отвечает hello-ok. Возвращает rx для расшифровки того, что клиент зашлёт дальше. */
export function respondHelloOk(ws: FakeWebSocket, agentIdentity: Identity, hello: ClientHello): Uint8Array {
  const { rx, tx } = sessionKeys('server', agentIdentity, hello.edPub);
  const agentEncryptor = makeEncryptor(tx);
  ws.deliverBinary(helloOkFrame(agentIdentity, agentEncryptor.header, hello.nonce));
  return rx;
}

/** Хендшейк на уже созданном сокете (первое подключение или реконнект): средства
 *  «агента» для ответов и индекс первого ЗАШИФРОВАННОГО кадра клиента в ws.sent. */
export function restream(
  ws: FakeWebSocket,
  agentIdentity: Identity,
): {
  agentEnc: ReturnType<typeof makeEncryptor>;
  agentDec: ReturnType<typeof makeDecryptor>;
  firstEncrypted: number;
} {
  const hello = driveToHelloSent(ws);
  const { rx, tx } = sessionKeys('server', agentIdentity, hello.edPub);
  const agentEnc = makeEncryptor(tx);
  const before = ws.sent.length;
  ws.deliverBinary(helloOkFrame(agentIdentity, agentEnc.header, hello.nonce));
  const fin = JSON.parse(td.decode(decodeFrame(ws.sent[before] as Uint8Array).payload)) as { header: string };
  return { agentEnc, agentDec: makeDecryptor(rx, unb64(fin.header)), firstEncrypted: before + 1 };
}

/** Доводит новый транспорт до streaming и возвращает средства «агента» для ответов. */
export function streaming(): {
  transport: RelayTransport;
  ws: FakeWebSocket;
  agentIdentity: Identity;
  agentEnc: ReturnType<typeof makeEncryptor>;
  agentDec: ReturnType<typeof makeDecryptor>;
  firstEncrypted: number;
} {
  const clientIdentity = generateIdentity();
  const agentIdentity = generateIdentity();
  const transport = makeTransport(clientIdentity, agentIdentity);
  const ws = sockets[0]!;
  return { transport, ws, agentIdentity, ...restream(ws, agentIdentity) };
}
