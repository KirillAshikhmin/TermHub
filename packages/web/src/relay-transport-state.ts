// Каким способом открыто текущее соединение с relay — для страницы диагностики.
// Отдельный модуль без импортов: диагностика живёт в основном бандле, а сами сокеты
// (relay-socket.ts) — в ленивом чанке remote-режима.

export type RelayTransportInUse = 'ws' | 'poll' | 'rtc';

let inUse: RelayTransportInUse | null = null;

/** Способ последнего открытого соединения; null — в этой вкладке relay не открывали (LAN). */
export function relayTransportInUse(): RelayTransportInUse | null {
  return inUse;
}

export function setRelayTransportInUse(value: RelayTransportInUse | null): void {
  inUse = value;
}
