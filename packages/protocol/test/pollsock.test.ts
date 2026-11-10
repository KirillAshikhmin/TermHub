import { describe, it, expect } from 'vitest';
import {
  PollDecoder,
  POLL_BINARY,
  POLL_TEXT,
  decodePollClose,
  encodePollClose,
  encodePollMessage,
  pollBase,
} from '../src/pollsock.js';

describe('poll stream framing', () => {
  it('сообщения собираются из произвольно нарезанных кусков', () => {
    const a = encodePollMessage(POLL_TEXT, new TextEncoder().encode('привет'));
    const b = encodePollMessage(POLL_BINARY, Uint8Array.from({ length: 5000 }, (_, i) => i & 255));
    const c = encodePollMessage(POLL_BINARY, new Uint8Array(0));
    const stream = new Uint8Array(a.length + b.length + c.length);
    stream.set(a);
    stream.set(b, a.length);
    stream.set(c, a.length + b.length);
    for (const step of [1, 3, 7, 1000, stream.length]) {
      const decoder = new PollDecoder(1 << 20);
      const out: Array<{ kind: number; body: Uint8Array }> = [];
      for (let at = 0; at < stream.length; at += step) out.push(...decoder.push(stream.slice(at, at + step)));
      expect(out.map((m) => m.kind)).toEqual([POLL_TEXT, POLL_BINARY, POLL_BINARY]);
      expect(new TextDecoder().decode(out[0].body)).toBe('привет');
      expect(out[1].body).toHaveLength(5000);
      expect(out[1].body[4999]).toBe(4999 & 255);
      expect(out[2].body).toHaveLength(0);
    }
  });

  it('сообщение больше предела бракует поток', () => {
    const decoder = new PollDecoder(10);
    expect(() => decoder.push(encodePollMessage(POLL_BINARY, new Uint8Array(11)))).toThrow();
  });

  it('закрытие несёт код и причину', () => {
    const frame = encodePollClose(4004, 'agent offline');
    const [m] = new PollDecoder(1024).push(frame);
    expect(decodePollClose(m.body)).toEqual({ code: 4004, reason: 'agent offline' });
  });

  it('адрес запросов берётся из адреса WebSocket', () => {
    expect(pollBase('wss://relay.example.com:9443/relay')).toBe('https://relay.example.com:9443/relay');
    expect(pollBase('ws://127.0.0.1:9720/relay/')).toBe('http://127.0.0.1:9720/relay');
  });
});
