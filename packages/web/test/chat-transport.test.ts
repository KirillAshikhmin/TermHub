// @vitest-environment happy-dom
// Методы чата транспорта: live / act / commands / feedDetail / pasteFile на двух проводах.
// LAN — подменённый fetch (что ушло и что вернулось), relay — FakeWebSocket с настоящей
// крипто (relay-harness.ts). Формы тел — по interfaces.md, написаны руками.
import { decodeFrame, encodeFrame, frameJson, FrameType, jsonFrame } from '@termhub/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installRelayHarness, streaming } from './relay-harness';
import { LanTransport } from '../src/transport';

installRelayHarness();

const LIVE = {
  ok: true,
  agent: 'claude',
  tested: true,
  screen: { kind: 'idle' },
  modes: [{ id: 'manual', label: 'Manual' }],
  models: [],
};

interface Call {
  url: string;
  init?: RequestInit;
}

function stubFetch(body: unknown, status = 200): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'stub',
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    } as unknown as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('чат по LAN', () => {
  it('live: GET /api/live?session=', async () => {
    const calls = stubFetch(LIVE);
    const res = await new LanTransport().live('my work');
    expect(calls.map((c) => c.url)).toEqual(['/api/live?session=my%20work']);
    expect(res).toEqual(LIVE);
  });

  it('act: POST /api/act с {session, action}', async () => {
    const calls = stubFetch({ ok: true, screen: { kind: 'working' } });
    await new LanTransport().act('work', { kind: 'prompt', text: 'привет' });
    expect(calls[0]!.url).toBe('/api/act');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      session: 'work',
      action: { kind: 'prompt', text: 'привет' },
    });
  });

  it('commands со сверкой: POST /api/commands {session, verify: true}', async () => {
    const calls = stubFetch({ ok: true, commands: [], verified: true });
    await new LanTransport().commands('my work', { verify: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/commands');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ session: 'my work', verify: true });
  });

  it('commands: GET /api/commands?session=', async () => {
    const calls = stubFetch({ ok: true, commands: [], verified: false });
    await new LanTransport().commands('work');
    expect(calls.map((c) => c.url)).toEqual(['/api/commands?session=work']);
  });

  it('feedDetail: GET /api/feed с detail=<курсор> и именем сессии', async () => {
    const calls = stubFetch({ ok: true, input: 'npm test' });
    const res = await new LanTransport().feedDetail('work', '77:512');
    expect(calls.map((c) => c.url)).toEqual(['/api/feed?session=work&detail=77%3A512']);
    expect(res).toEqual({ ok: true, input: 'npm test' });
  });

  it('pasteFile: тело — сам файл, тип и имя — параметрами; ответ — путь', async () => {
    const calls = stubFetch({ path: '/h/paste-1.pdf' });
    const blob = new Blob(['x'], { type: 'application/pdf' });
    const path = await new LanTransport().pasteFile(blob, 'отчёт 1.pdf');
    expect(path).toBe('/h/paste-1.pdf');
    expect(calls[0]!.url).toBe(
      `/api/paste-image?type=${encodeURIComponent('application/pdf')}&name=${encodeURIComponent('отчёт 1.pdf')}`,
    );
    expect(calls[0]!.init?.body).toBe(blob);
  });
});

describe('чат через relay', () => {
  it('live: кадр Live с id, ответ с тем же id закрывает запрос; id в теле результата нет', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.live('work');
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Live);
    const req = frameJson<{ id: number; session: string }>(sent);
    expect(req.session).toBe('work');
    expect(typeof req.id).toBe('number');
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.LiveResult, 0, { id: req.id, ...LIVE })));
    await expect(p).resolves.toEqual(LIVE);
  });

  it('act: кадр Act несёт action; ответ — ActResult', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.act('work', { kind: 'interrupt' });
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Act);
    const req = frameJson<{ id: number; action: unknown }>(sent);
    expect(req.action).toEqual({ kind: 'interrupt' });
    const refusal = { ok: false, reason: 'stale', detail: 'screen changed' };
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.ActResult, 0, { id: req.id, ...refusal })));
    await expect(p).resolves.toEqual(refusal);
  });

  it('commands со сверкой: кадр Commands {id, session, verify: true}; обычное чтение поля verify не несёт', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.commands('work', { verify: true });
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Commands);
    const req = frameJson<{ id: number; session: string; verify?: boolean }>(sent);
    expect(req).toEqual({ id: req.id, session: 'work', verify: true });
    const body = { ok: true, commands: [], verified: true };
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CommandsResult, 0, { id: req.id, ...body })));
    await expect(p).resolves.toEqual(body);

    const plainCall = transport.commands('work');
    const next = decodeFrame(agentDec.pull(ws.sent[firstEncrypted + 1] as Uint8Array));
    const plainReq = frameJson<{ id: number; session: string }>(next);
    expect(plainReq).toEqual({ id: plainReq.id, session: 'work' });
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CommandsResult, 0, { id: plainReq.id, ...body })));
    await plainCall;
  });

  it('commands: кадр Commands', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.commands('work');
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Commands);
    const req = frameJson<{ id: number }>(sent);
    const body = { ok: true, commands: [{ name: 'help', source: 'builtin' }], verified: true };
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CommandsResult, 0, { id: req.id, ...body })));
    await expect(p).resolves.toEqual(body);
  });

  it('два запроса вперемешку: каждый получает СВОЙ ответ, даже если ответы пришли в обратном порядке', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const a = transport.live('a');
    const b = transport.live('b');
    const ids = ws.sent
      .slice(firstEncrypted)
      .map((x) => frameJson<{ id: number; session: string }>(decodeFrame(agentDec.pull(x as Uint8Array))));
    expect(ids.map((r) => r.session)).toEqual(['a', 'b']);
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.LiveResult, 0, { id: ids[1]!.id, ...LIVE, version: 'B' })));
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.LiveResult, 0, { id: ids[0]!.id, ...LIVE, version: 'A' })));
    await expect(a).resolves.toMatchObject({ version: 'A' });
    await expect(b).resolves.toMatchObject({ version: 'B' });
  });

  it('срок ответа 10 с; опоздавший ответ не достаётся следующему запросу', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const first = transport.live('work');
    const firstFailed = expect(first).rejects.toThrow('live timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await firstFailed;

    const second = transport.live('work');
    let settled = false;
    const secondFailed = expect(second).rejects.toThrow();
    void second.then(
      () => (settled = true),
      () => (settled = true),
    );
    const reqs = ws.sent
      .slice(firstEncrypted)
      .map((x) => frameJson<{ id: number }>(decodeFrame(agentDec.pull(x as Uint8Array))));
    // Ответ на первый (опоздавший) — чужим результатом не становится.
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.LiveResult, 0, { id: reqs[0]!.id, ...LIVE })));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await secondFailed;
  });

  it('act ждёт дольше остальных: агент нажимает клавиши до 45 с, и ответ после 10 с ещё принимается', async () => {
    vi.useFakeTimers();
    try {
      const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
      // Связь жива: агент отвечает на проверки, просто действие ещё не закончил.
      const alive = async (seconds: number): Promise<void> => {
        for (let i = 0; i < seconds; i += 5) {
          await vi.advanceTimersByTimeAsync(5000);
          ws.deliverBinary(agentEnc.push(encodeFrame({ type: FrameType.Pong, channel: 0, payload: new Uint8Array(0) })));
        }
      };
      const p = transport.act('work', { kind: 'prompt', text: 'hi' });
      let failed: unknown;
      p.catch((e) => (failed = e));
      const req = frameJson<{ id: number }>(decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array)));
      await alive(40);
      expect(failed).toBeUndefined();
      const body = { ok: true, screen: { kind: 'working' } };
      ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.ActResult, 0, { id: req.id, ...body })));
      await expect(p).resolves.toEqual(body);

      const late = transport.act('work', { kind: 'interrupt' });
      const lateFailed = expect(late).rejects.toThrow('act timeout');
      await alive(45);
      await lateFailed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('feedDetail: кадр Feed с detail; ответ — FeedResult', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.feedDetail('work', '77:512');
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Feed);
    expect(frameJson(sent)).toEqual({ session: 'work', detail: '77:512' });
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FeedResult, 0, { ok: true, output: 'ok' })));
    await expect(p).resolves.toEqual({ ok: true, output: 'ok' });
  });

  it('pasteFile: куски через paste-chunk, имя едет с первым и каждым куском; путь — в ответе на последний', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const blob = new Blob([new Uint8Array(10)], { type: 'application/zip' });
    const p = transport.pasteFile(blob, 'a.zip');
    await vi.waitFor(() => expect(ws.sent.length).toBeGreaterThan(firstEncrypted));
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.FileOp);
    const req = frameJson<{ id: number; action: string; type: string; name: string; last: boolean }>(sent);
    expect(req).toMatchObject({ action: 'paste-chunk', type: 'application/zip', name: 'a.zip', last: true });
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FileOpResult, 0, { id: req.id, result: { path: '/h/p.zip' } })));
    await expect(p).resolves.toBe('/h/p.zip');
  });
});
