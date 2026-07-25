// Relay-сервер TermHub: тонкий zero-knowledge коммутатор между агентами и
// удалёнными клиентами. Проверяет владение Ed25519-ключом (register/challenge/
// prove), связывает клиентов с агентом по connId и слепо форвардит бинарь. Не
// расшифровывает содержимое, ничего не пишет на диск. Только node:http + ws.

import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { verify, fingerprint } from '@termhub/protocol';
import { Rooms, type AgentConn, MAX_PAIR_ATTEMPTS } from './rooms.js';
import { serveStatic } from './static.js';

/** Максимальный размер WS-сообщения; больше → соединение закрывается с 1009.
 *  16 МБ — чтобы вмещать чтение файлов браузером (картинка до 10 МБ → base64
 *  ~13.3 МБ + E2E/JSON overhead); терминальные фреймы много меньше. */
const MAX_MESSAGE = 16 * 1024 * 1024;
/** Потолок неотправленного буфера сокета: выше — получатель не успевает. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** Период heartbeat: не ответившие на ping соединения выселяем (мёртвые NAT-сессии). */
const HEARTBEAT_MS = 30_000;
/** TTL pair-комнаты по умолчанию — 5 минут. */
const DEFAULT_PAIR_TTL = 5 * 60 * 1000;
/** Ограничение новых соединений с одного IP по умолчанию (простое окно). */
const DEFAULT_RATE_LIMIT = { max: 240, windowMs: 60 * 1000 };
/** Длина Ed25519-публичного ключа. */
const ED25519_PUB_BYTES = 32;
/** Путь WS-эндпоинта relay. */
const WS_PATH = '/relay';

export interface RelayOptions {
  port: number;
  /** Каталог собранного web-бандла; без него отдаётся заглушка. */
  staticDir?: string;
  /** TTL pair-комнаты в мс (для тестов). */
  pairTtlMs?: number;
  /** Ограничение новых соединений с одного IP (простое окно); по умолчанию 240/мин. */
  rateLimit?: { max: number; windowMs: number };
  /** Доверять заголовку X-Forwarded-For (за TLS-прокси). По умолчанию — env
   *  RELAY_TRUST_PROXY==='1'. Влияет на IP для rate-limit: при доверии берём
   *  первый IP из XFF, иначе — req.socket.remoteAddress (защита от спуфинга). */
  trustProxy?: boolean;
  /** Заглушить stdout-логирование (тесты). */
  silent?: boolean;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

/** Состояние одного WS-соединения relay (эволюционирует по мере хендшейка). */
interface ConnState {
  ip: string;
  /** Ответил ли на последний ping (heartbeat): иначе соединение считаем мёртвым. */
  alive?: boolean;
  // register-хендшейк
  regEdPub?: Buffer;
  regNonce?: Buffer;
  // зарегистрированный агент
  agentId?: string;
  // форвардинг-клиент
  clientAgentId?: string;
  clientConnId?: number;
  // pair
  pairRoomId?: string;
  pairSide?: 'agent' | 'client';
}

/** Поднимает relay и возвращает дескриптор для остановки. */
export function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  return new RelayServer(opts).listen();
}

class RelayServer {
  private readonly opts: RelayOptions;
  private readonly rooms = new Rooms();
  private readonly states = new Map<WebSocket, ConnState>();
  private readonly rate = new Map<string, { count: number; windowStart: number }>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  private readonly pairTtl: number;
  private readonly rateCfg: { max: number; windowMs: number };
  private readonly trustProxy: boolean;
  private readonly rateSweep: ReturnType<typeof setInterval>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private readonly server: Server;

  constructor(opts: RelayOptions) {
    this.opts = opts;
    this.pairTtl = opts.pairTtlMs ?? DEFAULT_PAIR_TTL;
    this.rateCfg = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.trustProxy = opts.trustProxy ?? process.env.RELAY_TRUST_PROXY === '1';
    // Периодический sweep протухших окон: иначе rate-Map росла бы вечно по
    // записи на каждый когда-либо виденный IP (ротация IPv6 → OOM).
    this.rateSweep = setInterval(() => sweepRateWindows(this.rate, Date.now(), this.rateCfg.windowMs), this.rateCfg.windowMs);
    if (typeof this.rateSweep.unref === 'function') this.rateSweep.unref();
    // Heartbeat: мёртвые соединения (упавший NAT, уснувший клиент) иначе висят в памяти
    // relay и занимают слоты агента до TCP-таймаута ОС.
    this.heartbeat = setInterval(() => {
      for (const [ws, st] of this.states) {
        if (st.alive === false) {
          ws.terminate();
          continue;
        }
        st.alive = false;
        try {
          ws.ping();
        } catch {
          ws.terminate();
        }
      }
    }, HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async listen(): Promise<RelayHandle> {
    await new Promise<void>((resolve) => this.server.listen(this.opts.port, resolve));
    const addr = this.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : this.opts.port;
    return { port, close: () => this.close() };
  }

  private async close(): Promise<void> {
    clearInterval(this.rateSweep);
    clearInterval(this.heartbeat);
    for (const ws of this.wss.clients) ws.terminate();
    this.rooms.dispose();
    this.wss.close();
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  private log(msg: string): void {
    if (!this.opts.silent) console.log(`[relay] ${msg}`);
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/healthz') {
      const buf = Buffer.from('ok', 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
      return;
    }
    if (method === 'GET' && pathname === '/api/mode') return this.sendJson(res, 200, { mode: 'relay' });
    if (pathname.startsWith('/api/')) return this.sendJson(res, 404, { error: 'not found' });
    if (method !== 'GET') return this.sendJson(res, 405, { error: 'method not allowed' });

    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return this.sendJson(res, 400, { error: 'bad path' });
    }
    serveStatic(res, decoded, this.opts.staticDir);
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length });
    res.end(data);
  }

  // ── WS upgrade + rate-limit ────────────────────────────────────────────────

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    const ip = this.clientIp(req);
    if (!this.rateAllow(ip)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, ip));
  }

  /** IP клиента для rate-limit. За доверенным прокси (trustProxy) — первый IP из
   *  X-Forwarded-For; иначе — адрес сокета. XFF от прямого клиента НЕ доверяем
   *  (спуфинг), поэтому по умолчанию trustProxy выключен. */
  private clientIp(req: IncomingMessage): string {
    if (this.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const raw = Array.isArray(xff) ? xff[0] : xff;
      const first = raw?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  /** Простое фиксированное окно на новые соединения с одного IP. */
  private rateAllow(ip: string): boolean {
    const limit = this.rateCfg;
    const now = Date.now();
    const entry = this.rate.get(ip);
    if (!entry || now - entry.windowStart >= limit.windowMs) {
      this.rate.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= limit.max) return false;
    entry.count++;
    return true;
  }

  // ── WS соединение ───────────────────────────────────────────────────────────

  private onConnection(ws: WebSocket, ip: string): void {
    const state: ConnState = { ip, alive: true };
    this.states.set(ws, state);
    ws.on('pong', () => {
      state.alive = true;
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      state.alive = true;
      const buf = Array.isArray(data) ? Buffer.concat(data) : (data as Buffer);
      if (isBinary) this.onBinary(state, buf);
      else this.onText(ws, state, buf);
    });
    ws.on('close', () => this.onClose(ws, state));
    ws.on('error', () => {}); // maxPayload/сетевые ошибки: закрытие уже последует
  }

  private onText(ws: WebSocket, state: ConnState, buf: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(buf.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      msg = parsed as Record<string, unknown>;
    } catch {
      send(ws, { t: 'error', code: 'bad-json' });
      ws.close(1008, 'bad json');
      return;
    }
    switch (msg.t) {
      case 'register':
        return this.onRegister(ws, state, msg);
      case 'prove':
        return this.onProve(ws, state, msg);
      case 'connect':
        return this.onConnect(ws, state, msg);
      case 'client-close':
        return this.onClientCloseFromAgent(state, msg);
      case 'pair-open':
        return this.onPairOpen(ws, state, msg);
      case 'pair-join':
        return this.onPairJoin(ws, state, msg);
      case 'pair-msg':
        return this.onPairMsg(state, msg);
      default:
        send(ws, { t: 'error', code: 'unknown-type' });
    }
  }

  private onRegister(ws: WebSocket, state: ConnState, msg: Record<string, unknown>): void {
    // Одно соединение = одна роль и одна регистрация. Иначе сокет мог зарегистрировать
    // сколько угодно agentId: rooms копил записи, а при дисконнекте снимался только
    // последний (state.agentId) — «призрачные» агенты и неограниченный рост памяти.
    if (state.agentId || state.clientAgentId) {
      send(ws, { t: 'error', code: 'already-registered' });
      ws.close(1008, 'already registered');
      return;
    }
    if (typeof msg.edPub !== 'string') {
      send(ws, { t: 'error', code: 'bad-register' });
      ws.close(1008, 'bad register');
      return;
    }
    const edPub = Buffer.from(msg.edPub, 'base64');
    if (edPub.length !== ED25519_PUB_BYTES) {
      send(ws, { t: 'error', code: 'bad-edpub' });
      ws.close(1008, 'bad edpub');
      return;
    }
    state.regEdPub = edPub;
    state.regNonce = crypto.randomBytes(32);
    send(ws, { t: 'challenge', nonce: state.regNonce.toString('base64') });
  }

  private onProve(ws: WebSocket, state: ConnState, msg: Record<string, unknown>): void {
    if (state.agentId) {
      send(ws, { t: 'error', code: 'already-registered' });
      ws.close(1008, 'already registered');
      return;
    }
    if (!state.regEdPub || !state.regNonce) {
      send(ws, { t: 'error', code: 'no-challenge' });
      ws.close(1008, 'no challenge');
      return;
    }
    const sig = typeof msg.sig === 'string' ? Buffer.from(msg.sig, 'base64') : Buffer.alloc(0);
    let ok = false;
    try {
      ok = verify(state.regEdPub, state.regNonce, sig);
    } catch {
      ok = false;
    }
    if (!ok) {
      send(ws, { t: 'error', code: 'bad-signature' });
      ws.close(1008, 'bad signature');
      return;
    }
    const agentId = fingerprint(state.regEdPub);
    const previous = this.rooms.registerAgent(agentId, ws);
    if (previous) this.closeAgentConn(previous, true);
    state.agentId = agentId;
    state.regEdPub = undefined;
    state.regNonce = undefined;
    send(ws, { t: 'registered', agentId });
    this.log(`agent registered ${agentId} (agents=${this.rooms.agentCount()})`);
  }

  private onConnect(ws: WebSocket, state: ConnState, msg: Record<string, unknown>): void {
    // Повторный connect на том же сокете занимал ещё один клиентский слот агента, а
    // освобождался при дисконнекте только последний — сокет мог выбрать весь лимит.
    if (state.clientAgentId !== undefined || state.agentId) {
      send(ws, { t: 'error', code: 'already-connected' });
      ws.close(1008, 'already connected');
      return;
    }
    if (typeof msg.agentId !== 'string') {
      send(ws, { t: 'error', code: 'bad-connect' });
      ws.close(1008, 'bad connect');
      return;
    }
    const agent = this.rooms.getAgent(msg.agentId);
    if (!agent) {
      send(ws, { t: 'error', code: 'agent-offline' });
      ws.close(4004, 'agent offline');
      return;
    }
    const connId = this.rooms.allocClient(agent, ws);
    if (connId === null) {
      send(ws, { t: 'error', code: 'too-many-clients' });
      ws.close(4008, 'too many clients');
      return;
    }
    state.clientAgentId = msg.agentId;
    state.clientConnId = connId;
    send(agent.ws, { t: 'client-open', connId });
    send(ws, { t: 'connected' });
    this.log(`client connected → ${msg.agentId} conn=${connId} (clients=${agent.clients.size})`);
  }

  private onClientCloseFromAgent(state: ConnState, msg: Record<string, unknown>): void {
    if (!state.agentId) return;
    const agent = this.rooms.getAgent(state.agentId);
    if (!agent) return;
    const connId = Number(msg.connId);
    const client = agent.clients.get(connId);
    if (!client) return;
    this.rooms.releaseClient(agent, connId);
    try {
      client.close(4000, 'closed by agent');
    } catch {
      /* ignore */
    }
  }

  private onPairOpen(ws: WebSocket, state: ConnState, msg: Record<string, unknown>): void {
    if (typeof msg.roomId !== 'string' || !msg.roomId) {
      send(ws, { t: 'error', code: 'bad-pair-open' });
      return;
    }
    const room = this.rooms.openPair(msg.roomId, ws, this.pairTtl, (r) => this.onPairExpire(r));
    if (!room) {
      // roomId занят другим агентом — его комнату не трогаем.
      send(ws, { t: 'error', code: 'room-taken' });
      return;
    }
    state.pairRoomId = msg.roomId;
    state.pairSide = 'agent';
    this.log(`pair opened ${msg.roomId} (pairs=${this.rooms.pairCount()})`);
  }

  private onPairJoin(ws: WebSocket, state: ConnState, msg: Record<string, unknown>): void {
    if (typeof msg.roomId !== 'string') {
      send(ws, { t: 'error', code: 'bad-pair-join' });
      ws.close(1008, 'bad pair-join');
      return;
    }
    const room = this.rooms.getPair(msg.roomId);
    if (!room) {
      send(ws, { t: 'error', code: 'no-room' });
      ws.close(4004, 'no room');
      return;
    }
    room.attempts++;
    if (room.attempts > MAX_PAIR_ATTEMPTS) {
      send(ws, { t: 'error', code: 'too-many-attempts' });
      ws.close(4008, 'too many attempts');
      return;
    }
    room.clientWs = ws;
    state.pairRoomId = msg.roomId;
    state.pairSide = 'client';
  }

  private onPairMsg(state: ConnState, msg: Record<string, unknown>): void {
    if (!state.pairRoomId || !state.pairSide || typeof msg.data !== 'string') return;
    const room = this.rooms.getPair(state.pairRoomId);
    if (!room) return;
    const target = state.pairSide === 'agent' ? room.clientWs : room.agentWs;
    if (target && target.readyState === WebSocket.OPEN) send(target, { t: 'pair-msg', data: msg.data });
  }

  private onPairExpire(room: { agentWs: WebSocket; clientWs: WebSocket | null }): void {
    for (const ws of [room.agentWs, room.clientWs]) {
      if (!ws) continue;
      send(ws, { t: 'pair-closed', reason: 'ttl' });
      const st = this.states.get(ws);
      if (st) {
        st.pairRoomId = undefined;
        st.pairSide = undefined;
      }
    }
  }

  // ── Бинарный форвардинг ─────────────────────────────────────────────────────

  private onBinary(state: ConnState, buf: Buffer): void {
    if (state.agentId) {
      // агент → клиент: снимаем префикс [connId:u32 BE]
      if (buf.length < 4) return;
      const agent = this.rooms.getAgent(state.agentId);
      if (!agent) return;
      const client = agent.clients.get(buf.readUInt32BE(0));
      if (!client || client.readyState !== WebSocket.OPEN) return;
      // Медленный получатель не должен раздувать память relay: перестали успевать —
      // рвём именно его соединение (агент и остальные клиенты не страдают).
      if (client.bufferedAmount > MAX_BUFFERED) {
        client.close(4009, 'backpressure');
        return;
      }
      client.send(buf.subarray(4), { binary: true });
      return;
    }
    if (state.clientConnId !== undefined && state.clientAgentId) {
      // клиент → агент: ставим префикс [connId:u32 BE]
      const agent = this.rooms.getAgent(state.clientAgentId);
      if (!agent || agent.ws.readyState !== WebSocket.OPEN) return;
      if (agent.ws.bufferedAmount > MAX_BUFFERED) return; // агент не успевает — кадр роняем
      const out = Buffer.allocUnsafe(4 + buf.length);
      out.writeUInt32BE(state.clientConnId >>> 0, 0);
      buf.copy(out, 4);
      agent.ws.send(out, { binary: true });
    }
  }

  // ── Отключение ──────────────────────────────────────────────────────────────

  private onClose(ws: WebSocket, state: ConnState): void {
    this.states.delete(ws);
    if (state.agentId) {
      const conn = this.rooms.removeAgentByWs(ws);
      if (conn) this.closeAgentConn(conn, false);
      this.log(`agent disconnected ${state.agentId} (agents=${this.rooms.agentCount()})`);
    }
    if (state.clientConnId !== undefined && state.clientAgentId) {
      const agent = this.rooms.getAgent(state.clientAgentId);
      if (agent && agent.clients.get(state.clientConnId) === ws) {
        this.rooms.releaseClient(agent, state.clientConnId);
        send(agent.ws, { t: 'client-close', connId: state.clientConnId });
      }
    }
    if (state.pairRoomId) {
      const res = this.rooms.removePairByWs(ws);
      if (res?.side === 'agent' && res.room.clientWs) send(res.room.clientWs, { t: 'pair-closed', reason: 'agent-left' });
      if (res?.side === 'client') send(res.room.agentWs, { t: 'pair-peer-left' });
    }
  }

  /** Закрывает всех клиентов агента (агент ушёл/заменён) и, опционально, его сокет. */
  private closeAgentConn(conn: AgentConn, closeAgentWs: boolean): void {
    for (const client of conn.clients.values()) {
      try {
        client.close(1001, 'agent gone');
      } catch {
        /* ignore */
      }
    }
    conn.clients.clear();
    if (closeAgentWs) {
      try {
        conn.ws.close(4001, 'replaced');
      } catch {
        /* ignore */
      }
    }
  }
}

/** Отправляет служебный JSON, если сокет ещё открыт. */
function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/** Удаляет из карты rate-limit записи с истёкшим окном (не даёт Map расти
 *  бесконечно при ротации IP). Критерий истечения — как в rateAllow. */
export function sweepRateWindows(
  rate: Map<string, { count: number; windowStart: number }>,
  now: number,
  windowMs: number,
): void {
  for (const [ip, entry] of rate) if (now - entry.windowStart >= windowMs) rate.delete(ip);
}
