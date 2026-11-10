// «Сокет поверх WebRTC DataChannel» — третий способ дойти до relay из браузера. Фильтр,
// который душит поток после пары десятков пакетов, решает по первому пакету клиента, а
// WebRTC начинает соединение со STUN — и такой UDP-поток проходит целиком. В отличие от
// коротких запросов (pollsock.ts) это настоящий долгий поток: задержка — один круг, а не
// рукопожатие на каждое нажатие.
//
// Сигнализация — один короткий запрос: POST base/rtc {sdp: offer} → {sdp: answer}.
// Кандидатов в предложении нет намеренно: relay работает как ICE-lite с известным адресом,
// клиент сам приходит на него проверками, и ждать сбора кандидатов незачем.
// По каналу идёт тот же байтовый поток сообщений, что у коротких запросов
// ([вид][длина][тело]), порезанный на куски: сообщение DataChannel ограничено по размеру,
// а кадры relay бывают по 16 МБ.

import {
  PollDecoder,
  POLL_BINARY,
  POLL_CLOSE,
  POLL_TEXT,
  decodePollClose,
  encodePollClose,
  encodePollMessage,
  pollBase,
} from './pollsock.js';

/** Кусок потока в одном сообщении канала: с запасом ниже предела любого браузера. */
export const RTC_CHUNK = 16 * 1024;
/** Сколько держим в буфере канала: больше — ждём, пока уйдёт. */
const RTC_HIGH_WATER = 1024 * 1024;
const RTC_LOW_WATER = 256 * 1024;
/** Канал не открылся за это время — способ здесь не работает (UDP закрыт, relay без него). */
const RTC_OPEN_TIMEOUT_MS = 7_000;

/** Та часть RTCPeerConnection, которой пользуется сокет: её же реализует werift в Node. */
export interface RtcPeerLike {
  createDataChannel(label: string, options?: { ordered?: boolean }): RtcChannelLike;
  createOffer(): Promise<{ type?: string; sdp?: string }>;
  setLocalDescription(description: { type: 'offer'; sdp: string }): Promise<unknown>;
  setRemoteDescription(description: { type: 'answer'; sdp: string }): Promise<unknown>;
  close(): unknown;
}

export interface RtcChannelLike {
  binaryType?: string;
  bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  readyState: string;
  onopen?: ((ev: never) => void) | null;
  onclose?: ((ev: never) => void) | null;
  onerror?: ((ev: never) => void) | null;
  onmessage?: ((ev: { data: unknown }) => void) | null;
  onbufferedamountlow?: ((ev: never) => void) | null;
  send(data: never): void;
  close(): void;
}

export interface RtcSocketOpts {
  fetch?: typeof fetch;
  /** Создаёт соединение; по умолчанию — браузерный RTCPeerConnection без STUN-серверов. */
  peer?: () => RtcPeerLike;
  maxMessage?: number;
  /** Канал не открылся вовсе: вызывающий может запомнить это и выбрать другой способ. */
  onUnavailable?: () => void;
}

type Listener<T> = ((ev: T) => void) | null;

/** Убирает из SDP строки кандидатов: адреса клиента relay не нужны (и не разглашаются). */
export function stripCandidates(sdp: string): string {
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates')
    .join('\r\n');
}

export class RtcSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = RtcSocket.CONNECTING;
  binaryType = 'arraybuffer';
  onopen: Listener<unknown> = null;
  onmessage: Listener<{ data: string | ArrayBuffer }> = null;
  onclose: Listener<{ code: number; reason: string }> = null;
  onerror: Listener<unknown> = null;

  private readonly base: string;
  private readonly opts: RtcSocketOpts;
  private readonly decoder: PollDecoder;
  private pc?: RtcPeerLike;
  private channel?: RtcChannelLike;
  private queue: Uint8Array[] = [];
  private queued = 0;
  private opened = false;
  private openTimer?: ReturnType<typeof setTimeout>;

  constructor(url: string, opts: RtcSocketOpts = {}) {
    this.base = pollBase(url);
    this.opts = opts;
    this.decoder = new PollDecoder(opts.maxMessage ?? 16 * 1024 * 1024);
    void this.open();
  }

  get bufferedAmount(): number {
    return this.queued + (this.channel?.bufferedAmount ?? 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== RtcSocket.OPEN) return;
    const frame =
      typeof data === 'string'
        ? encodePollMessage(POLL_TEXT, new TextEncoder().encode(data))
        : encodePollMessage(POLL_BINARY, toBytes(data));
    this.enqueue(frame);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === RtcSocket.CLOSED) return;
    if (this.readyState === RtcSocket.OPEN) {
      this.enqueue(encodePollClose(code, reason));
      this.readyState = RtcSocket.CLOSING;
      setTimeout(() => this.finish(code, reason), 300);
      return;
    }
    this.finish(code, reason);
  }

  private async open(): Promise<void> {
    this.openTimer = setTimeout(() => this.fail(), RTC_OPEN_TIMEOUT_MS);
    try {
      const pc = this.opts.peer
        ? this.opts.peer()
        : (new RTCPeerConnection({ iceServers: [] }) as unknown as RtcPeerLike);
      this.pc = pc;
      const channel = pc.createDataChannel('relay', { ordered: true });
      this.channel = channel;
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = RTC_LOW_WATER;
      channel.onopen = () => this.onChannelOpen();
      channel.onclose = () => this.finish(1006, '');
      channel.onerror = () => this.fail();
      channel.onmessage = (ev) => this.onChunk(ev.data);
      channel.onbufferedamountlow = () => this.pump();
      const offer = await pc.createOffer();
      if (!offer.sdp) throw new Error('no offer');
      await pc.setLocalDescription({ type: 'offer', sdp: offer.sdp });
      const doFetch = this.opts.fetch ?? ((input, init) => fetch(input, init));
      const res = await doFetch(`${this.base}/rtc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: stripCandidates(offer.sdp) }),
      });
      if (!res.ok) throw new Error(`rtc ${res.status}`);
      const answer = (await res.json()) as { sdp?: unknown };
      if (typeof answer.sdp !== 'string') throw new Error('no answer');
      if (this.readyState !== RtcSocket.CONNECTING) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
    } catch {
      this.fail();
    }
  }

  private onChannelOpen(): void {
    if (this.readyState !== RtcSocket.CONNECTING) return;
    clearTimeout(this.openTimer);
    this.opened = true;
    this.readyState = RtcSocket.OPEN;
    this.onopen?.({});
  }

  private onChunk(data: unknown): void {
    if (this.readyState === RtcSocket.CLOSED) return;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    let messages: Array<{ kind: number; body: Uint8Array }>;
    try {
      messages = this.decoder.push(bytes.slice());
    } catch {
      this.fail();
      return;
    }
    for (const m of messages) {
      if (this.readyState === RtcSocket.CLOSED) return;
      if (m.kind === POLL_TEXT) this.onmessage?.({ data: new TextDecoder().decode(m.body) });
      else if (m.kind === POLL_BINARY) this.onmessage?.({ data: copyBuffer(m.body) });
      else if (m.kind === POLL_CLOSE) {
        const { code, reason } = decodePollClose(m.body);
        this.finish(code, reason);
        return;
      }
    }
  }

  private enqueue(frame: Uint8Array): void {
    for (let at = 0; at < frame.length; at += RTC_CHUNK) this.queue.push(frame.subarray(at, at + RTC_CHUNK));
    this.queued += frame.length;
    this.pump();
  }

  /** Отдаёт очередь каналу, не раздувая его буфер: браузер рвёт канал, если переполнить. */
  private pump(): void {
    const channel = this.channel;
    if (!channel || channel.readyState !== 'open') return;
    while (this.queue.length > 0 && channel.bufferedAmount < RTC_HIGH_WATER) {
      const part = this.queue.shift() as Uint8Array;
      this.queued -= part.length;
      try {
        channel.send(part as never);
      } catch {
        this.fail();
        return;
      }
    }
  }

  private fail(): void {
    if (this.readyState === RtcSocket.CLOSED) return;
    this.onerror?.({});
    this.finish(1006, '');
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === RtcSocket.CLOSED) return;
    this.readyState = RtcSocket.CLOSED;
    clearTimeout(this.openTimer);
    this.queue = [];
    this.queued = 0;
    try {
      this.channel?.close();
    } catch {
      /* уже закрыт */
    }
    try {
      void this.pc?.close();
    } catch {
      /* уже закрыт */
    }
    if (!this.opened) this.opts.onUnavailable?.();
    this.onclose?.({ code, reason });
  }
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}
