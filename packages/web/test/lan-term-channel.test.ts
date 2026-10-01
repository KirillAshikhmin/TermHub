// @vitest-environment happy-dom
// LAN-канал терминала (transport.ts) на поддельном WebSocket: просьба о способе
// подключения едет ПЕРВЫМ кадром RESIZE (только на нём агент создаёт терминал),
// а кадр состояния терминала доходит до экрана.
import { frameJson, FrameType, jsonFrame } from '@termhub/protocol/frames';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LanTransport } from '../src/transport';
import type { TermChannelOpts } from '../src/transport';
import { decodeFrame } from '../src/ws-frames';

/** Глухая эмуляция browser WebSocket: ничего не решает сама, всё двигает тест. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  binaryType = '';
  readyState: number = FakeWebSocket.CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: Uint8Array[] = [];

  constructor(public readonly url: string) {
    sockets.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  /** Соединение поднялось — канал получает onopen и начинает слать кадры. */
  triggerOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  /** Кадр от агента (клиент принимает только ArrayBuffer). */
  deliver(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  }
}

let sockets: FakeWebSocket[] = [];

beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function opts(extra: Partial<TermChannelOpts> = {}): TermChannelOpts {
  return {
    cols: 80,
    rows: 24,
    onData: () => {},
    onBell: () => {},
    onEnd: () => {},
    onStatus: () => {},
    ...extra,
  };
}

/** Полезная нагрузка отправленного кадра по индексу. */
function payload(ws: FakeWebSocket, index: number): Record<string, unknown> {
  return frameJson<Record<string, unknown>>(decodeFrame(ws.sent[index]!));
}

describe('LAN-канал: просьба о способе подключения', () => {
  it('едет в ПЕРВОМ кадре RESIZE; следующие ресайзы её не повторяют', () => {
    const channel = new LanTransport().openTerm('work', opts({ mode: 'attach' }));
    const ws = sockets[0]!;
    ws.triggerOpen();

    channel.resize(80, 24);
    channel.resize(100, 30);

    expect(decodeFrame(ws.sent[0]!).type).toBe(FrameType.Resize);
    expect(payload(ws, 0)).toEqual({ cols: 80, rows: 24, mode: 'attach' });
    expect(payload(ws, 1)).toEqual({ cols: 100, rows: 30 });
    channel.close();
  });

  it('без просьбы кадр RESIZE прежней формы — {cols, rows}', () => {
    const channel = new LanTransport().openTerm('work', opts());
    const ws = sockets[0]!;
    ws.triggerOpen();

    channel.resize(80, 24);

    expect(payload(ws, 0)).toEqual({ cols: 80, rows: 24 });
    channel.close();
  });

  it('после обрыва просьба уходит снова: агент создаёт терминал заново на каждом подключении', () => {
    vi.useFakeTimers();
    const channel = new LanTransport().openTerm('work', opts({ mode: 'attach' }));
    const first = sockets[0]!;
    first.triggerOpen();
    channel.resize(80, 24);

    first.close();
    vi.advanceTimersByTime(1000); // backoff первого реконнекта
    expect(sockets).toHaveLength(2);
    const second = sockets[1]!;
    second.triggerOpen();
    channel.resize(80, 24);

    expect(payload(second, 0)).toEqual({ cols: 80, rows: 24, mode: 'attach' });
    channel.close();
  });
});

describe('LAN-канал: кадр состояния терминала', () => {
  it('доходит до экрана как есть — режим и признак альтернативного экрана', () => {
    const states: unknown[] = [];
    const channel = new LanTransport().openTerm('work', opts({ onTerminalState: (s) => states.push(s) }));
    const ws = sockets[0]!;
    ws.triggerOpen();

    ws.deliver(jsonFrame(FrameType.TerminalState, 0, { mode: 'control' }));
    ws.deliver(jsonFrame(FrameType.TerminalState, 0, { altScreen: true }));

    expect(states).toEqual([{ mode: 'control' }, { altScreen: true }]);
    channel.close();
  });

  it('чужие значения полей отброшены: до экрана доходит пустое состояние, канал жив', () => {
    const states: unknown[] = [];
    const channel = new LanTransport().openTerm('work', opts({ onTerminalState: (s) => states.push(s) }));
    const ws = sockets[0]!;
    ws.triggerOpen();

    ws.deliver(jsonFrame(FrameType.TerminalState, 0, { mode: 'turbo', altScreen: 'yes' }));

    expect(states).toEqual([{}]); // чужие значения отброшены, поля не появились
    channel.close();
  });
});
