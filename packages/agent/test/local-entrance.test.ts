// Локальные входы агента: сертификат для localhost, выбираемый по имени запроса,
// и обычный HTTP на loopback. Сертификаты выпускаются настоящим openssl во временный каталог.
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { AgentServer } from '../src/server.js';
import { hashPassword, type TermhubConfig } from '../src/config.js';
import { generateLocalCert, type LocalCertPaths } from '../src/local-cert.js';
import type { SessionService } from '../src/sessions.js';

let dir: string;
let local: LocalCertPaths;
let main: { cert: string; key: string };

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-local-'));
  local = generateLocalCert(dir);
  // «Основной» сертификат агента — самоподписанный на внешнее имя.
  main = { cert: path.join(dir, 'main.pem'), key: path.join(dir, 'main-key.pem') };
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=agent.example.net',
    '-addext', 'subjectAltName=DNS:agent.example.net', '-keyout', main.key, '-out', main.cert], { stdio: 'ignore' });
  return () => fs.rmSync(dir, { recursive: true, force: true });
});

function config(over: Partial<TermhubConfig> = {}): TermhubConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    passwordHash: hashPassword('secret'),
    cookieSecret: 'x'.repeat(32),
    sessionRoots: [],
    tls: null,
    relayUrl: null,
    vapid: { publicKey: 'pub', privateKey: 'priv', subject: 'mailto:termhub@localhost' },
    locale: null,
    ...over,
  };
}

const sessions = { list: async () => [] } as unknown as SessionService;
let server: AgentServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Какой сертификат отдаёт сервер на это имя и доверяет ли ему клиент с данным центром. */
function handshake(port: number, servername: string, ca?: Buffer): Promise<{ subject: string; authorized: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername, ca, rejectUnauthorized: false }, () => {
      const subject = new X509Certificate(sock.getPeerCertificate(true).raw).subject;
      resolve({ subject, authorized: sock.authorized });
      sock.destroy();
    });
    sock.on('error', reject);
  });
}

describe('сертификат для localhost', () => {
  it('центр годен только для localhost, лист несёт нужные имена, секреты закрыты', () => {
    const ca = new X509Certificate(fs.readFileSync(local.ca));
    const leaf = new X509Certificate(fs.readFileSync(local.cert));
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.checkHost('example.com')).toBeUndefined();
    expect(leaf.checkIssued(ca)).toBe(true);
    const text = execFileSync('openssl', ['x509', '-in', local.ca, '-noout', '-text']).toString();
    expect(text).toMatch(/Name Constraints: critical/);
    expect(text).toMatch(/DNS:localhost/);
    for (const f of [local.key, path.join(dir, 'local-ca-key.pem')]) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });

  it('повторный выпуск обновляет лист, но не меняет центр — доверие остаётся в силе', () => {
    const caBefore = fs.readFileSync(local.ca, 'utf8');
    const leafBefore = fs.readFileSync(local.cert, 'utf8');
    generateLocalCert(dir);
    expect(fs.readFileSync(local.ca, 'utf8')).toBe(caBefore);
    expect(fs.readFileSync(local.cert, 'utf8')).not.toBe(leafBefore);
  });

  it('по имени localhost отдаётся свой сертификат, по внешнему — основной', async () => {
    server = new AgentServer({ config: config({ tls: main, tlsExtra: [{ cert: local.cert, key: local.key }] }), sessions });
    const port = await server.listen();
    const ca = fs.readFileSync(local.ca);
    const viaLocalhost = await handshake(port, 'localhost', ca);
    expect(viaLocalhost.subject).toContain('CN=localhost');
    expect(viaLocalhost.authorized).toBe(true);
    const viaName = await handshake(port, 'agent.example.net', ca);
    expect(viaName.subject).toContain('CN=agent.example.net');
    // незнакомое имя — основной сертификат, как и раньше
    expect((await handshake(port, 'other.example.org', ca)).subject).toContain('CN=agent.example.net');
  });

  it('без tlsExtra поведение прежнее', async () => {
    server = new AgentServer({ config: config({ tls: main }), sessions });
    const port = await server.listen();
    expect((await handshake(port, 'localhost')).subject).toContain('CN=agent.example.net');
  });
});

describe('обычный HTTP на loopback', () => {
  it('второй вход отвечает тем же приложением; кука без Secure на HTTP и с Secure на HTTPS', async () => {
    server = new AgentServer({ config: config({ tls: main, localHttpPort: 0 }), sessions });
    const port = await server.listen();
    const local = server.loopbackPort();
    expect(local).toBeTypeOf('number');
    expect(local).not.toBe(port);
    const mode = await fetch(`http://127.0.0.1:${local}/api/mode`);
    expect(((await mode.json()) as { mode: string }).mode).toBe('lan');
    const login = await fetch(`http://127.0.0.1:${local}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
    // кука с этого входа пускает к API
    const list = await fetch(`http://127.0.0.1:${local}/api/sessions`, { headers: { Cookie: cookie.split(';')[0] } });
    expect(list.status).toBe(200);
  });

  it('вход слушает только 127.0.0.1 и закрывается вместе с сервером', async () => {
    server = new AgentServer({ config: config({ host: '0.0.0.0', localHttpPort: 0 }), sessions });
    await server.listen();
    const local = server.loopbackPort() as number;
    const lan = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (lan) await expect(fetch(`http://${lan}:${local}/api/mode`)).rejects.toThrow();
    await server.close();
    server = undefined;
    await expect(fetch(`http://127.0.0.1:${local}/api/mode`)).rejects.toThrow();
  });

  it('без localHttpPort второго входа нет; занятый порт агента не роняет', async () => {
    server = new AgentServer({ config: config(), sessions });
    const port = await server.listen();
    expect(server.loopbackPort()).toBeUndefined();
    const second = new AgentServer({ config: config({ localHttpPort: port }), sessions });
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (m: string) => warnings.push(m);
    try {
      await second.listen();
      expect(second.loopbackPort()).toBeUndefined();
      expect(warnings.join('\n')).toContain('local http port');
    } finally {
      console.warn = warn;
      await second.close();
    }
  });
});
