import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { issueCookie, checkCookie, LoginRateLimit } from '../src/auth.js';
import { AgentServer } from '../src/server.js';
import { hashPassword } from '../src/config.js';
import type { TermhubConfig } from '../src/config.js';
import type { SessionService } from '../src/sessions.js';
import type { SessionInfo } from '@termhub/protocol';

const SECRET = 'test-cookie-secret';
const DAY_MS = 24 * 60 * 60 * 1000;

function fixtureConfig(over: Partial<TermhubConfig> = {}): TermhubConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    passwordHash: hashPassword('secret'),
    cookieSecret: SECRET,
    sessionRoots: [],
    tls: null,
    relayUrl: null,
    vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:termhub@localhost' },
    locale: null,
    ...over,
  };
}

/** Лёгкий стаб SessionService с той же сигнатурой (без tmux). */
function stubSessions(over: Partial<SessionService> = {}): SessionService {
  return {
    list: async () => [] as SessionInfo[],
    create: async () => {},
    kill: async () => {},
    rename: async () => {},
    dirs: async () => [],
    ...over,
  } as unknown as SessionService;
}

interface Started {
  server: AgentServer;
  base: string;
}

async function start(opts: {
  config?: TermhubConfig;
  sessions?: SessionService;
  onShare?: () => Promise<{ code: string; expiresAt: number }>;
  push?: { subscribe(sub: unknown): Promise<void>; vapidPublicKey(): string };
  caffeinate?: { readonly supported: boolean; isActive(): boolean; set(on: boolean): void };
  staticDir?: string;
}): Promise<Started> {
  const server = new AgentServer({
    config: opts.config ?? fixtureConfig(),
    sessions: opts.sessions ?? stubSessions(),
    onShare: opts.onShare,
    push: opts.push,
    caffeinate: opts.caffeinate,
    staticDir: opts.staticDir,
  });
  const port = await server.listen();
  return { server, base: `http://127.0.0.1:${port}` };
}

function authCookie(secret = SECRET): string {
  return `termhub=${issueCookie(secret)}`;
}

describe('auth — issueCookie/checkCookie', () => {
  it('issueCookie возвращает формат <ts>.<hmacHex> и проходит checkCookie', () => {
    const c = issueCookie(SECRET);
    expect(c).toMatch(/^\d+\.[0-9a-f]{64}$/);
    expect(checkCookie(c, SECRET)).toBe(true);
  });

  it('отклоняет undefined, чужой секрет и подделанный hmac', () => {
    const c = issueCookie(SECRET);
    expect(checkCookie(undefined, SECRET)).toBe(false);
    expect(checkCookie(c, 'other-secret')).toBe(false);
    const [ts] = c.split('.');
    expect(checkCookie(`${ts}.${'0'.repeat(64)}`, SECRET)).toBe(false);
  });

  it('отклоняет просроченный ts (старше 30 суток), даже с валидным hmac', () => {
    const oldTs = String(Date.now() - 31 * DAY_MS);
    const mac = crypto.createHmac('sha256', SECRET).update(oldTs).digest('hex');
    expect(checkCookie(`${oldTs}.${mac}`, SECRET)).toBe(false);
    const freshTs = String(Date.now() - 1 * DAY_MS);
    const freshMac = crypto.createHmac('sha256', SECRET).update(freshTs).digest('hex');
    expect(checkCookie(`${freshTs}.${freshMac}`, SECRET)).toBe(true);
  });
});

describe('auth — LoginRateLimit', () => {
  it('пропускает первые 5 неудач, блокирует 6-ю; учитывает только зафиксированные неудачи', () => {
    const rl = new LoginRateLimit();
    for (let i = 0; i < 5; i += 1) {
      expect(rl.allow('1.2.3.4')).toBe(true);
      rl.fail('1.2.3.4');
    }
    expect(rl.allow('1.2.3.4')).toBe(false);
    // другой IP — независимо
    expect(rl.allow('9.9.9.9')).toBe(true);
  });

  it('подметает запись IP из Map, когда её окно неудач опустело (Map не растёт вечно)', () => {
    vi.useFakeTimers();
    try {
      const rl = new LoginRateLimit();
      const failures = (rl as unknown as { failures: Map<string, number[]> }).failures;
      expect(failures.size).toBe(0);
      // Простой allow() без неудач вообще не создаёт запись.
      expect(rl.allow('5.5.5.5')).toBe(true);
      expect(failures.size).toBe(0);
      rl.fail('5.5.5.5');
      expect(failures.size).toBe(1);
      vi.advanceTimersByTime(61 * 1000); // окно неудач — 60 с
      expect(rl.allow('5.5.5.5')).toBe(true);
      expect(failures.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AgentServer — auth/mode/login (стаб SessionService)', () => {
  let s: Started;

  afterEach(async () => {
    await s.server.close();
  });

  it('POST /api/login верный пароль → 200 + cookie termhub HttpOnly/SameSite=Lax', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('termhub=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure');
  });

  it('POST /api/login неверный пароль → 401', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toHaveProperty('error');
  });

  it('POST /api/login → 429 после 5 неудач с одного IP', async () => {
    s = await start({});
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${s.base}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong' }),
      });
      expect(r.status).toBe(401);
    }
    const blocked = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(blocked.status).toBe(429);
  });

  it('POST /api/login с невалидным JSON → 400', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json',
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/login с телом >64KiB → 413 (честный ответ, не сетевой обрыв)', async () => {
    s = await start({});
    const oversized = JSON.stringify({ password: 'x'.repeat(70 * 1024) });
    const res = await fetch(`${s.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);
    expect((await res.json()) as { error: string }).toHaveProperty('error');
  });

  it('GET /api/mode без auth → {mode:"lan", host}', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/mode`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; host: string };
    expect(body.mode).toBe('lan');
    expect(body.host).toBe(os.hostname());
  });

  it('GET /api/sessions без cookie → 401', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('GET /api/sessions с cookie → JSON SessionInfo[]', async () => {
    const sample: SessionInfo[] = [
      { name: 'main', path: '/p', command: 'zsh', activityTs: 1, attached: 0, bell: false },
    ];
    s = await start({ sessions: stubSessions({ list: async () => sample }) });
    const res = await fetch(`${s.base}/api/sessions`, { headers: { cookie: authCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(sample);
  });

  it('POST /api/sessions с ошибкой валидации → 422 {error}', async () => {
    s = await start({
      sessions: stubSessions({
        create: async () => {
          throw new Error('Invalid session name');
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ name: '!', root: '/x', dir: 'a', preset: 'zsh' }),
    });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toContain('name');
  });

  it('POST /api/sessions/rename → sessions.rename(from, to), 200', async () => {
    let seen = '';
    s = await start({
      sessions: stubSessions({
        rename: async (from: string, to: string) => {
          seen = `${from}->${to}`;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ from: 'old', to: 'new' }),
    });
    expect(res.status).toBe(200);
    expect(seen).toBe('old->new');
  });

  it('DELETE /api/sessions/:name несуществующей → 404 (tmux exit≠0)', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          const err = new Error("can't find session") as Error & { code: number };
          err.code = 1;
          throw err;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/ghost`, {
      method: 'DELETE',
      headers: { cookie: authCookie() },
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/sessions/:name с невалидным именем → 422', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          throw new Error('Invalid session name');
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/bad`, {
      method: 'DELETE',
      headers: { cookie: authCookie() },
    });
    expect(res.status).toBe(422);
  });

  it('DELETE /api/sessions/:name — «session not found» (альтернативная формулировка) → 404', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          const err = new Error('Session not found') as Error & { code: number };
          err.code = 1;
          throw err;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/ghost`, { method: 'DELETE', headers: { cookie: authCookie() } });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/sessions/:name — сбой tmux не «session not found» (напр. ENOENT) → 500, не 404', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          const err = new Error('spawn tmux ENOENT') as Error & { code: string };
          err.code = 'ENOENT';
          throw err;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/ghost`, { method: 'DELETE', headers: { cookie: authCookie() } });
    expect(res.status).toBe(500);
  });

  it('DELETE /api/sessions/:name — «error connecting … No such file» (сервер убит) → 404', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          const err = new Error('error connecting to /tmp/tmux-501/x (No such file or directory)') as Error & {
            code: number;
          };
          err.code = 1;
          throw err;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/ghost`, { method: 'DELETE', headers: { cookie: authCookie() } });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/sessions/:name — «error connecting … Permission denied» → 500, НЕ 404', async () => {
    s = await start({
      sessions: stubSessions({
        kill: async () => {
          const err = new Error('error connecting to /tmp/tmux-0/default (Permission denied)') as Error & {
            code: number;
          };
          err.code = 1;
          throw err;
        },
      }),
    });
    const res = await fetch(`${s.base}/api/sessions/ghost`, { method: 'DELETE', headers: { cookie: authCookie() } });
    expect(res.status).toBe(500);
  });

  it('DELETE /api/sessions/%ZZ (битый percent-encoding) → 400, не 500', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/sessions/%ZZ`, { method: 'DELETE', headers: { cookie: authCookie() } });
    expect(res.status).toBe(400);
  });

  it('GET /api/dirs с cookie → массив корней', async () => {
    s = await start({ sessions: stubSessions({ dirs: async () => [{ root: '/r', dirs: ['a'] }] }) });
    const res = await fetch(`${s.base}/api/dirs`, { headers: { cookie: authCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ root: '/r', dirs: ['a'] }]);
  });

  it('GET /api/caffeinate без контроллера → {active:false, supported:false}', async () => {
    s = await start({});
    const res = await fetch(`${s.base}/api/caffeinate`, { headers: { cookie: authCookie() } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: false, supported: false });
  });

  it('POST /api/caffeinate переключает контроллер и отражает состояние', async () => {
    let on = false;
    const caffeinate = {
      supported: true,
      isActive: () => on,
      set: (v: boolean) => {
        on = v;
      },
    };
    s = await start({ caffeinate });
    const res = await fetch(`${s.base}/api/caffeinate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ active: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ active: true, supported: true });
    expect(on).toBe(true);
  });

  it('POST /api/caffeinate без boolean active → 422; без auth → 401', async () => {
    const caffeinate = { supported: true, isActive: () => false, set: () => {} };
    s = await start({ caffeinate });
    const bad = await fetch(`${s.base}/api/caffeinate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ active: 'yes' }),
    });
    expect(bad.status).toBe(422);
    const noauth = await fetch(`${s.base}/api/caffeinate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: true }),
    });
    expect(noauth.status).toBe(401);
  });

  it('POST /api/caffeinate когда не поддерживается → 503', async () => {
    const caffeinate = { supported: false, isActive: () => false, set: () => {} };
    s = await start({ caffeinate });
    const res = await fetch(`${s.base}/api/caffeinate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ active: true }),
    });
    expect(res.status).toBe(503);
  });

  it('push-маршруты без PushService → 503', async () => {
    s = await start({});
    const key = await fetch(`${s.base}/api/push/vapid-key`);
    expect(key.status).toBe(503);
    const sub = await fetch(`${s.base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ subscription: {} }),
    });
    expect(sub.status).toBe(503);
  });

  it('push-маршруты с PushService → vapid-key без auth, subscribe под auth', async () => {
    const seen: unknown[] = [];
    s = await start({
      push: {
        vapidPublicKey: () => 'VAPID-PUB',
        subscribe: async (sub) => {
          seen.push(sub);
        },
      },
    });
    const key = await fetch(`${s.base}/api/push/vapid-key`);
    expect(await key.json()).toEqual({ key: 'VAPID-PUB' });
    const sub = await fetch(`${s.base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ subscription: { endpoint: 'x' } }),
    });
    expect(sub.status).toBe(200);
    expect(seen).toEqual([{ endpoint: 'x' }]);
  });

  it('POST /api/push/subscribe с невалидной подпиской → 400 (ошибка валидации, не 500)', async () => {
    s = await start({
      push: {
        vapidPublicKey: () => 'PUB',
        subscribe: async () => {
          throw new Error('Invalid push subscription: no endpoint');
        },
      },
    });
    const res = await fetch(`${s.base}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: authCookie() },
      body: JSON.stringify({ subscription: { bad: true } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('subscription');
  });

  it('POST /api/share без onShare → 503, с onShare → код', async () => {
    s = await start({});
    const no = await fetch(`${s.base}/api/share`, { method: 'POST', headers: { cookie: authCookie() } });
    expect(no.status).toBe(503);
    await s.server.close();
    s = await start({ onShare: async () => ({ code: 'ABCD-EFGH-JKMN-PQRS', expiresAt: 42 }) });
    const yes = await fetch(`${s.base}/api/share`, { method: 'POST', headers: { cookie: authCookie() } });
    expect(yes.status).toBe(200);
    expect(await yes.json()).toEqual({ code: 'ABCD-EFGH-JKMN-PQRS', expiresAt: 42 });
  });

  it('GET / отдаёт HTML-заглушку когда static пуст', async () => {
    // Явный ПУСТОЙ staticDir: тест не зависит от того, наполнен ли реальный
    // packages/agent/static web-сборкой (общий gitignored каталог).
    const emptyStatic = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-empty-static-'));
    try {
      s = await start({ staticDir: emptyStatic });
      const res = await fetch(`${s.base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('build the web bundle');
    } finally {
      fs.rmSync(emptyStatic, { recursive: true, force: true });
    }
  });
});

describe('AgentServer — TLS (config.tls хранит пути к файлам)', () => {
  it('listen() с несуществующим путём сертификата → reject с понятным сообщением', async () => {
    const server = new AgentServer({
      config: fixtureConfig({ tls: { cert: '/no/such/dir/cert.pem', key: '/no/such/dir/key.pem' } }),
      sessions: stubSessions(),
    });
    await expect(server.listen()).rejects.toThrow('Failed to read TLS certificate: /no/such/dir/cert.pem');
  });
});

describe('AgentServer — WS /ws/term/:name (upgrade)', () => {
  let s: Started;

  afterEach(async () => {
    await s.server.close();
  });

  function wsUrl(base: string, name: string): string {
    return `${base.replace('http', 'ws')}/ws/term/${name}`;
  }

  it('upgrade без cookie отвергается (HTTP 401 до upgrade)', async () => {
    s = await start({});
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(s.base, 'main'));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('соединение не должно было открыться')));
      ws.on('error', () => {
        /* игнорируем — важен код unexpected-response */
      });
    });
    expect(status).toBe(401);
  });

  it('upgrade с чужим Origin отвергается (HTTP 403 до upgrade), даже с валидной cookie', async () => {
    s = await start({});
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(s.base, 'main'), {
        origin: 'http://evil.example',
        headers: { cookie: authCookie() },
      });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('open', () => reject(new Error('соединение не должно было открыться')));
      ws.on('error', () => {
        /* игнорируем — важен код unexpected-response */
      });
    });
    expect(status).toBe(403);
  });

  it('upgrade с Origin, совпадающим с Host запроса, проходит как обычно', async () => {
    s = await start({});
    const got = new Promise<string>((resolve) => {
      s.server.attachTerminalWs((ws, session) => {
        resolve(session);
        ws.close(1000);
      });
    });
    const ws = new WebSocket(wsUrl(s.base, 'main'), { origin: s.base, headers: { cookie: authCookie() } });
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(await got).toBe('main');
  });

  it('с cookie, но без attachTerminalWs → соединение закрывается кодом 1011', async () => {
    s = await start({});
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl(s.base, 'main'), { headers: { cookie: authCookie() } });
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(1011);
  });

  it('с cookie и attachTerminalWs → хендлер получает (ws, decodeURIComponent(name))', async () => {
    s = await start({});
    const got = new Promise<string>((resolve) => {
      s.server.attachTerminalWs((ws, session) => {
        resolve(session);
        ws.close(1000);
      });
    });
    // %2E → «.» — валиден по NAME_RE и всё равно проверяет decodeURIComponent.
    const ws = new WebSocket(wsUrl(s.base, 'my%2Eroom'), { headers: { cookie: authCookie() } });
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(await got).toBe('my.room');
  });

  it('upgrade с именем, не проходящим NAME_RE, отвергается (pty не спавнится)', async () => {
    s = await start({});
    const handler = vi.fn();
    s.server.attachTerminalWs(handler);
    const rejected = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(wsUrl(s.base, 'bad%20name!'), { headers: { cookie: authCookie() } });
      ws.on('open', () => resolve(false));
      ws.on('error', () => resolve(true));
      ws.on('close', () => resolve(true));
    });
    expect(rejected).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });
});

/** Доступен ли tmux (иначе describe с реальным SessionService пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

describe.skipIf(!tmuxAvailable)('AgentServer — реальный SessionService (изолированный tmux)', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  let root: string;
  let started: Started;
  let SessionServiceCtor: typeof import('../src/sessions.js').SessionService;

  beforeAll(async () => {
    SessionServiceCtor = (await import('../src/sessions.js')).SessionService;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-srv-'));
    fs.mkdirSync(path.join(root, 'projectA'));
    const sessions = new SessionServiceCtor({ roots: [root], socketName });
    started = await start({ config: fixtureConfig({ sessionRoots: [root] }), sessions });
  });

  afterAll(async () => {
    await started.server.close();
    try {
      execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // сервер мог не подниматься
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('POST создаёт сессию, GET её видит, DELETE удаляет', async () => {
    const cookie = authCookie();
    const created = await fetch(`${started.base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ name: 'srvmain', root, dir: 'projectA', preset: 'zsh' }),
    });
    expect(created.status).toBe(200);

    const listed = await fetch(`${started.base}/api/sessions`, { headers: { cookie } });
    const sessions = (await listed.json()) as SessionInfo[];
    expect(sessions.map((x) => x.name)).toContain('srvmain');

    const del = await fetch(`${started.base}/api/sessions/srvmain`, { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);

    const after = await fetch(`${started.base}/api/sessions`, { headers: { cookie } });
    expect(((await after.json()) as SessionInfo[]).map((x) => x.name)).not.toContain('srvmain');
  });

  it('DELETE несуществующей сессии → 404', async () => {
    const del = await fetch(`${started.base}/api/sessions/nope-xyz`, {
      method: 'DELETE',
      headers: { cookie: authCookie() },
    });
    expect(del.status).toBe(404);
  });
});
