// Relay со своим TLS и адресом привязки — так его запускает агент на своей машине.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { startRelay, type RelayHandle } from '../src/index.js';

let handle: RelayHandle | undefined;
let dir: string | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function selfSigned(): { cert: string; key: string } {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-relay-tls-'));
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=relay.example.com',
  ], { stdio: 'ignore' });
  return { cert, key };
}

function get(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    https
      .get({ host: '127.0.0.1', port, path: pathname, rejectUnauthorized: false }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on('error', reject);
  });
}

describe('relay с TLS', () => {
  it('отвечает по HTTPS и принимает WSS на loopback', async () => {
    handle = await startRelay({ port: 0, host: '127.0.0.1', tls: selfSigned(), silent: true });
    expect(await get(handle.port, '/healthz')).toEqual({ status: 200, body: 'ok' });
    expect(JSON.parse((await get(handle.port, '/api/mode')).body).mode).toBe('relay');

    const ws = new WebSocket(`wss://127.0.0.1:${handle.port}/relay`, { rejectUnauthorized: false });
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'register', edPub: 'bad' })));
      ws.on('message', (d) => resolve(String(d)));
      ws.on('error', reject);
    });
    ws.terminate();
    expect(JSON.parse(reply).t).toBe('error');
  });

  it('занятый порт — отказ запуска, а не необработанная ошибка', async () => {
    handle = await startRelay({ port: 0, host: '127.0.0.1', silent: true });
    await expect(startRelay({ port: handle.port, host: '127.0.0.1', silent: true })).rejects.toThrow(/EADDRINUSE/);
  });
});

function plain(
  port: number,
  pathname: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: opts.method ?? 'GET', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function wsStatus(port: number, headers: Record<string, string> = {}): Promise<number | 'open'> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`, { headers });
    ws.on('open', () => {
      ws.terminate();
      resolve('open');
    });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => {});
  });
}

describe('requireHttps', () => {
  it('без сертификата и без доверенного прокси relay не запускается', async () => {
    await expect(startRelay({ port: 0, requireHttps: true, silent: true })).rejects.toThrow(/HTTPS is required/);
  });

  it('за прокси: без слова прокси — перенаправление и отказ, со словом — работа', async () => {
    handle = await startRelay({ port: 0, host: '127.0.0.1', requireHttps: true, trustProxy: true, silent: true });
    const port = handle.port;
    const page = await plain(port, '/some?x=1', { headers: { Host: 'relay.example.com:9443' } });
    expect(page.status).toBe(308);
    expect(page.location).toBe('https://relay.example.com:9443/some?x=1');
    expect((await plain(port, '/relay/open', { method: 'POST' })).status).toBe(403);
    expect((await plain(port, '/api/mode', { headers: { Host: 'evil/host' } })).status).toBe(403);
    expect(await wsStatus(port)).toBe(403);
    // Проверка контейнера ходит мимо прокси.
    expect((await plain(port, '/healthz')).status).toBe(200);

    const ok = { 'X-Forwarded-Proto': 'https' };
    expect((await plain(port, '/api/mode', { headers: ok })).status).toBe(200);
    expect(await wsStatus(port, ok)).toBe('open');
    // Значение, подсунутое клиентом, стоит левее дописанного прокси и не считается.
    expect((await plain(port, '/api/mode', { headers: { 'X-Forwarded-Proto': 'https, http' } })).status).toBe(308);
  });

  it('со своим сертификатом требование выполнено самим TLS', async () => {
    handle = await startRelay({ port: 0, host: '127.0.0.1', tls: selfSigned(), requireHttps: true, silent: true });
    expect((await get(handle.port, '/api/mode')).status).toBe(200);
  });
});
