import { describe, it, expect } from 'vitest';
import { DISGUISES, disguisePreface, isDisguise, prefaceLength } from '../src/disguise.js';

describe('disguise preface', () => {
  it.each(DISGUISES)('%s: длина преамбулы находится, хвост остаётся потоку', (kind) => {
    const preface = disguisePreface(kind);
    const tail = Uint8Array.of(0x16, 3, 1, 0, 5);
    const buf = new Uint8Array(preface.length + tail.length);
    buf.set(preface);
    buf.set(tail, preface.length);
    expect(prefaceLength(buf)).toBe(preface.length);
  });

  it.each(DISGUISES)('%s: неполная преамбула просит ещё данных на любом срезе', (kind) => {
    const preface = disguisePreface(kind);
    for (let n = 0; n < preface.length; n++) expect(prefaceLength(preface.subarray(0, n))).toBeNull();
  });

  it('rdp — ровно 19 байт запроса X.224, ssh начинается с баннера', () => {
    expect(disguisePreface('rdp')).toHaveLength(19);
    expect(Buffer.from(disguisePreface('ssh')).toString('latin1').startsWith('SSH-2.0-')).toBe(true);
  });

  it('чужое начало потока бракуется, а не ждётся вечно', () => {
    expect(() => prefaceLength(Buffer.from('SSH-1.5-old\r\n'))).toThrow();
    expect(() => prefaceLength(Buffer.from('GET / HTTP/1.1\r\n\r\n'))).toThrow();
    expect(() => prefaceLength(Uint8Array.of(3, 0, 0xff, 0xff))).toThrow();
    expect(() => prefaceLength(Uint8Array.of(0x16, 3, 1, 2, 0))).toThrow();
  });

  it('isDisguise знает только три имени', () => {
    expect(isDisguise('ssh')).toBe(true);
    expect(isDisguise('none')).toBe(false);
    expect(isDisguise(undefined)).toBe(false);
  });
});
