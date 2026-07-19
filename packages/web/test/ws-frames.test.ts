// @vitest-environment happy-dom
import { jsonFrame } from '@termhub/protocol/frames';
import { describe, expect, it } from 'vitest';

import { dataFrame, decodeFrame, frameJson, FrameType, LAN_CHANNEL, parseError, resizeFrame } from '../src/ws-frames';
import type { Frame } from '../src/ws-frames';

describe('ws-frames', () => {
  it('dataFrame → decodeFrame — тип DATA, канал 0, те же байты', () => {
    const payload = new Uint8Array([0x68, 0x69, 0x00, 0xff, 0x1b]);
    const frame = decodeFrame(dataFrame(payload));
    expect(frame.type).toBe(FrameType.Data);
    expect(frame.channel).toBe(LAN_CHANNEL);
    expect([...frame.payload]).toEqual([...payload]);
  });

  it('resizeFrame → decodeFrame — тип RESIZE, JSON {cols,rows}', () => {
    const frame = decodeFrame(resizeFrame(120, 40));
    expect(frame.type).toBe(FrameType.Resize);
    expect(frame.channel).toBe(LAN_CHANNEL);
    expect(frameJson<{ cols: number; rows: number }>(frame)).toEqual({ cols: 120, rows: 40 });
  });

  it('пустой DATA-фрейм роундтрипится (только заголовок)', () => {
    const frame = decodeFrame(dataFrame(new Uint8Array(0)));
    expect(frame.type).toBe(FrameType.Data);
    expect(frame.payload.length).toBe(0);
  });

  it('серверный BELL-фрейм (jsonFrame из protocol) читается клиентским кодеком', () => {
    // Мост шлёт jsonFrame(Bell, 0, {session}); клиент декодирует тем же форматом.
    const frame = decodeFrame(jsonFrame(FrameType.Bell, LAN_CHANNEL, { session: 'work' }));
    expect(frame.type).toBe(FrameType.Bell);
    expect(frameJson<{ session: string }>(frame)).toEqual({ session: 'work' });
  });

  it('ERROR-фрейм → parseError — {code, message}', () => {
    const frame = decodeFrame(jsonFrame(FrameType.Error, LAN_CHANNEL, { code: 'AUTH_FAILED', message: 'сессия истекла' }));
    expect(parseError(frame)).toEqual({ code: 'AUTH_FAILED', message: 'сессия истекла' });
  });

  it('parseError — битый JSON payload не роняет клиента, возвращает {}', () => {
    const frame: Frame = { type: FrameType.Error, channel: LAN_CHANNEL, payload: new TextEncoder().encode('{oops') };
    expect(parseError(frame)).toEqual({});
  });
});
