// Стандартный base64 С ПАДДИНГОМ (как Buffer.toString('base64') на агенте/relay) —
// через btoa/atob, доступные и в браузере, и в тестовой среде (happy-dom / Node).
// Используется только remote-модулями (relay/keys/pairing), в LAN-бандл не попадает.

/** Кодирует байты в стандартный base64 с паддингом. */
export function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/** Декодирует стандартный base64 (с паддингом) в байты. */
export function unb64(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
