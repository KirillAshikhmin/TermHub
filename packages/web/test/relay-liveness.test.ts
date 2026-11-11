// @vitest-environment happy-dom
// Живость связи через relay: мёртвое соединение не рвётся, а молчит (сон вкладки на
// телефоне, смена сети), и сокет числится открытым. Транспорт обязан заметить это сам.
import { decodeFrame, encodeFrame, FrameType } from '@termhub/protocol';
import { describe, expect, it, vi } from 'vitest';

import { installRelayHarness, makeTransport, sockets, streaming } from './relay-harness';
import { generateIdentity } from '@termhub/protocol';

installRelayHarness();

/** Сокет, который «умер молча»: close() ничего не сообщает, как у настоящего мёртвого соединения. */
function silence(ws: { close: () => void }): void {
  ws.close = () => undefined;
}

function wake(): void {
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('проверка связи', () => {
  it('возврат на страницу: Ping уходит агенту, молчание 3 с — сокет брошен, идёт новое подключение', () => {
    vi.useFakeTimers();
    const { ws, agentDec, firstEncrypted } = streaming();
    silence(ws);

    wake();
    const ping = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(ping.type).toBe(FrameType.Ping);

    vi.advanceTimersByTime(2999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1); // срок проверки вышел: события закрытия не ждём
    vi.advanceTimersByTime(1000); // backoff реконнекта
    expect(sockets).toHaveLength(2);
  });

  it('любой кадр от агента — ответ на проверку: соединение остаётся', () => {
    vi.useFakeTimers();
    const { ws, agentEnc } = streaming();
    silence(ws);

    wake();
    vi.advanceTimersByTime(1000);
    ws.deliverBinary(agentEnc.push(encodeFrame({ type: FrameType.Pong, channel: 0, payload: new Uint8Array(0) })));
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });

  it('повторный возврат, пока проверка идёт, второго Ping не шлёт', () => {
    vi.useFakeTimers();
    const { ws, firstEncrypted } = streaming();
    wake();
    wake();
    expect(ws.sent).toHaveLength(firstEncrypted + 1);
  });

  it('тишина на видимой странице: проверка сама, без события возврата', () => {
    vi.useFakeTimers();
    const { ws, agentDec, firstEncrypted } = streaming();
    silence(ws);

    vi.advanceTimersByTime(15_000);
    expect(decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array)).type).toBe(FrameType.Ping);
    vi.advanceTimersByTime(3000 + 1000);
    expect(sockets).toHaveLength(2);
  });

  it('пока по потоку идут кадры, проверок нет', () => {
    vi.useFakeTimers();
    const { ws, agentEnc, firstEncrypted } = streaming();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      ws.deliverBinary(agentEnc.push(encodeFrame({ type: FrameType.Pong, channel: 0, payload: new Uint8Array(0) })));
    }
    expect(ws.sent).toHaveLength(firstEncrypted);
    expect(sockets).toHaveLength(1);
  });

  it('соединение, не дошедшее до потока за 12 с, бросается и пробуется заново', () => {
    vi.useFakeTimers();
    makeTransport(generateIdentity(), generateIdentity());
    silence(sockets[0]!); // так и висит в CONNECTING
    vi.advanceTimersByTime(12_000);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('закрытый транспорт проверок не ведёт и не переподключается', () => {
    vi.useFakeTimers();
    const { transport, ws, firstEncrypted } = streaming();
    transport.close();
    wake();
    vi.advanceTimersByTime(60_000);
    expect(ws.sent).toHaveLength(firstEncrypted);
    expect(sockets).toHaveLength(1);
  });
});
