// HTTP/WS-сервер агента: REST под cookie-auth, раздача web-статики и upgrade
// терминальных WS. Только node:http(s) + ws — без веб-фреймворков.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { TermhubConfig } from './config.js';
import { verifyPassword, loadAuthorized, saveAuthorized, VERSION } from './config.js';
import type { DeviceScope } from './config.js';
import type { SessionService } from './sessions.js';
import { runFileOp } from './files.js';
import type { FileService } from './files.js';
import { runRepoAction } from './vcs.js';
import type { VcsService } from './vcs.js';
import { issueCookie, checkCookie, LoginRateLimit } from './auth.js';

/** Сервис веб-push (реализация — Task 9). */
export interface PushService {
  subscribe(sub: unknown): Promise<void>;
  vapidPublicKey(): string;
}

/** Управление системным сном (caffeinate). */
export interface CaffeinateController {
  readonly supported: boolean;
  isActive(): boolean;
  set(on: boolean): void;
}

const COOKIE_NAME = 'termhub';
/** Имя терминальной сессии: тот же контракт, что в SessionService.create/kill. */
const SESSION_NAME_RE = /^[\w.-]{1,40}$/;
/** Max-Age cookie в секундах (30 суток). */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
/** Лимит тела запроса: 64 KiB. */
const BODY_LIMIT = 64 * 1024;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const PLACEHOLDER_HTML =
  '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>TermHub</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
  '<h1>TermHub: соберите web-пакет</h1>' +
  '<p>Веб-интерфейс ещё не собран.</p></body></html>';

/** Тело запроса превысило лимит. */
class PayloadTooLargeError extends Error {}
/** Тело запроса не является валидным JSON-объектом. */
class BadJsonError extends Error {}

/** Читает тело запроса с ограничением размера; при превышении лимита отвечает
 *  413 в сокет ДО его разрушения (иначе клиент видит сетевой обрыв, а не 413). */
function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
        res.end(JSON.stringify({ error: 'тело запроса слишком велико' }));
        req.destroy();
        reject(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

/** Валидирует scope из тела /api/share: `{session, write, files}` или undefined
 *  (полный доступ). Некорректная сессия → undefined (не ограничиваем неверным именем). */
function parseScope(v: unknown): DeviceScope | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const s = v as { session?: unknown; write?: unknown; files?: unknown };
  if (typeof s.session !== 'string' || !SESSION_NAME_RE.test(s.session)) return undefined;
  return { session: s.session, write: s.write === true, files: s.files === true };
}

/** Разбирает заголовок Cookie в карту имя→значение. */
function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return map;
}

/** HTTP/WS-сервер агента. */
export class AgentServer {
  private readonly config: TermhubConfig;
  private readonly sessions: SessionService;
  private readonly files?: FileService;
  private readonly vcs?: VcsService;
  private readonly onShare?: (scope?: DeviceScope) => Promise<{ code: string; expiresAt: number }>;
  private readonly relayStatus?: () => { connected: boolean; agentId: string; clients: number } | null;
  private readonly push?: PushService;
  private readonly caffeinate?: CaffeinateController;
  private readonly rateLimit = new LoginRateLimit();
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly staticDir: string;
  private server?: Server;
  private termHandler?: (ws: WebSocket, session: string) => void;

  constructor(opts: {
    config: TermhubConfig;
    sessions: SessionService;
    files?: FileService;
    vcs?: VcsService;
    onShare?: (scope?: DeviceScope) => Promise<{ code: string; expiresAt: number }>;
    relayStatus?: () => { connected: boolean; agentId: string; clients: number } | null;
    push?: PushService;
    caffeinate?: CaffeinateController;
    /** Каталог web-статики; по умолчанию packages/agent/static (для тестов — переопределяемый). */
    staticDir?: string;
  }) {
    this.config = opts.config;
    this.sessions = opts.sessions;
    this.files = opts.files;
    this.vcs = opts.vcs;
    this.onShare = opts.onShare;
    this.relayStatus = opts.relayStatus;
    this.push = opts.push;
    this.caffeinate = opts.caffeinate;
    this.staticDir = opts.staticDir ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
  }

  /** Регистрирует обработчик терминальных WS (Task 6). */
  attachTerminalWs(handler: (ws: WebSocket, session: string) => void): void {
    this.termHandler = handler;
  }

  /** Поднимает сервер (https при заданном TLS) и возвращает фактический порт. */
  async listen(): Promise<number> {
    const server = this.config.tls
      ? https.createServer(this.readTls(this.config.tls), (req, res) => this.dispatch(req, res))
      : http.createServer((req, res) => this.dispatch(req, res));
    server.requestTimeout = 30_000;
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.config.port, this.config.host, resolve));
    const addr = server.address();
    return typeof addr === 'object' && addr ? addr.port : this.config.port;
  }

  /** config.tls хранит пути к файлам сертификата/ключа — читает их содержимое. */
  private readTls(tls: { cert: string; key: string }): { cert: Buffer; key: Buffer } {
    return { cert: this.readTlsFile(tls.cert), key: this.readTlsFile(tls.key) };
  }

  private readTlsFile(file: string): Buffer {
    try {
      return fs.readFileSync(file);
    } catch {
      throw new Error(`Не удалось прочитать TLS-сертификат: ${file}`);
    }
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    if (!this.server) return;
    // Keep-alive HTTP-сокеты браузера иначе держали бы server.close() открытым до
    // своего таймаута; закрываем простаивающие сразу (WS уже terminate()-нуты выше).
    this.server.closeIdleConnections();
    await new Promise<void>((resolve, reject) => {
      this.server!.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  /** Точка входа запроса: маршрутизация с честными кодами ошибок. */
  private dispatch(req: IncomingMessage, res: ServerResponse): void {
    this.route(req, res).catch((err) => {
      // PayloadTooLargeError уже отвечает в readBody() до этой точки (res.writableEnded).
      if (res.writableEnded || res.headersSent) return;
      if (err instanceof BadJsonError) this.sendJson(res, 400, { error: 'некорректный JSON' });
      else this.sendJson(res, 500, { error: 'внутренняя ошибка' });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET') return this.sendJson(res, 405, { error: 'метод не поддерживается' });
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        return this.sendJson(res, 400, { error: 'некорректный путь' });
      }
      return this.serveStatic(res, decoded);
    }

    // Публичные маршруты (без cookie-auth).
    if (method === 'POST' && pathname === '/api/login') return this.login(req, res);
    if (method === 'GET' && pathname === '/api/mode')
      return this.sendJson(res, 200, { mode: 'lan', host: os.hostname() });
    if (method === 'GET' && pathname === '/api/push/vapid-key') {
      if (!this.push) return this.sendJson(res, 503, { error: 'push не настроен' });
      return this.sendJson(res, 200, { key: this.push.vapidPublicKey() });
    }

    // Ниже — только под cookie-auth.
    if (!this.authed(req)) return this.sendJson(res, 401, { error: 'требуется авторизация' });

    if (method === 'GET' && pathname === '/api/sessions')
      return this.sendJson(res, 200, await this.sessions.list());
    if (method === 'POST' && pathname === '/api/sessions') return this.createSession(req, res);
    if (method === 'DELETE' && pathname.startsWith('/api/sessions/')) {
      let name: string;
      try {
        name = decodeURIComponent(pathname.slice('/api/sessions/'.length));
      } catch {
        return this.sendJson(res, 400, { error: 'некорректный путь' });
      }
      return this.killSession(res, name);
    }
    if (method === 'GET' && pathname === '/api/dirs') return this.sendJson(res, 200, await this.sessions.dirs());
    if (method === 'GET' && pathname === '/api/diag') return this.diag(res);
    if (method === 'GET' && pathname === '/api/files/list') return this.filesList(res, url);
    if (method === 'GET' && pathname === '/api/files/read') return this.fileRead(res, url);
    if (method === 'GET' && pathname === '/api/files/stat') return this.fileStatHttp(res, url);
    if (method === 'GET' && pathname === '/api/files/download') return this.fileDownload(req, res, url);
    if (method === 'POST' && pathname === '/api/repo') return this.repoApi(req, res);
    if (method === 'POST' && pathname === '/api/files/op') return this.filesOp(req, res);
    if (method === 'POST' && pathname === '/api/push/subscribe') return this.pushSubscribe(req, res);
    if (method === 'GET' && pathname === '/api/devices') {
      const list = loadAuthorized().map((d) => ({ name: d.name, fingerprint: d.fingerprint, addedAt: d.addedAt }));
      return this.sendJson(res, 200, list);
    }
    if (method === 'DELETE' && pathname.startsWith('/api/devices/')) {
      let fingerprint: string;
      try {
        fingerprint = decodeURIComponent(pathname.slice('/api/devices/'.length));
      } catch {
        return this.sendJson(res, 400, { error: 'некорректный путь' });
      }
      return this.removeDevice(res, fingerprint);
    }
    if (method === 'POST' && pathname === '/api/share') {
      if (!this.onShare) return this.sendJson(res, 503, { error: 'relay не настроен' });
      const body = await this.readJson(req, res);
      return this.sendJson(res, 200, await this.onShare(parseScope(body.scope)));
    }
    if (method === 'GET' && pathname === '/api/caffeinate') return this.sendJson(res, 200, this.caffeinateState());
    if (method === 'POST' && pathname === '/api/caffeinate') return this.setCaffeinate(req, res);

    return this.sendJson(res, 404, { error: 'не найдено' });
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'unknown';
    if (!this.rateLimit.allow(ip)) return this.sendJson(res, 429, { error: 'слишком много попыток входа' });
    const body = await this.readJson(req, res);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!verifyPassword(password, this.config.passwordHash)) {
      this.rateLimit.fail(ip);
      return this.sendJson(res, 401, { error: 'неверный пароль' });
    }
    res.setHeader('Set-Cookie', this.cookieHeader());
    this.sendJson(res, 200, { ok: true });
  }

  private cookieHeader(): string {
    const attrs = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${COOKIE_MAX_AGE}`];
    if (this.config.tls) attrs.push('Secure');
    return `${COOKIE_NAME}=${issueCookie(this.config.cookieSecret)}; ${attrs.join('; ')}`;
  }

  private async createSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    try {
      await this.sessions.create({
        name: String(body.name ?? ''),
        root: String(body.root ?? ''),
        dir: String(body.dir ?? ''),
        preset: body.preset as 'zsh' | 'claude',
      });
      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      this.sendJson(res, 422, { error: (err as Error).message });
    }
  }

  private async repoApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.vcs) return this.sendJson(res, 503, { error: 'репозиторий недоступен' });
    const body = await this.readJson(req, res);
    try {
      const result = await runRepoAction(this.vcs, body);
      this.sendJson(res, 200, { result });
    } catch (err) {
      this.sendJson(res, 400, { error: (err as Error).message });
    }
  }

  /** Диагностика: версия, аптайм, сессии, статус связи с relay, корни. */
  private async diag(res: ServerResponse): Promise<void> {
    const sessions = await this.sessions.list().catch(() => []);
    const rs = this.relayStatus?.();
    this.sendJson(res, 200, {
      version: VERSION,
      host: os.hostname(),
      uptimeMs: Math.round(process.uptime() * 1000),
      port: this.config.port,
      tls: !!this.config.tls,
      roots: this.config.sessionRoots,
      sessions: sessions.length,
      relay: this.config.relayUrl
        ? {
            configured: true,
            url: this.config.relayUrl,
            connected: rs?.connected ?? false,
            agentId: rs?.agentId ?? '',
            clients: rs?.clients ?? 0,
          }
        : { configured: false },
    });
  }

  private async filesOp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.files) return this.sendJson(res, 503, { error: 'файловый браузер недоступен' });
    const body = await this.readJson(req, res);
    try {
      const result = await runFileOp(this.files, body);
      this.sendJson(res, 200, { result });
    } catch (err) {
      this.sendJson(res, 400, { error: (err as Error).message });
    }
  }

  private async filesList(res: ServerResponse, url: URL): Promise<void> {
    if (!this.files) return this.sendJson(res, 503, { error: 'файловый браузер недоступен' });
    try {
      const entries = await this.files.listDir(url.searchParams.get('root') ?? '', url.searchParams.get('path') ?? '');
      return this.sendJson(res, 200, { entries });
    } catch (err) {
      return this.sendJson(res, 400, { error: (err as Error).message });
    }
  }

  private async fileRead(res: ServerResponse, url: URL): Promise<void> {
    if (!this.files) return this.sendJson(res, 503, { error: 'файловый браузер недоступен' });
    try {
      const content = await this.files.readFile(url.searchParams.get('root') ?? '', url.searchParams.get('path') ?? '');
      return this.sendJson(res, 200, { content });
    } catch (err) {
      return this.sendJson(res, 400, { error: (err as Error).message });
    }
  }

  private async fileStatHttp(res: ServerResponse, url: URL): Promise<void> {
    if (!this.files) return this.sendJson(res, 503, { error: 'файловый браузер недоступен' });
    try {
      const stat = await this.files.statFile(url.searchParams.get('root') ?? '', url.searchParams.get('path') ?? '');
      return this.sendJson(res, 200, { stat });
    } catch (err) {
      return this.sendJson(res, 400, { error: (err as Error).message });
    }
  }

  /** Стрим файла с поддержкой Range (нативное видео/скачивание, LAN). */
  private async fileDownload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!this.files) return this.sendJson(res, 503, { error: 'файловый браузер недоступен' });
    let info: { path: string; size: number; mime: string };
    try {
      info = await this.files.resolveFile(url.searchParams.get('root') ?? '', url.searchParams.get('path') ?? '');
    } catch (err) {
      return this.sendJson(res, 400, { error: (err as Error).message });
    }
    const { path: filePath, size, mime } = info;
    const range = req.headers.range;
    const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (Number.isNaN(start) || start >= size || start < 0) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        return void res.end();
      }
      end = Math.min(end, size - 1);
      res.writeHead(206, {
        'Content-Type': mime,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' });
      fs.createReadStream(filePath).pipe(res);
    }
  }

  private async killSession(res: ServerResponse, name: string): Promise<void> {
    try {
      await this.sessions.kill(name);
      this.sendJson(res, 200, { ok: true });
    } catch (err) {
      // Валидация имени (sessions.ts) бросает Error без .code → 422 (запрос клиента некорректен).
      // Остальное — реальный вызов tmux (execFile всегда проставляет .code): 404, только если
      // это точно «сессии нет» по тексту ошибки; прочие сбои (ENOENT и т.п.) — честные 500.
      const code = (err as { code?: unknown }).code;
      if (code === undefined) return this.sendJson(res, 422, { error: (err as Error).message });
      if (this.isSessionNotFound(err)) return this.sendJson(res, 404, { error: (err as Error).message });
      this.sendJson(res, 500, { error: 'внутренняя ошибка' });
    }
  }

  /** true, если ошибка tmux означает «такой сессии нет» (а не сбой tmux/системы).
   *  Учитывает и «нет сервера tmux вовсе» (kill-session последней сессии сервера
   *  сам его останавливает) — это тоже «сессии нет», как и для sessions.ts list().
   *  Голое «error connecting» НЕ матчим: оно сопровождает и «No such file or directory»
   *  (сервера нет → 404), и «Permission denied» (реальный сбой сокета → 500). Первое
   *  покрыто отдельной альтернативой, второе честно уходит в 500. */
  private isSessionNotFound(err: unknown): boolean {
    const e = err as { message?: unknown; stderr?: unknown };
    const text = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.stderr === 'string' ? e.stderr : ''}`;
    return /can't find session|session not found|no server running|no such file or directory/i.test(text);
  }

  private async pushSubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.push) return this.sendJson(res, 503, { error: 'push не настроен' });
    const body = await this.readJson(req, res);
    try {
      await this.push.subscribe(body.subscription);
    } catch (err) {
      // push.subscribe валидирует форму подписки и бросает Error на невалидной — это
      // некорректный запрос клиента (400), а не внутренняя ошибка сервера (500).
      return this.sendJson(res, 400, { error: (err as Error).message });
    }
    this.sendJson(res, 200, { ok: true });
  }

  /** Текущее состояние удержания сна: активно ли и поддерживается ли платформой. */
  private caffeinateState(): { active: boolean; supported: boolean } {
    return {
      active: this.caffeinate?.isActive() ?? false,
      supported: this.caffeinate?.supported ?? false,
    };
  }

  private async setCaffeinate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readJson(req, res);
    if (typeof body.active !== 'boolean') return this.sendJson(res, 422, { error: 'ожидается { active: boolean }' });
    if (!this.caffeinate?.supported) return this.sendJson(res, 503, { error: 'caffeinate недоступен' });
    this.caffeinate.set(body.active);
    this.sendJson(res, 200, this.caffeinateState());
  }

  private removeDevice(res: ServerResponse, fingerprint: string): void {
    const list = loadAuthorized();
    saveAuthorized(list.filter((d) => d.fingerprint !== fingerprint));
    this.sendJson(res, 200, { ok: true });
  }

  /** Проверяет cookie-авторизацию запроса. */
  private authed(req: IncomingMessage): boolean {
    const cookie = parseCookies(req.headers.cookie).get(COOKIE_NAME);
    return checkCookie(cookie, this.config.cookieSecret);
  }

  /** Defense-in-depth поверх SameSite=Lax: если Origin задан, его host должен
   *  совпадать с Host запроса. CLI-клиенты Origin не шлют — пропускаем. */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  private async readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown>> {
    const buf = await readBody(req, res, BODY_LIMIT);
    if (buf.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch {
      throw new BadJsonError();
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BadJsonError();
    return parsed as Record<string, unknown>;
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  }

  /** Раздаёт статику из packages/agent/static с SPA-fallback и защитой от traversal. */
  private serveStatic(res: ServerResponse, pathname: string): void {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.normalize(path.join(this.staticDir, rel));
    if (full !== this.staticDir && !full.startsWith(this.staticDir + path.sep)) {
      this.sendJson(res, 403, { error: 'запрещено' });
      return;
    }
    if (this.isFile(full)) return this.sendFile(res, full);
    // SPA-fallback: неизвестные не-/api пути → index.html (или заглушка).
    const index = path.join(this.staticDir, 'index.html');
    if (this.isFile(index)) return this.sendFile(res, index);
    const buf = Buffer.from(PLACEHOLDER_HTML, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_CACHE, 'Content-Length': buf.length });
    res.end(buf);
  }

  private isFile(file: string): boolean {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  }

  private sendFile(res: ServerResponse, full: string): void {
    const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
    const relFromRoot = path.relative(this.staticDir, full).split(path.sep);
    const cache = relFromRoot[0] === 'assets' ? IMMUTABLE_CACHE : NO_CACHE;
    const data = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': data.length });
    res.end(data);
  }

  /** Обрабатывает WS-upgrade: путь /ws/term/:name, Origin-гейт и cookie-проверка ДО upgrade. */
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = /^\/ws\/term\/(.+)$/.exec(url.pathname);
    if (!match) {
      socket.destroy();
      return;
    }
    if (!this.originAllowed(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!this.authed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    let name: string;
    try {
      name = decodeURIComponent(match[1]!);
    } catch {
      socket.destroy();
      return;
    }
    // Тот же контракт имени, что в SessionService.create/kill: не спавним pty под
    // имя, которое сервис всё равно отверг бы (симметрия и защита от инъекции).
    if (!SESSION_NAME_RE.test(name)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (this.termHandler) this.termHandler(ws, name);
      else ws.close(1011, 'terminal handler not ready');
    });
  }
}
