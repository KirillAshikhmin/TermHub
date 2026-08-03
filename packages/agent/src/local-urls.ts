// Адреса, по которым агент доступен НАПРЯМУЮ, минуя relay.
//
// Зачем: клиент, открытый с облачного relay, не может сам найти агента в локальной
// сети — браузеру недоступны ни mDNS, ни перебор портов. Поэтому список адресов
// сообщает сам агент по уже установленному E2E-каналу, а клиент их запоминает и
// предлагает в списке серверов.
//
// Отдаём только приватные адреса: публичный IP интерфейса в этом списке был бы
// приглашением постучаться на агента из интернета, чего конфигурация не подразумевает.

import os from 'node:os';

/** RFC1918 + link-local + CGNAT (100.64/10, туда попадает Tailscale). */
function isPrivateV4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p as [number, number, number, number];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/**
 * URL'ы вида `https://10.0.0.5:7710` по локальным интерфейсам хоста.
 * Схема зависит от того, поднят ли TLS: клиент открывает адрес переходом верхнего
 * уровня, и подставить не ту схему значило бы вести его в заведомо битую ссылку.
 */
export function localUrls(opts: { port: number; tls: boolean }): string[] {
  const out: string[] = [];
  const scheme = opts.tls ? 'https' : 'http';
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4') continue;
      if (!isPrivateV4(a.address)) continue;
      out.push(`${scheme}://${a.address}:${opts.port}`);
    }
  }
  return [...new Set(out)].sort();
}
