import { describe, it, expect, vi, afterEach } from 'vitest';
import { RtcSocket, type RtcChannelLike, type RtcPeerLike } from '../src/rtcsock.js';

/** Подставное соединение: открывает канал сразу после ответа сигнализации. */
function fakePeer(): { peer: RtcPeerLike; channel: RtcChannelLike; state(next: string): void } {
  const channel: RtcChannelLike = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    readyState: 'connecting',
    send: () => undefined,
    close: () => undefined,
  };
  const peer: RtcPeerLike = {
    createDataChannel: () => channel,
    createOffer: async () => ({ type: 'offer', sdp: 'v=0\r\na=mid:0' }),
    setLocalDescription: async () => undefined,
    setRemoteDescription: async () => {
      channel.readyState = 'open';
      channel.onopen?.(undefined as never);
    },
    close: () => undefined,
    connectionState: 'new',
  };
  return {
    peer,
    channel,
    state(next) {
      peer.connectionState = next;
      peer.onconnectionstatechange?.(undefined as never);
    },
  };
}

const answer = (async () => new Response(JSON.stringify({ sdp: 'v=0' }), { status: 200 })) as unknown as typeof fetch;

async function opened(): Promise<{ sock: RtcSocket; fake: ReturnType<typeof fakePeer>; closes: number[]; available: boolean[] }> {
  const fake = fakePeer();
  const closes: number[] = [];
  const available: boolean[] = [];
  const sock = new RtcSocket('wss://relay.example.com/relay', {
    fetch: answer,
    peer: () => fake.peer,
    onAvailable: () => available.push(true),
    onUnavailable: () => available.push(false),
  });
  sock.onclose = (ev) => closes.push(ev.code);
  await vi.waitFor(() => expect(sock.readyState).toBe(RtcSocket.OPEN));
  return { sock, fake, closes, available };
}

afterEach(() => vi.useRealTimers());

describe('RtcSocket: потеря пути', () => {
  it('открывшийся канал сообщает, что способ работает', async () => {
    const { available } = await opened();
    expect(available).toEqual([true]);
  });

  it('«связь пропала» дольше 4 секунд — сокет закрывается сам, не дожидаясь канала', async () => {
    const { fake, closes } = await opened();
    vi.useFakeTimers();
    fake.state('disconnected');
    vi.advanceTimersByTime(3999);
    expect(closes).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closes).toEqual([1006]);
  });

  it('короткий провал, который браузер починил сам, соединение не рвёт', async () => {
    const { fake, closes, sock } = await opened();
    vi.useFakeTimers();
    fake.state('disconnected');
    vi.advanceTimersByTime(2000);
    fake.state('connected');
    vi.advanceTimersByTime(60_000);
    expect(closes).toEqual([]);
    expect(sock.readyState).toBe(RtcSocket.OPEN);
  });

  it('«соединение не удалось» закрывает сразу; уже открывавшийся сокет недоступным не называется', async () => {
    const { fake, closes, available } = await opened();
    fake.state('failed');
    expect(closes).toEqual([1006]);
    expect(available).toEqual([true]);
  });

  it('отказ сигнализации: способ недоступен', async () => {
    const fake = fakePeer();
    const outcome = await new Promise<string>((resolve) => {
      const sock = new RtcSocket('wss://relay.example.com/relay', {
        fetch: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch,
        peer: () => fake.peer,
        onAvailable: () => resolve('available'),
        onUnavailable: () => resolve('unavailable'),
      });
      sock.onopen = () => resolve('open');
    });
    expect(outcome).toBe('unavailable');
  });
});
