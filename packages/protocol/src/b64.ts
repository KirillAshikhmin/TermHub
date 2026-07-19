// Стандартный base64 С ПАДДИНГОМ (Node Buffer) — единый источник для агента и relay.
// Паддинг совпадает с Buffer.toString('base64'), поэтому relay-протокол остаётся
// бинарно совместимым с прежними инлайн-копиями. web/src/b64.ts — отдельная
// (btoa/atob) реализация браузерного бандла, её сюда не сводим.

/** Кодирует байты в стандартный base64 с паддингом. */
export function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Декодирует стандартный base64 (с паддингом) в байты. */
export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
