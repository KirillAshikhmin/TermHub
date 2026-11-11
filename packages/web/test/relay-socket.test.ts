// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectiveRelayTransport,
  noteRtcOutcome,
  relayTransportMode,
  resetRelayTransportState,
  setRelayTransportHint,
} from '../src/relay-socket';

describe('выбор транспорта relay в браузере', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRelayTransportState();
    setRelayTransportHint(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('по умолчанию WebSocket; подсказка relay принимается, чужое слово — нет', () => {
    expect(relayTransportMode()).toBe('ws');
    setRelayTransportHint('poll');
    expect(relayTransportMode()).toBe('poll');
    setRelayTransportHint('carrier-pigeon');
    expect(relayTransportMode()).toBe('ws');
  });

  it('выбор устройства старше подсказки relay', () => {
    setRelayTransportHint('poll');
    localStorage.setItem('termhub.relayTransport', 'ws');
    expect(relayTransportMode()).toBe('ws');
    localStorage.setItem('termhub.relayTransport', 'nonsense');
    expect(relayTransportMode()).toBe('poll');
  });

  it('rtc без WebRTC в браузере сразу идёт короткими запросами', () => {
    setRelayTransportHint('rtc');
    vi.stubGlobal('RTCPeerConnection', undefined);
    expect(relayTransportMode()).toBe('rtc');
    expect(effectiveRelayTransport()).toBe('poll');
    vi.stubGlobal('RTCPeerConnection', class {});
    expect(effectiveRelayTransport()).toBe('rtc');
  });
});

describe('откат WebRTC после неудачи', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRelayTransportState();
    setRelayTransportHint('rtc');
    vi.stubGlobal('RTCPeerConnection', class {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('ни разу не открывался — уступает коротким запросам на 10 минут', () => {
    noteRtcOutcome(false, 1_000_000);
    expect(effectiveRelayTransport(1_000_000 + 9 * 60_000)).toBe('poll');
    expect(effectiveRelayTransport(1_000_000 + 10 * 60_000)).toBe('rtc');
  });

  it('уже работал в этой сети — неудача после сна стоит 20 секунд, а не 10 минут', () => {
    noteRtcOutcome(true, 1_000_000);
    noteRtcOutcome(false, 2_000_000);
    expect(effectiveRelayTransport(2_000_000 + 19_000)).toBe('poll');
    expect(effectiveRelayTransport(2_000_000 + 20_000)).toBe('rtc');
  });

  it('успех снимает откат сразу', () => {
    noteRtcOutcome(false, 1_000_000);
    noteRtcOutcome(true, 1_000_500);
    expect(effectiveRelayTransport(1_001_000)).toBe('rtc');
  });
});
