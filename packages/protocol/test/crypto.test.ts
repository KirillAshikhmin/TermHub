import { beforeAll, describe, expect, it } from 'vitest';

import {
  fingerprint,
  generateIdentity,
  generatePairingCode,
  initCrypto,
  makeDecryptor,
  makeEncryptor,
  openPair,
  pairKey,
  parsePairingCode,
  sealPair,
  sessionKeys,
  sign,
  verify,
} from '../src/index.js';

const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

beforeAll(async () => {
  await initCrypto();
});

describe('sessionKeys + Encryptor/Decryptor', () => {
  it('две Identity → согласованные kx-ключи → 3 сообщения в обе стороны', () => {
    const client = generateIdentity();
    const server = generateIdentity();

    const ck = sessionKeys('client', client, server.edPub);
    const sk = sessionKeys('server', server, client.edPub);

    // client.tx == server.rx, client.rx == server.tx
    expect(ck.tx).toEqual(sk.rx);
    expect(ck.rx).toEqual(sk.tx);

    const clientEnc = makeEncryptor(ck.tx);
    const serverDec = makeDecryptor(sk.rx, clientEnc.header);
    const serverEnc = makeEncryptor(sk.tx);
    const clientDec = makeDecryptor(ck.rx, serverEnc.header);

    for (const text of ['первое', 'второе-сообщение', 'третье!!!']) {
      const msg = enc(text);
      expect(serverDec.pull(clientEnc.push(msg))).toEqual(msg);
    }
    for (const text of ['ответ-1', 'ответ-2', 'ответ-3']) {
      const msg = enc(text);
      expect(clientDec.pull(serverEnc.push(msg))).toEqual(msg);
    }
  });

  it('подделка байта в chunk → pull бросает', () => {
    const client = generateIdentity();
    const server = generateIdentity();
    const ck = sessionKeys('client', client, server.edPub);
    const sk = sessionKeys('server', server, client.edPub);

    const clientEnc = makeEncryptor(ck.tx);
    const serverDec = makeDecryptor(sk.rx, clientEnc.header);

    const chunk = clientEnc.push(enc('секрет'));
    const tampered = Uint8Array.from(chunk);
    tampered[tampered.length - 1] ^= 0xff;

    expect(() => serverDec.pull(tampered)).toThrow();
  });
});

describe('sealPair/openPair', () => {
  it('roundtrip произвольного объекта', () => {
    const key = pairKey('ABCDWXYZ2345');
    const obj = { t: 'hello', edPub: 'b64==', name: 'ноутбук', n: 42, flag: true };
    expect(openPair(key, sealPair(key, obj))).toEqual(obj);
  });

  it('неверный ключ → openPair бросает', () => {
    const key = pairKey('ABCDWXYZ2345');
    const box = sealPair(key, { secret: true });
    const wrong = pairKey('ZZZZ99998888');
    expect(() => openPair(wrong, box)).toThrow();
  });
});

describe('generatePairingCode', () => {
  it('формат XXXX-YYYY-YYYY-YYYY и алфавит', () => {
    const { code, roomId, secret } = generatePairingCode();
    expect(roomId).toHaveLength(4);
    expect(secret).toHaveLength(12);
    expect(code).toBe(`${roomId}-${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8, 12)}`);
    for (const ch of roomId + secret) expect(PAIR_ALPHABET).toContain(ch);
  });

  it('уникальность 1000 генераций', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 1000; i++) codes.add(generatePairingCode().code);
    expect(codes.size).toBe(1000);
  });
});

describe('parsePairingCode', () => {
  it('переваривает нижний регистр и лишние пробелы', () => {
    const { code, roomId, secret } = generatePairingCode();
    const messy = `   ${code.toLowerCase().replace(/-/g, '  -  ')}   `;
    const parsed = parsePairingCode(messy);
    expect(parsed.roomId).toBe(roomId);
    expect(parsed.secret).toBe(secret);
  });

  it('roundtrip generate → parse', () => {
    const g = generatePairingCode();
    const p = parsePairingCode(g.code);
    expect(p.roomId).toBe(g.roomId);
    expect(p.secret).toBe(g.secret);
  });
});

describe('sign/verify', () => {
  it('валидная подпись проходит, изменённое сообщение — нет', () => {
    const id = generateIdentity();
    const msg = enc('challenge-nonce');
    const sig = sign(id.edSec, msg);
    expect(verify(id.edPub, msg, sig)).toBe(true);
    expect(verify(id.edPub, enc('challenge-nonc3'), sig)).toBe(false);
  });
});

describe('fingerprint', () => {
  it('детерминирован и использует алфавит спеки', () => {
    const id = generateIdentity();
    const fp = fingerprint(id.edPub);
    expect(fingerprint(id.edPub)).toBe(fp);
    expect(fp.length).toBeGreaterThan(0);
    for (const ch of fp) expect(PAIR_ALPHABET).toContain(ch);
  });

  it('разные ключи → разные fingerprint', () => {
    expect(fingerprint(generateIdentity().edPub)).not.toBe(fingerprint(generateIdentity().edPub));
  });
});
