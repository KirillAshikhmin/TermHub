// Каким сокетом браузер ходит на relay. Обычный путь — WebSocket. Для сетей, где фильтр
// душит каждое соединение после пары десятков пакетов, есть два других:
//   'rtc'  — WebRTC DataChannel (protocol/rtcsock.ts): настоящий долгий поток, быстрый,
//            но нужен UDP до relay; не открылся — на время откатываемся на 'poll';
//   'poll' — короткие HTTP-запросы (protocol/pollsock.ts): медленнее, зато идёт везде,
//            где открывается сама страница.
// Подсказку даёт relay (`/api/mode`, поле `transport`), её перебивает выбор на устройстве —
// `localStorage['termhub.relayTransport']` = 'ws' | 'poll' | 'rtc'.

import { PollSocket } from '@termhub/protocol/pollsock';
import { RtcSocket } from '@termhub/protocol/rtcsock';
import { setRelayTransportInUse } from './relay-transport-state';

export type RelayTransportMode = 'ws' | 'poll' | 'rtc';

const KEY = 'termhub.relayTransport';
/** Сколько не пробуем WebRTC после неудачи: каждая попытка — секунды ожидания. */
const RTC_RETRY_MS = 10 * 60 * 1000;
/** То же, если WebRTC в этой сети уже работал: неудача тогда скорее случайна (сеть ещё
 *  не поднялась после сна), и надолго уходить на медленный способ незачем. */
const RTC_RETRY_KNOWN_MS = 20 * 1000;

let hint: RelayTransportMode = 'ws';
let rtcFailedAt: number | null = null;
let rtcWorked = false;

function isMode(value: unknown): value is RelayTransportMode {
  return value === 'ws' || value === 'poll' || value === 'rtc';
}

/** Запоминает подсказку relay; чужое значение читается как 'ws'. */
export function setRelayTransportHint(value: unknown): void {
  hint = isMode(value) ? value : 'ws';
}

/** Выбранный способ — без учёта отката (его видно в effectiveRelayTransport). */
export function relayTransportMode(): RelayTransportMode {
  try {
    const own = localStorage.getItem(KEY);
    if (isMode(own)) return own;
  } catch {
    /* хранилище недоступно — остаётся подсказка relay */
  }
  return hint;
}

/** Способ, которым соединение откроется прямо сейчас. */
export function effectiveRelayTransport(now = Date.now()): RelayTransportMode {
  const mode = relayTransportMode();
  if (mode !== 'rtc') return mode;
  if (typeof RTCPeerConnection === 'undefined') return 'poll';
  if (rtcFailedAt !== null && now - rtcFailedAt < (rtcWorked ? RTC_RETRY_KNOWN_MS : RTC_RETRY_MS)) return 'poll';
  return 'rtc';
}

/** Для тестов: забыть неудачу WebRTC. */
export function resetRelayTransportState(): void {
  rtcFailedAt = null;
  rtcWorked = false;
}

/** Для тестов: исход попытки WebRTC, как его сообщает сокет. */
export function noteRtcOutcome(ok: boolean, now = Date.now()): void {
  if (ok) {
    rtcWorked = true;
    rtcFailedAt = null;
  } else {
    rtcFailedAt = now;
  }
}

/** Открывает соединение с relay. PollSocket и RtcSocket повторяют ту часть WebSocket,
 *  которой пользуются транспорт и пейринг, включая числа readyState. */
export function openRelaySocket(url: string): WebSocket {
  const mode = effectiveRelayTransport();
  setRelayTransportInUse(mode);
  if (mode === 'poll') return new PollSocket(url) as unknown as WebSocket;
  if (mode === 'rtc') {
    return new RtcSocket(url, {
      onUnavailable: () => noteRtcOutcome(false),
      onAvailable: () => noteRtcOutcome(true),
    }) as unknown as WebSocket;
  }
  return new WebSocket(url);
}
