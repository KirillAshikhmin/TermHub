// Cookie-аутентификация LAN-интерфейса и лимит попыток входа.
// Cookie termhub=<ts>.<hmac-sha256(ts, cookieSecret) hex>: подпись проверяется
// в постоянном времени, возраст — не старше 30 суток.

import crypto from 'node:crypto';

/** Максимальный возраст cookie: 30 суток. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Окно и лимит неудачных попыток входа с одного IP. */
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_FAILURES = 5;

function hmacHex(ts: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(ts).digest('hex');
}

/** Выдаёт cookie-значение termhub для текущего момента времени. */
export function issueCookie(secret: string): string {
  const ts = String(Date.now());
  return `${ts}.${hmacHex(ts, secret)}`;
}

/** Проверяет cookie: корректная подпись (timingSafe) и возраст ≤ 30 суток. */
export function checkCookie(value: string | undefined, secret: string): boolean {
  if (!value) return false;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) return false;
  const ts = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  if (!/^\d+$/.test(ts)) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Date.now() - tsNum > MAX_AGE_MS) return false;
  const expected = hmacHex(ts, secret);
  const got = Buffer.from(mac, 'hex');
  const exp = Buffer.from(expected, 'hex');
  if (got.length !== exp.length) return false;
  return crypto.timingSafeEqual(got, exp);
}

/** Скользящее окно неудачных попыток входа: 5 в минуту на IP. */
export class LoginRateLimit {
  private readonly failures = new Map<string, number[]>();

  /** true, если у IP меньше лимита неудачных попыток за последнюю минуту. */
  allow(ip: string): boolean {
    return this.recent(ip).length < RATE_MAX_FAILURES;
  }

  /** Фиксирует неудачную попытку входа с IP. */
  fail(ip: string): void {
    const list = this.recent(ip);
    list.push(Date.now());
    this.failures.set(ip, list);
  }

  /** Возвращает список попыток IP в пределах окна; попутно подметает запись
   *  из Map, если окно опустело (иначе Map росла бы вечно по одной записи на
   *  каждый когда-либо виденный IP). */
  private recent(ip: string): number[] {
    const cutoff = Date.now() - RATE_WINDOW_MS;
    const list = (this.failures.get(ip) ?? []).filter((t) => t >= cutoff);
    if (list.length === 0) this.failures.delete(ip);
    else this.failures.set(ip, list);
    return list;
  }
}
