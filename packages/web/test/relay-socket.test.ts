// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  effectiveRelayTransport,
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
