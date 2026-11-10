// WebRTC DataChannel как транспорт relay: живой relay, клиент — тот же RtcSocket, что в
// браузере, поверх werift вместо браузерного RTCPeerConnection.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { RTCPeerConnection } from 'werift';
import {
  initCrypto,
  generateIdentity,
  fingerprint,
  sign,
  RtcSocket,
  stripCandidates,
  type Identity,
  type RtcPeerLike,
} from '@termhub/protocol';
import { startRelay, type RelayHandle } from '../src/index.js';
import { advertise } from '../src/rtc.js';

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

let nextPort = 41000 + Math.floor(Math.random() * 2000);
async function relay(over: object = {}): Promise<RelayHandle> {
  const from = (nextPort += 10);
  const handle = await startRelay({ port: 0, silent: true, rtc: { portRange: [from, from + 8] }, ...over });
  closers.push(() => handle.close());
  return handle;
}

const peer = (): RtcPeerLike =>
  new RTCPeerConnection({ iceServers: [], iceUseDefaultStunServer: false, iceUseIpv6: false }) as unknown as RtcPeerLike;

function openRtc(port: number): Promise<RtcSocket> {
  const sock = new RtcSocket(`ws://127.0.0.1:${port}/relay`, { peer });
  closers.push(() => sock.close());
  return new Promise((resolve, reject) => {
    sock.onopen = () => resolve(sock);
    sock.onclose = () => reject(new Error('rtc socket closed before open'));
  });
}

interface Inbox {
  next(): Promise<string | Buffer>;
}
function inboxOf(subscribe: (push: (m: string | Buffer) => void) => void): Inbox {
  const queue: Array<string | Buffer> = [];
  const waiters: Array<(m: string | Buffer) => void> = [];
  subscribe((m) => {
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

async function agentOn(port: number): Promise<{ ws: WebSocket; inbox: Inbox; agentId: string }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  closers.push(() => ws.terminate());
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve());
    ws.on('error', reject);
  });
  const inbox = inboxOf((push) => ws.on('message', (d: Buffer, bin: boolean) => push(bin ? d : d.toString('utf8'))));
  ws.send(JSON.stringify({ t: 'register', edPub: b64(identity.edPub) }));
  const challenge = JSON.parse((await inbox.next()) as string) as { nonce: string };
  ws.send(JSON.stringify({ t: 'prove', sig: b64(sign(identity.edSec, Buffer.from(challenge.nonce, 'base64'))) }));
  const { agentId } = JSON.parse((await inbox.next()) as string) as { agentId: string };
  expect(agentId).toBe(fingerprint(identity.edPub));
  return { ws, inbox, agentId };
}

describe('транспорт WebRTC DataChannel', () => {
  it('клиент по каналу данных и агент на WebSocket обмениваются бинарём в обе стороны', async () => {
    const handle = await relay();
    const agent = await agentOn(handle.port);
    const client = await openRtc(handle.port);
    const clientIn = inboxOf((push) => {
      client.onmessage = (ev) => push(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data));
    });
    client.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    expect(JSON.parse((await agent.inbox.next()) as string)).toEqual({ t: 'client-open', connId: 1 });
    expect(JSON.parse((await clientIn.next()) as string)).toEqual({ t: 'connected' });

    // оба сообщения больше одного куска канала — проверяется склейка
    // вверх — больше порога буфера канала: очередь обязана дойти и без события «буфер опустел»
    const up = Buffer.from(Uint8Array.from({ length: 2_500_000 }, (_, i) => (i * 7) & 255));
    client.send(up);
    const atAgent = (await agent.inbox.next()) as Buffer;
    expect(atAgent.readUInt32BE(0)).toBe(1);
    expect(atAgent.subarray(4).equals(up)).toBe(true);

    const down = Buffer.from(Uint8Array.from({ length: 300_000 }, (_, i) => (i * 13) & 255));
    agent.ws.send(Buffer.concat([Buffer.from([0, 0, 0, 1]), down]), { binary: true });
    expect(((await clientIn.next()) as Buffer).equals(down)).toBe(true);
  }, 20_000);

  it('отказ relay доезжает клиенту кодом закрытия, уход клиента — агенту', async () => {
    const handle = await relay();
    const lone = await openRtc(handle.port);
    const closed = new Promise<number>((resolve) => {
      lone.onclose = (ev) => resolve(ev.code);
    });
    lone.send(JSON.stringify({ t: 'connect', agentId: 'NOSUCHAGENT' }));
    expect(await closed).toBe(4004);

    const agent = await agentOn(handle.port);
    const client = await openRtc(handle.port);
    client.send(JSON.stringify({ t: 'connect', agentId: agent.agentId }));
    expect(JSON.parse((await agent.inbox.next()) as string)).toEqual({ t: 'client-open', connId: 1 });
    client.close();
    expect(JSON.parse((await agent.inbox.next()) as string)).toEqual({ t: 'client-close', connId: 1 });
  }, 20_000);

  it('relay без WebRTC: сигнализация отвечает отказом, клиент узнаёт, что способ недоступен', async () => {
    const handle = await startRelay({ port: 0, silent: true, clientTransport: 'rtc' });
    closers.push(() => handle.close());
    const mode = (await (await fetch(`http://127.0.0.1:${handle.port}/api/mode`)).json()) as { transport: string };
    expect(mode.transport).toBe('poll'); // совет 'rtc' без поднятого WebRTC не выдаётся
    const unavailable = await new Promise<boolean>((resolve) => {
      const sock = new RtcSocket(`ws://127.0.0.1:${handle.port}/relay`, { peer, onUnavailable: () => resolve(true) });
      sock.onopen = () => resolve(false);
    });
    expect(unavailable).toBe(true);
  });

  it('сигнализация: не POST — 405, мусор — 400', async () => {
    const handle = await relay();
    const url = `http://127.0.0.1:${handle.port}/relay/rtc`;
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ sdp: 42 }) })).status).toBe(400);
  });

  it('кандидаты клиента вырезаются, внешний адрес подставляется в ответ', () => {
    const offer = 'v=0\r\na=candidate:1 1 udp 2130706431 192.168.1.5 50000 typ host\r\na=end-of-candidates\r\na=mid:0';
    expect(stripCandidates(offer)).toBe('v=0\r\na=mid:0');
    const answer = 'v=0\r\nc=IN IP4 172.18.0.3\r\na=candidate:1 1 udp 2130706431 172.18.0.3 9450 typ host\r\na=mid:0';
    expect(advertise(answer, '203.0.113.10')).toBe(
      'v=0\r\nc=IN IP4 203.0.113.10\r\na=candidate:1 1 udp 2130706431 203.0.113.10 9450 typ host\r\na=mid:0',
    );
    expect(advertise(answer, undefined)).toBe(answer);
  });
});
