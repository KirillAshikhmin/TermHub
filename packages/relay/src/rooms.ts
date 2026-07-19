// Состояние relay в памяти: реестр агентов (agentId → соединение + его клиенты)
// и pair-комнаты (roomId → agentWs/clientWs + TTL-таймер). Ничего на диск.

import type { WebSocket } from 'ws';

/** Максимум одновременных клиентов на одного агента. */
export const MAX_CLIENTS_PER_AGENT = 32;
/** Максимум попыток join в одну pair-комнату. */
export const MAX_PAIR_ATTEMPTS = 3;

/** Зарегистрированный агент: его управляющий сокет и активные клиенты. */
export interface AgentConn {
  agentId: string;
  ws: WebSocket;
  /** connId → сокет клиента. */
  clients: Map<number, WebSocket>;
  /** Монотонный счётчик connId (u32). */
  connCounter: number;
}

/** Pair-комната: связывает сокет-инициатор (agent) и сокет-присоединяющийся (client). */
export interface PairRoom {
  roomId: string;
  agentWs: WebSocket;
  clientWs: WebSocket | null;
  attempts: number;
  timer: ReturnType<typeof setTimeout>;
}

/** Реестр агентов и pair-комнат. Вся логика — над этими двумя картами. */
export class Rooms {
  private readonly agents = new Map<string, AgentConn>();
  private readonly pairs = new Map<string, PairRoom>();

  agentCount(): number {
    return this.agents.size;
  }

  pairCount(): number {
    return this.pairs.size;
  }

  getAgent(agentId: string): AgentConn | undefined {
    return this.agents.get(agentId);
  }

  /** Регистрирует агента; возвращает предыдущее соединение того же agentId (если было) для закрытия. */
  registerAgent(agentId: string, ws: WebSocket): AgentConn | null {
    const previous = this.agents.get(agentId) ?? null;
    this.agents.set(agentId, { agentId, ws, clients: new Map(), connCounter: 0 });
    return previous;
  }

  /** Убирает агента по его сокету; возвращает снятое соединение (для закрытия клиентов). */
  removeAgentByWs(ws: WebSocket): AgentConn | null {
    for (const conn of this.agents.values()) {
      if (conn.ws === ws) {
        this.agents.delete(conn.agentId);
        return conn;
      }
    }
    return null;
  }

  /** Выделяет connId новому клиенту агента; null при превышении лимита. */
  allocClient(conn: AgentConn, clientWs: WebSocket): number | null {
    if (conn.clients.size >= MAX_CLIENTS_PER_AGENT) return null;
    conn.connCounter = (conn.connCounter + 1) >>> 0; // u32-маска: без RangeError на переполнении
    const connId = conn.connCounter;
    conn.clients.set(connId, clientWs);
    return connId;
  }

  releaseClient(conn: AgentConn, connId: number): void {
    conn.clients.delete(connId);
  }

  /** Открывает pair-комнату (одна активная на agentWs); TTL-таймер зовёт onExpire.
   *  null, если roomId уже занят ДРУГИМ сокетом — чужую комнату не трогаем. */
  openPair(roomId: string, agentWs: WebSocket, ttlMs: number, onExpire: (room: PairRoom) => void): PairRoom | null {
    const existing = this.pairs.get(roomId);
    if (existing && existing.agentWs !== agentWs) return null;
    // одна активная комната на agentWs: гасим прежние с clearTimeout (включая эту
    // при повторном open тем же сокетом) — ни один таймер не осиротеет.
    for (const room of this.pairs.values()) if (room.agentWs === agentWs) this.closePair(room.roomId);
    const timer = setTimeout(() => {
      const room = this.pairs.get(roomId);
      if (!room) return;
      this.pairs.delete(roomId);
      onExpire(room);
    }, ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    const room: PairRoom = { roomId, agentWs, clientWs: null, attempts: 0, timer };
    this.pairs.set(roomId, room);
    return room;
  }

  getPair(roomId: string): PairRoom | undefined {
    return this.pairs.get(roomId);
  }

  /** Удаляет комнату и гасит её таймер. */
  closePair(roomId: string): PairRoom | undefined {
    const room = this.pairs.get(roomId);
    if (room) {
      clearTimeout(room.timer);
      this.pairs.delete(roomId);
    }
    return room;
  }

  /** Снимает pair-состояние сокета при его отключении. agent-сторона → комната закрывается,
   *  client-сторона → комната остаётся, но её clientWs сбрасывается. */
  removePairByWs(ws: WebSocket): { room: PairRoom; side: 'agent' | 'client' } | null {
    for (const room of this.pairs.values()) {
      if (room.agentWs === ws) {
        clearTimeout(room.timer);
        this.pairs.delete(room.roomId);
        return { room, side: 'agent' };
      }
      if (room.clientWs === ws) {
        room.clientWs = null;
        return { room, side: 'client' };
      }
    }
    return null;
  }

  /** Гасит все pair-таймеры (при остановке relay). */
  dispose(): void {
    for (const room of this.pairs.values()) clearTimeout(room.timer);
    this.pairs.clear();
    this.agents.clear();
  }
}
