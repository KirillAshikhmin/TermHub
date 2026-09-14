// @vitest-environment happy-dom
// Юнит-тесты RelayTransport БЕЗ реального relay/агента: обвязка (FakeWebSocket, хендшейк
// «агента» настоящей крипто) — в relay-harness.ts, общая с тестами клиента ленты.
import {
  decodeFrame,
  frameJson,
  FrameType,
  generateIdentity,
  jsonFrame,
  makeDecryptor,
  makeEncryptor,
  sessionKeys,
  type Identity,
} from '@termhub/protocol';
import { describe, expect, it, vi } from 'vitest';

import { b64, unb64 } from '../src/b64';
import {
  driveToHelloSent,
  helloOkFrame,
  installRelayHarness,
  makeTransport,
  NONCE,
  respondHelloOk,
  restream,
  sockets,
  streaming,
  type FakeWebSocket,
} from './relay-harness';
import type { RelayTransport } from '../src/relay-transport';
import type { TermChannelOpts } from '../src/transport';

const td = new TextDecoder();
const te = new TextEncoder();

installRelayHarness();

function noopOpts(extra: Partial<TermChannelOpts> = {}): TermChannelOpts {
  return { cols: 80, rows: 24, onData: () => {}, onBell: () => {}, onEnd: () => {}, onStatus: () => {}, ...extra };
}

describe('RelayTransport — onStreamReady: re-OPEN уходит раньше outbox', () => {
  it('первое подключение: DATA, набранная во время handshaking, доходит агенту ПОСЛЕ OPEN своего канала', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    const hello = driveToHelloSent(ws);

    // Пользователь открывает терминал и печатает ДО завершения хендшейка — канал
    // ещё не был OPEN-нут агенту, поэтому DATA осядет в outbox (state !== 'streaming').
    const term = transport.openTerm('work', noopOpts());
    term.write(te.encode('ls\n'));
    const sentBeforeStreaming = ws.sent.length;

    const rx = respondHelloOk(ws, agentIdentity, hello);

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
    const hello = driveToHelloSent(ws);
    expect(transport.isStreaming).toBe(false);
    respondHelloOk(ws, agentIdentity, hello);
    expect(transport.isStreaming).toBe(true);
  });

  // Ключи выводятся из статических Ed25519, поэтому записанный поток агента
  // расшифровался бы повторно. Единственное, что отличает живого агента от relay,
  // переигрывающего запись, — свежая подпись под НАШИМ челленджем.
  it('hello-ok без подписи агента → в streaming не входим', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    const hello = driveToHelloSent(ws);
    const { tx } = sessionKeys('server', agentIdentity, hello.edPub);
    const agentEnc = makeEncryptor(tx);
    ws.deliverBinary(jsonFrame(FrameType.Data, 0, { t: 'hello-ok', header: b64(agentEnc.header), nonce: b64(NONCE) }));
    expect(transport.isStreaming).toBe(false);
  });

  it('переигранный hello-ok (подпись под ЧУЖИМ челленджем) → в streaming не входим', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    const hello = driveToHelloSent(ws);
    const { tx } = sessionKeys('server', agentIdentity, hello.edPub);
    const agentEnc = makeEncryptor(tx);
    // Запись прошлой сессии: настоящая подпись агента, но под челленджем ТОЙ сессии.
    const recorded = new Uint8Array(32).fill(3);
    ws.deliverBinary(helloOkFrame(agentIdentity, agentEnc.header, recorded));
    expect(transport.isStreaming).toBe(false);
  });

  it('hello-ok, подписанный НЕ агентом (ключ relay), → в streaming не входим', () => {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const rogue = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;

    const hello = driveToHelloSent(ws);
    const { tx } = sessionKeys('server', agentIdentity, hello.edPub);
    const agentEnc = makeEncryptor(tx);
    ws.deliverBinary(helloOkFrame(rogue, agentEnc.header, hello.nonce));
    expect(transport.isStreaming).toBe(false);
  });

  it('челлендж клиента различается между подключениями (иначе подпись переиспользуема)', () => {
    vi.useFakeTimers();
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);

    const first = driveToHelloSent(sockets[0]!);
    respondHelloOk(sockets[0]!, agentIdentity, first);
    expect(transport.isStreaming).toBe(true);

    sockets[0]!.close();
    vi.advanceTimersByTime(1000);
    const second = driveToHelloSent(sockets[1]!);

    expect(b64(second.nonce)).not.toBe(b64(first.nonce));
  });
});

describe('RelayTransport — способ подключения терминала', () => {
  it('OPEN несёт просьбу о режиме: терминал relay создаётся на OPEN, к RESIZE решение уже принято', () => {
    const { transport, ws, agentDec, firstEncrypted } = streaming();

    transport.openTerm('work', noopOpts({ mode: 'attach' }));

    const open = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(open.type).toBe(FrameType.Open);
    expect(frameJson<Record<string, unknown>>(open)).toEqual({ session: 'work', mode: 'attach' });
  });

  it('без просьбы OPEN прежней формы — {session}', () => {
    const { transport, ws, agentDec, firstEncrypted } = streaming();

    transport.openTerm('work', noopOpts());

    const open = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(frameJson<Record<string, unknown>>(open)).toEqual({ session: 'work' });
  });

  it('после обрыва re-OPEN снова несёт просьбу: агент выбирает режим заново на каждое открытие', () => {
    vi.useFakeTimers();
    const { transport, ws, agentIdentity } = streaming();
    transport.openTerm('work', noopOpts({ mode: 'attach' }));

    ws.close();
    vi.advanceTimersByTime(1000); // backoff реконнекта
    expect(sockets).toHaveLength(2);
    const ws2 = sockets[1]!;
    const again = restream(ws2, agentIdentity);

    const open = decodeFrame(again.agentDec.pull(ws2.sent[again.firstEncrypted] as Uint8Array));
    expect(open.type).toBe(FrameType.Open);
    expect(frameJson<Record<string, unknown>>(open)).toEqual({ session: 'work', mode: 'attach' });
  });

  it('кадр состояния терминала доходит до своего канала, а не до соседнего', () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const work: unknown[] = [];
    const play: unknown[] = [];
    transport.openTerm('work', noopOpts({ onTerminalState: (s) => work.push(s) }));
    transport.openTerm('play', noopOpts({ onTerminalState: (s) => play.push(s) }));
    const workChannel = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array)).channel;

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.TerminalState, workChannel, { mode: 'control', altScreen: true })));

    expect(work).toEqual([{ mode: 'control', altScreen: true }]);
    expect(play).toEqual([]);
  });
});

describe('RelayTransport — сопоставление ответов по id, а не по порядку', () => {

  /** Расшифровывает запросы, отправленные клиентом после хендшейка. */
  function sentRequests(ws: FakeWebSocket, agentDec: ReturnType<typeof makeDecryptor>, fromIdx: number): Array<Record<string, unknown>> {
    return ws.sent.slice(fromIdx).map((b) => frameJson<Record<string, unknown>>(decodeFrame(agentDec.pull(b as Uint8Array))));
  }

  it('два конкурентных fileStat: ответы в ОБРАТНОМ порядке приходят каждому своему промису', async () => {
    const { transport, ws, agentEnc, agentDec } = streaming();
    const from = ws.sent.length;
    const pA = transport.fileStat('/root', 'a.txt');
    const pB = transport.fileStat('/root', 'b.txt');
    const reqs = sentRequests(ws, agentDec, from);
    expect(reqs).toHaveLength(2);
    const idA = reqs[0]!.id as number;
    const idB = reqs[1]!.id as number;
    expect(idA).not.toBe(idB);

    // Агент отвечает в обратном порядке (медленный первый файл) — раньше это давало
    // перепутанные результаты: A получал stat от B.
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FileStatResult, 0, { id: idB, stat: { size: 22, mime: 'text/plain', kind: 'text' } })));
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FileStatResult, 0, { id: idA, stat: { size: 11, mime: 'text/plain', kind: 'text' } })));

    expect((await pA).size).toBe(11);
    expect((await pB).size).toBe(22);
  });

  it('ответ на УЖЕ отвалившийся по таймауту запрос не достаётся следующему ожидающему', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentEnc, agentDec } = streaming();
    const from = ws.sent.length;
    const pA = transport.filesList('/root', 'slow');
    const expectA = expect(pA).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(11_000); // A отваливается по таймауту
    await expectA;

    const pB = transport.filesList('/root', 'fast');
    const reqs = sentRequests(ws, agentDec, from);
    const idA = reqs[0]!.id as number;
    const idB = reqs[1]!.id as number;

    // Запоздавший ответ на A не должен разрешить B (раньше FIFO отдавал его B).
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FilesListResult, 0, { id: idA, entries: [{ name: 'wrong' }] })));
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FilesListResult, 0, { id: idB, entries: [{ name: 'right' }] })));
    const entries = (await pB) as Array<{ name: string }>;
    expect(entries[0]!.name).toBe('right');
  });

  it('gradle(): кадр Gradle с action и params, ответ по id — result резолвит, error отклоняет', async () => {
    const { transport, ws, agentEnc, agentDec } = streaming();
    const from = ws.sent.length;
    const pRun = transport.gradle('run', { session: 'app', tasks: [':app:assembleDebug'], subdir: '' });
    const pStop = transport.gradle('stop', { session: 'app' });
    const frames = ws.sent.slice(from).map((b) => decodeFrame(agentDec.pull(b as Uint8Array)));
    expect(frames.map((f) => f.type)).toEqual([FrameType.Gradle, FrameType.Gradle]);
    const reqs = frames.map((f) => frameJson<Record<string, unknown>>(f));
    expect(reqs[0]!.action).toBe('run');
    expect(reqs[0]!.session).toBe('app');
    expect(reqs[0]!.tasks).toEqual([':app:assembleDebug']);
    const idRun = reqs[0]!.id as number;
    const idStop = reqs[1]!.id as number;

    // Ответы приходят в обратном порядке — каждый должен найти свой промис по id.
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.GradleResult, 0, { id: idStop, error: 'no write permission' })));
    ws.deliverBinary(
      agentEnc.push(jsonFrame(FrameType.GradleResult, 0, { id: idRun, result: { phase: 'running' } })),
    );
    await expect(pStop).rejects.toThrow('no write permission');
    expect(await pRun).toEqual({ phase: 'running' });
  });
});

describe('RelayTransport — create() дожидается подтверждения агента', () => {
  /** Доводит до streaming и возвращает средства «агента»: encryptor для ответных кадров
   *  клиенту и decryptor для чтения того, что клиент отправил. */
  function driveToStreaming(): {
    transport: RelayTransport;
    ws: FakeWebSocket;
    agentEnc: ReturnType<typeof makeEncryptor>;
    agentDec: ReturnType<typeof makeDecryptor>;
  } {
    const clientIdentity = generateIdentity();
    const agentIdentity = generateIdentity();
    const transport = makeTransport(clientIdentity, agentIdentity);
    const ws = sockets[0]!;
    const hello = driveToHelloSent(ws);
    const { rx, tx } = sessionKeys('server', agentIdentity, hello.edPub);
    const agentEnc = makeEncryptor(tx);
    const before = ws.sent.length;
    ws.deliverBinary(helloOkFrame(agentIdentity, agentEnc.header, hello.nonce));
    expect(transport.isStreaming).toBe(true);
    const fin = JSON.parse(td.decode(decodeFrame(ws.sent[before] as Uint8Array).payload)) as { header: string };
    return { transport, ws, agentEnc, agentDec: makeDecryptor(rx, unb64(fin.header)) };
  }

  it('резолвится ФАКТИЧЕСКИМ именем из CreateOk.session (агент мог пронумеровать: x → x1); в кадре Create уехал autoName', async () => {
    const { transport, ws, agentEnc, agentDec } = driveToStreaming();
    const from = ws.sent.length;
    const p = transport.create({ name: 'x', root: '/r', dir: 'd', preset: 'zsh', autoName: true });
    // Признак autoName обязан доехать до агента в кадре Create — без него агент не
    // нумерует занятое имя, а отказывает.
    const sent = ws.sent.slice(from).map((b) => decodeFrame(agentDec.pull(b as Uint8Array)));
    expect(sent.map((f) => f.type)).toEqual([FrameType.Create]);
    expect(frameJson<Record<string, unknown>>(sent[0]!)).toMatchObject({ name: 'x', root: '/r', dir: 'd', preset: 'zsh', autoName: true });

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CreateOk, 0, { session: 'x1' })));
    await expect(p).resolves.toBe('x1');
  });

  it('CreateOk без поля session (старый агент) → резолвится запрошенным именем', async () => {
    const { transport, ws, agentEnc } = driveToStreaming();
    const p = transport.create({ name: 'x', root: '/r', dir: 'd', preset: 'zsh' });
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CreateOk, 0, {})));
    await expect(p).resolves.toBe('x');
  });

  it('отклоняется по Error(create-failed) с сообщением агента', async () => {
    const { transport, ws, agentEnc } = driveToStreaming();
    const p = transport.create({ name: 'x', root: '/r', dir: 'd', preset: 'zsh' });
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.Error, 0, { code: 'create-failed', message: 'boom' })));
    await expect(p).rejects.toThrow('boom');
  });

  it('обрыв соединения отклоняет ожидающий create()', async () => {
    const { transport, ws } = driveToStreaming();
    const p = transport.create({ name: 'x', root: '/r', dir: 'd', preset: 'zsh' });
    ws.close();
    await expect(p).rejects.toThrow(/disconnected/);
  });
});

describe('RelayTransport — объявление возможностей', () => {
  it('шлёт свои имена кадром Capabilities и резолвится списком агента', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.capabilities(['feed']);

    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.Capabilities);
    expect(frameJson<{ caps: string[] }>(sent).caps).toEqual(['feed']);

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: ['feed', 'teleport'] })));
    await expect(p).resolves.toEqual(['feed', 'teleport']);
  });

  it('агент молчит 2 с → пустой список, а не ошибка и не вечное ожидание', async () => {
    vi.useFakeTimers();
    const { transport } = streaming();
    const p = transport.capabilities(['feed']);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toEqual([]);
  });

  it('обмен один на подключение: второй вызов не шлёт кадра и ждёт того же ответа', async () => {
    const { transport, ws, agentEnc } = streaming();
    const before = ws.sent.length;
    const p1 = transport.capabilities(['feed']);
    const p2 = transport.capabilities(['feed']);
    expect(ws.sent.length).toBe(before + 1);

    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: ['feed'] })));
    await expect(p1).resolves.toEqual(['feed']);
    await expect(p2).resolves.toEqual(['feed']);
  });

  it('опоздавший после таймаута ответ не достаётся следующему обмену', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentEnc } = streaming();
    const p = transport.capabilities(['feed']);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(p).resolves.toEqual([]);

    // Обмен этого подключения уже состоялся молчанием: второго кадра нет...
    const sentAfter = ws.sent.length;
    const second = transport.capabilities(['feed']);
    expect(ws.sent.length).toBe(sentAfter);
    // ...и опоздавший ответ прежнего обмена не превращается в чужой результат.
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: ['feed'] })));
    await expect(second).resolves.toEqual([]);
  });

  it('после реконнекта объявляемся заново: обмен один на ПОДКЛЮЧЕНИЕ', async () => {
    vi.useFakeTimers();
    const { transport, ws, agentIdentity, agentEnc } = streaming();
    const p = transport.capabilities(['feed']);
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: ['feed'] })));
    await expect(p).resolves.toEqual(['feed']);

    ws.close();
    vi.advanceTimersByTime(1000); // backoff реконнекта
    const ws2 = sockets[1]!;
    const again = restream(ws2, agentIdentity);
    const before = ws2.sent.length;
    const p2 = transport.capabilities(['feed']);

    expect(ws2.sent.length).toBe(before + 1);
    expect(decodeFrame(again.agentDec.pull(ws2.sent[before] as Uint8Array)).type).toBe(FrameType.Capabilities);
    ws2.deliverBinary(again.agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: [] })));
    await expect(p2).resolves.toEqual([]);
  });

  it('незнакомый кадр агента не трогает ожидающий обмен: ответ доходит следом', async () => {
    const { transport, ws, agentEnc } = streaming();
    const p = transport.capabilities(['feed']);
    // Кадр из будущего агента, которого этот клиент не знает: молча игнорируем.
    ws.deliverBinary(agentEnc.push(jsonFrame(200 as FrameType, 0, { hello: 'from the future' })));
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { caps: ['feed'] })));
    await expect(p).resolves.toEqual(['feed']);
  });

  it('ответ без списка (битый payload) → пустой список', async () => {
    const { transport, ws, agentEnc } = streaming();
    const p = transport.capabilities(['feed']);
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.CapabilitiesResult, 0, { oops: 1 })));
    await expect(p).resolves.toEqual([]);
  });
});
