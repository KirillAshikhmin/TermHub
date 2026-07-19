import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initCrypto } from '@termhub/protocol';
import {
  configDir,
  loadConfig,
  saveConfig,
  hashPassword,
  verifyPassword,
  loadIdentity,
  loadAuthorized,
  saveAuthorized,
} from '../src/config.js';
import type { TermhubConfig, AuthorizedDevice } from '../src/config.js';

let tmp: string;

beforeAll(async () => {
  await initCrypto();
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-cfg-'));
  process.env.TERMHUB_DIR = tmp;
});

afterEach(() => {
  delete process.env.TERMHUB_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleConfig(): TermhubConfig {
  return {
    port: 7710,
    host: '0.0.0.0',
    passwordHash: hashPassword('correct horse'),
    cookieSecret: 'deadbeef',
    sessionRoots: [path.join(os.homedir(), 'projects')],
    tls: null,
    relayUrl: null,
    vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:termhub@localhost' },
    locale: null,
  };
}

describe('config', () => {
  it('configDir honours TERMHUB_DIR', () => {
    expect(configDir()).toBe(tmp);
  });

  it('save/load roundtrip', () => {
    const c = sampleConfig();
    saveConfig(c);
    expect(loadConfig()).toEqual(c);
  });

  it('loadConfig throws a helpful error when missing', () => {
    expect(() => loadConfig()).toThrow(/setup/);
  });

  it('hashPassword/verifyPassword accepts the right password and rejects a wrong one', () => {
    const hash = hashPassword('s3cret');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('s3cret', hash)).toBe(true);
    expect(verifyPassword('nope', hash)).toBe(false);
  });

  it('loadIdentity creates on first call and reuses afterwards', () => {
    const identityFile = path.join(tmp, 'identity.json');
    expect(fs.existsSync(identityFile)).toBe(false);
    const first = loadIdentity();
    expect(fs.existsSync(identityFile)).toBe(true);
    const second = loadIdentity();
    expect(Buffer.from(first.edPub)).toEqual(Buffer.from(second.edPub));
    expect(Buffer.from(first.edSec)).toEqual(Buffer.from(second.edSec));
  });

  it('writes config with 0600 permissions', () => {
    saveConfig(sampleConfig());
    const mode = fs.statSync(path.join(tmp, 'config.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writes identity.json with 0600 permissions', () => {
    loadIdentity();
    const mode = fs.statSync(path.join(tmp, 'identity.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the config directory with 0700 permissions', () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    saveConfig(sampleConfig());
    const mode = fs.statSync(tmp).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('authorized devices roundtrip (empty by default)', () => {
    expect(loadAuthorized()).toEqual([]);
    const list: AuthorizedDevice[] = [
      { name: 'phone', edPub: 'AAAA', fingerprint: 'ABCD-EFGH', addedAt: 123 },
    ];
    saveAuthorized(list);
    expect(loadAuthorized()).toEqual(list);
    const mode = fs.statSync(path.join(tmp, 'authorized.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
