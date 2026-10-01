// @vitest-environment happy-dom
// Клиент ленты: один вызов `transport.feed()` поверх двух транспортов. LAN проверяется
// через подменённый fetch (что ушло в URL и что вернулось), relay — через FakeWebSocket
// с настоящей крипто (relay-harness.ts): какой кадр ушёл и какой ответ его закрыл.
// Тело ответа агента в тестах написано руками по interfaces.md, а не взято из кода.
import { decodeFrame, encodeFrame, frameJson, FrameType, generateIdentity, jsonFrame } from '@termhub/protocol';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { driveToHelloSent, installRelayHarness, makeTransport, sockets, streaming } from './relay-harness';
import { LanTransport } from '../src/transport';
import type { FeedResult } from '../src/transport';

installRelayHarness();

const te = new TextEncoder();

/** Страница ленты в том виде, в каком её отдаёт агент (одна и та же на обоих путях). */
const PAGE: FeedResult = {
  ok: true,
  agent: 'claude',
  entries: [
    { id: 'a1', at: 1_700_000_000_000, kind: 'human', text: 'привет', cursor: '77:0' },
    { id: 'a2', at: 1_700_000_001_000, kind: 'tool', text: 'прочитал файл', tool: 'Read' },
  ],
  head: '77:0',
  tail: '77:512',
  bof: false,
  eof: true,
  complete: true,
  live: true,
  skipped: 0,
};

/** Подменяет fetch ответом агента; возвращает журнал запрошенных URL. */
function stubFetch(body: unknown, init: { status?: number } = {}): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    urls.push(url);
    const status = init.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stub',
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('лента по LAN', () => {
  it('тянет GET /api/feed: имя сессии и заданные курсоры — параметрами запроса', async () => {
    const urls = stubFetch(PAGE);

    const result = await new LanTransport().feed('work', { limit: 100, before: '77:0' });

    expect(urls).toEqual(['/api/feed?session=work&limit=100&before=77%3A0']);
    expect(result).toEqual(PAGE);
  });

  it('без лимита и курсоров — только имя сессии: пустых параметров в строке нет', async () => {
    const urls = stubFetch(PAGE);

    await new LanTransport().feed('my project');

    expect(urls).toEqual(['/api/feed?session=my+project']);
  });
});

describe('лента через relay', () => {
  it('шлёт кадр Feed с теми же параметрами и резолвится ответом FeedResult', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();

    const page = transport.feed('work', { limit: 100, before: '77:0' });

    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Feed);
    expect(frameJson<Record<string, unknown>>(sent)).toEqual({ session: 'work', limit: 100, before: '77:0' });

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));
    await expect(page).resolves.toEqual(PAGE);
  });

  it('запрос один в полёте: второй уходит на провод, только когда закрылся первый', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();

    const first = transport.feed('work', { limit: 100 });
    const second = transport.feed('work', { after: '77:512' });
    expect(ws.sent.length).toBe(firstEncrypted + 1); // кадр ушёл ровно один

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));
    await expect(first).resolves.toEqual(PAGE);

    const sent = ws.sent.slice(firstEncrypted).map((b) => decodeFrame(agentDec.pull(b as Uint8Array)));
    expect(sent.map((f) => f.type)).toEqual([FrameType.Feed, FrameType.Feed]);
    expect(frameJson<Record<string, unknown>>(sent[1]!)).toEqual({ session: 'work', after: '77:512' });

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));
    await expect(second).resolves.toEqual(PAGE);
  });

  it('чужая сессия: отказ приезжает кадром ЛЕНТЫ, причиной-значением, а не исключением', async () => {
    const { transport, ws, agentEnc } = streaming();

    const page = transport.feed('secret');
    const refusal = { ok: false, reason: 'forbidden', detail: 'session not shared' };
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, refusal)));

    await expect(page).resolves.toEqual(refusal);
  });

  // Тем же Error{forbidden} агент отвечает гостю на девять других запросов контрольного
  // канала, а caffeinate гость повторяет раз в три секунды: приняв его за ответ ленты,
  // клиент показывал бы «сессия вам не открыта» вместо беседы.
  it('чужой отказ контрольного канала ленты не касается: её ответ узнаётся по типу кадра', async () => {
    const { transport, ws, agentEnc } = streaming();

    const page = transport.feed('work');
    let settled = false;
    void page.then(
      () => (settled = true),
      () => (settled = true),
    );

    ws.deliverBinary(
      agentEnc.push(
        jsonFrame(FrameType.Error, 0, { code: 'forbidden', message: 'Guest access: operation not allowed' }),
      ),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));
    await expect(page).resolves.toEqual(PAGE);
  });

  it('долг живёт свой срок, а не до разрыва: потерянный ответ не съедает следующие', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentEnc } = streaming();

    // Запрос сдался по таймауту, и ответа на него не будет вовсе (агент промолчал).
    const first = transport.feed('work');
    const firstFailed = expect(first).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    await firstFailed;

    // Долг протух вместе со своим запросом — следующий запрос получает СВОЙ ответ.
    await vi.advanceTimersByTimeAsync(3000);
    const second = transport.feed('work', { after: '77:512' });
    await vi.advanceTimersByTimeAsync(0);
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));

    await expect(second).resolves.toEqual(PAGE);
  });

  it('опоздавший после таймаута ответ не достаётся следующему запросу', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentEnc } = streaming();

    const first = transport.feed('work', { limit: 100 });
    const firstFailed = expect(first).rejects.toThrow(); // ждём отказа заранее: он придёт по таймеру
    await vi.advanceTimersByTimeAsync(10_000);
    await firstFailed;

    const second = transport.feed('work', { after: '77:512' });
    let settled = false;
    const secondFailed = expect(second).rejects.toThrow();
    void second.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(0); // очередь дошла до отправки второго

    // Ответ на ПЕРВЫЙ запрос, пришедший после его таймаута: чужим результатом не станет.
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, PAGE)));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await secondFailed;
  });
});

describe('relay: ветки, где ответа не будет', () => {
  it('поток ещё не установлен: отказ сразу — ни кадра, ни ожидания', async () => {
    vi.useFakeTimers();
    const transport = makeTransport(generateIdentity(), generateIdentity());
    const ws = sockets[0]!;
    driveToHelloSent(ws); // handshaking: до streaming дело ещё не дошло
    const sentBefore = ws.sent.length;
    const timersBefore = vi.getTimerCount();

    await expect(transport.feed('work')).rejects.toThrow('relay not streaming');

    expect(ws.sent.length).toBe(sentBefore);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('битый ответ — сломанный провод, а не отказ ленты: исключение', async () => {
    const { transport, ws, agentEnc } = streaming();

    const asked = transport.feed('work');
    ws.deliverBinary(
      agentEnc.push(encodeFrame({ type: FrameType.FeedResult, channel: 0, payload: te.encode('{ не json') })),
    );

    await expect(asked).rejects.toThrow('bad feed result');
  });

  it('обрыв разбирает и очередь: ждущий отправки запрос не остаётся висеть', async () => {
    const { transport, ws } = streaming();
    const first = transport.feed('work');
    const second = transport.feed('work', { after: '77:512' });
    const firstFailed = expect(first).rejects.toThrow('relay disconnected');
    const secondFailed = expect(second).rejects.toThrow('relay not streaming');
    const sentBefore = ws.sent.length;

    ws.close();

    await firstFailed;
    await secondFailed;
    expect(ws.sent.length).toBe(sentBefore); // на мёртвый провод второй кадр не ушёл
  });
});

describe('перечень опций один на оба пути', () => {
  it('что уходит в строку запроса, то и в тело кадра — ни один параметр не теряется', async () => {
    const opts = { limit: 50, before: '77:0', after: '77:512', around: '88:1' };
    const urls = stubFetch(PAGE);

    await new LanTransport().feed('work', opts);

    const { transport, ws, agentDec, firstEncrypted } = streaming();
    void transport.feed('work', opts);
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));

    expect(urls).toEqual(['/api/feed?session=work&limit=50&before=77%3A0&after=77%3A512&around=88%3A1']);
    expect(frameJson<Record<string, unknown>>(sent)).toEqual({ session: 'work', ...opts });
  });
});

describe('отказ и сбой различимы', () => {
  /** Отказ ленты: агент ответил, но беседы нет. Тело — из interfaces.md. */
  const FAILURE: FeedResult = { ok: false, reason: 'no-transcript', detail: 'no transcript file' };

  it('отказ агента — одно и то же ЗНАЧЕНИЕ по LAN и через relay', async () => {
    stubFetch(FAILURE);
    const lan = await new LanTransport().feed('work');

    const { transport, ws, agentEnc } = streaming();
    const asked = transport.feed('work');
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, FAILURE)));
    const relay = await asked;

    expect(lan).toEqual(FAILURE);
    expect(relay).toEqual(lan);
  });

  it('сбой связи — исключение на обоих путях', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')));
    await expect(new LanTransport().feed('work')).rejects.toThrow();

    const { transport, ws } = streaming();
    const asked = transport.feed('work');
    ws.close(); // relay оборвался, не ответив

    await expect(asked).rejects.toThrow();
  });
});
