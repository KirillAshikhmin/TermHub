// Веб-push от агента: хранит подписки в push.json (0600), рассылает уведомление
// о звонке терминала всем подпискам и вычищает мёртвые (404/410). Троттлинг —
// не чаще одного пуша в 30 с на сессию, чтобы серия колокольчиков не спамила.

import fs from 'node:fs';
import webpush from 'web-push';
import type { PushSubscription } from 'web-push';
import type { TermhubConfig } from './config.js';
import { pushPath, writeSecretFile } from './paths.js';

/** Не чаще одного пуша в 30 с на одну сессию. */
const THROTTLE_MS = 30_000;

/** Запись push.json: сама подписка браузера + время добавления. */
interface PushEntry {
  subscription: PushSubscription;
  addedAt: number;
}

/** Веб-push от агента (VAPID). */
export class PushService {
  private readonly publicKey: string;
  private readonly lastSent = new Map<string, number>();

  constructor(cfg: TermhubConfig) {
    this.publicKey = cfg.vapid.publicKey;
    webpush.setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  }

  vapidPublicKey(): string {
    return this.publicKey;
  }

  /** Сохраняет подписку (дедуп по endpoint). Минимальная валидация формы. */
  async subscribe(sub: unknown): Promise<void> {
    const subscription = this.validate(sub);
    const list = this.load();
    if (list.some((e) => e.subscription.endpoint === subscription.endpoint)) return;
    list.push({ subscription, addedAt: Date.now() });
    this.save(list);
  }

  /** Рассылает всем подпискам уведомление о звонке сессии (с троттлингом). */
  async notifyBell(session: string, task = ''): Promise<void> {
    const now = Date.now();
    if (now - (this.lastSent.get(session) ?? 0) < THROTTLE_MS) return;
    this.lastSent.set(session, now);

    const list = this.load();
    if (list.length === 0) return;
    const payload = JSON.stringify({ session, task });
    const dead: string[] = [];
    await Promise.all(
      list.map(async (entry) => {
        try {
          await webpush.sendNotification(entry.subscription, payload);
        } catch (err) {
          // 404/410 — подписка мертва (устройство отписалось); прочее (сеть/5xx) не трогаем.
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) dead.push(entry.subscription.endpoint);
        }
      }),
    );
    // Перечитываем перед записью, чтобы не затереть подписки, добавленные во время рассылки.
    if (dead.length > 0) this.save(this.load().filter((e) => !dead.includes(e.subscription.endpoint)));
  }

  private validate(sub: unknown): PushSubscription {
    if (typeof sub !== 'object' || sub === null) throw new Error('Некорректная подписка push: не объект');
    const s = sub as { endpoint?: unknown; keys?: unknown };
    if (typeof s.endpoint !== 'string' || s.endpoint.length === 0)
      throw new Error('Некорректная подписка push: нет endpoint');
    if (typeof s.keys !== 'object' || s.keys === null) throw new Error('Некорректная подписка push: нет keys');
    return sub as PushSubscription;
  }

  private load(): PushEntry[] {
    const file = pushPath();
    if (!fs.existsSync(file)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      return Array.isArray(data) ? (data as PushEntry[]) : [];
    } catch {
      return [];
    }
  }

  private save(list: PushEntry[]): void {
    writeSecretFile(pushPath(), JSON.stringify(list, null, 2));
  }
}
