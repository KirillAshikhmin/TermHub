import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import webpush from 'web-push';
import { PushService } from '../src/push.js';
import { pushPath } from '../src/paths.js';
import type { TermhubConfig } from '../src/config.js';

// web-push мокаем целиком: setVapidDetails — no-op (иначе валидировал бы ключи),
// sendNotification — управляемый мок (успех/ошибка со statusCode).
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

const send = vi.mocked(webpush.sendNotification);
const setVapid = vi.mocked(webpush.setVapidDetails);

interface PushEntry {
  subscription: { endpoint: string };
  addedAt: number;
}

let tmp: string;

function cfg(): TermhubConfig {
  return {
    port: 7710,
    host: '0.0.0.0',
    passwordHash: 'x',
    cookieSecret: 'x',
    sessionRoots: [],
    tls: null,
    relayUrl: null,
    vapid: { publicKey: 'PUBKEY', privateKey: 'PRIVKEY', subject: 'mailto:t@localhost' },
    locale: null,
  };
}

function sub(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  return { endpoint, keys: { p256dh: 'p256dh', auth: 'auth' } };
}

function readPush(): PushEntry[] {
  return JSON.parse(fs.readFileSync(pushPath(), 'utf8')) as PushEntry[];
}

function webPushError(statusCode: number): Error {
  return Object.assign(new Error(`push endpoint returned ${statusCode}`), { statusCode });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-push-'));
  process.env.TERMHUB_DIR = tmp;
  send.mockReset();
  setVapid.mockReset();
  send.mockResolvedValue({ statusCode: 201, body: '', headers: {} });
});

afterEach(() => {
  delete process.env.TERMHUB_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PushService', () => {
  it('конструктор один раз передаёт vapid в web-push', () => {
    new PushService(cfg());
    expect(setVapid).toHaveBeenCalledTimes(1);
    expect(setVapid).toHaveBeenCalledWith('mailto:t@localhost', 'PUBKEY', 'PRIVKEY');
  });

  it('vapidPublicKey возвращает публичный ключ из конфига', () => {
    expect(new PushService(cfg()).vapidPublicKey()).toBe('PUBKEY');
  });

  it('subscribe дедуплицирует по endpoint и пишет push.json с правами 0600', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/a'));
    await p.subscribe(sub('https://push/a'));
    await p.subscribe(sub('https://push/b'));
    expect(readPush().map((e) => e.subscription.endpoint)).toEqual(['https://push/a', 'https://push/b']);
    expect(fs.statSync(pushPath()).mode & 0o777).toBe(0o600);
  });

  it('subscribe отвергает подписку без endpoint/keys', async () => {
    const p = new PushService(cfg());
    await expect(p.subscribe({ keys: {} })).rejects.toThrow();
    await expect(p.subscribe({ endpoint: 'https://push/x' })).rejects.toThrow();
    expect(fs.existsSync(pushPath())).toBe(false);
  });

  it('notifyBell шлёт один раз при двух вызовах подряд (троттлинг 30с/сессию)', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/a'));
    await p.notifyBell('work');
    await p.notifyBell('work');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toBe(JSON.stringify({ session: 'work', task: '' }));
  });

  it('троттлинг раздельный по сессиям', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/a'));
    await p.notifyBell('work');
    await p.notifyBell('play');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('шлёт всем подпискам', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/a'));
    await p.subscribe(sub('https://push/b'));
    await p.notifyBell('work');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('удаляет мёртвую подписку при 410 от push-сервиса', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/dead'));
    await p.subscribe(sub('https://push/live'));
    send.mockImplementation(async (s) => {
      if (s.endpoint === 'https://push/dead') throw webPushError(410);
      return { statusCode: 201, body: '', headers: {} };
    });
    await p.notifyBell('work');
    expect(readPush().map((e) => e.subscription.endpoint)).toEqual(['https://push/live']);
  });

  it('удаляет мёртвую подписку при 404', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/gone'));
    send.mockRejectedValue(webPushError(404));
    await p.notifyBell('work');
    expect(readPush()).toEqual([]);
  });

  it('не удаляет подписку при обычной ошибке (например 500)', async () => {
    const p = new PushService(cfg());
    await p.subscribe(sub('https://push/a'));
    send.mockRejectedValue(webPushError(500));
    await p.notifyBell('work');
    expect(readPush()).toHaveLength(1);
  });

  it('notifyBell без подписок ничего не шлёт', async () => {
    const p = new PushService(cfg());
    await p.notifyBell('work');
    expect(send).not.toHaveBeenCalled();
  });
});
