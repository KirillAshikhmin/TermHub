import { describe, expect, it } from 'vitest';

import { FrameType, decodeFrame, encodeFrame, frameJson, jsonFrame } from '../src/index.js';
import type { Frame, SessionInfo } from '../src/index.js';

describe('encodeFrame/decodeFrame', () => {
  it('roundtrip с пустым payload', () => {
    const frame: Frame = { type: FrameType.Ping, channel: 0, payload: new Uint8Array(0) };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.type).toBe(FrameType.Ping);
    expect(decoded.channel).toBe(0);
    expect(decoded.payload.length).toBe(0);
  });

  it('roundtrip с channel 65535', () => {
    const frame: Frame = { type: FrameType.Data, channel: 65535, payload: new Uint8Array([1, 2, 3]) };
    const decoded = decodeFrame(encodeFrame(frame));
    expect(decoded.type).toBe(FrameType.Data);
    expect(decoded.channel).toBe(65535);
    expect(decoded.payload).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('roundtrip с бинарным payload 100KiB', () => {
    const payload = new Uint8Array(100 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff;
    const encoded = encodeFrame({ type: FrameType.Data, channel: 42, payload });
    expect(encoded.length).toBe(3 + payload.length);
    const decoded = decodeFrame(encoded);
    expect(decoded.type).toBe(FrameType.Data);
    expect(decoded.channel).toBe(42);
    expect(decoded.payload).toEqual(payload);
  });

  it('заголовок кодируется как [type:u8][channel:u16 BE]', () => {
    const encoded = encodeFrame({ type: FrameType.Error, channel: 0x1234, payload: new Uint8Array(0) });
    expect(Array.from(encoded)).toEqual([10, 0x12, 0x34]);
  });

  it('decode буфера короче 3 байт бросает', () => {
    expect(() => decodeFrame(new Uint8Array([1, 2]))).toThrow();
  });

  it('encode с channel вне 0..65535 бросает RangeError', () => {
    expect(() => encodeFrame({ type: FrameType.Data, channel: -1, payload: new Uint8Array(0) })).toThrow(RangeError);
    expect(() => encodeFrame({ type: FrameType.Data, channel: 65536, payload: new Uint8Array(0) })).toThrow(
      RangeError,
    );
  });

  it('decode с type вне enum (200) не бросает и форвардит как есть', () => {
    const encoded = encodeFrame({ type: 200 as FrameType, channel: 5, payload: new Uint8Array([9]) });
    const decoded = decodeFrame(encoded);
    expect(decoded.type).toBe(200);
    expect(decoded.channel).toBe(5);
    expect(decoded.payload).toEqual(new Uint8Array([9]));
  });
});

describe('jsonFrame/frameJson', () => {
  it('roundtrip JSON-объекта', () => {
    const sessions: SessionInfo[] = [
      { name: 'main', path: '/Users/dev', command: 'zsh', activityTs: 1760000000, attached: 1, bell: false },
    ];
    const decoded = decodeFrame(jsonFrame(FrameType.ListResult, 7, sessions));
    expect(decoded.type).toBe(FrameType.ListResult);
    expect(decoded.channel).toBe(7);
    expect(frameJson<SessionInfo[]>(decoded)).toEqual(sessions);
  });

  it('frameJson на битом JSON бросает внятную ошибку', () => {
    const broken: Frame = {
      type: FrameType.Data,
      channel: 0,
      payload: new TextEncoder().encode('{ не json'),
    };
    expect(() => frameJson(broken)).toThrow('невалидный JSON во фрейме');
  });
});
