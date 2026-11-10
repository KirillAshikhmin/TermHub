// Каким сокетом браузер ходит на relay: настоящим WebSocket или «сокетом поверх коротких
// запросов» (protocol/pollsock.ts). Второй нужен в сетях, где фильтр душит каждое
// соединение после пары десятков пакетов и WebSocket живёт считаные секунды. Подсказку
// даёт сам relay (`/api/mode`, поле `transport`), её перебивает выбор на устройстве —
// `localStorage['termhub.relayTransport']` = 'ws' | 'poll'.

import { PollSocket } from '@termhub/protocol/pollsock';

export type RelayTransportMode = 'ws' | 'poll';

const KEY = 'termhub.relayTransport';
let hint: RelayTransportMode = 'ws';

/** Запоминает подсказку relay; чужое значение читается как 'ws'. */
export function setRelayTransportHint(value: unknown): void {
  hint = value === 'poll' ? 'poll' : 'ws';
}

export function relayTransportMode(): RelayTransportMode {
  try {
    const own = localStorage.getItem(KEY);
    if (own === 'ws' || own === 'poll') return own;
  } catch {
    /* хранилище недоступно — остаётся подсказка relay */
  }
  return hint;
}

/** Открывает соединение с relay. PollSocket повторяет ту часть WebSocket, которой
 *  пользуются транспорт и пейринг, включая числа readyState. */
export function openRelaySocket(url: string): WebSocket {
  if (relayTransportMode() === 'poll') return new PollSocket(url) as unknown as WebSocket;
  return new WebSocket(url);
}
