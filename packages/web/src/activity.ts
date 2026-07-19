// Детектор «недавней активности» сессий (liveness) для индикатора-точки на табах
// и карточках. Работает поверх SessionInfo.activityTs (таймстемп tmux
// #{session_activity}): сравнивает его ТОЛЬКО с прошлым значением между поллами,
// поэтому не зависит от рассинхрона часов браузер↔агент. Декей — в «поллах».

/** Сколько поллов точка «горит» после последнего роста activityTs. */
const HOT_POLLS = 1;

interface Entry {
  prev: number; // последний виденный activityTs
  stale: number; // поллов подряд без роста
}

export class ActivityTracker {
  private readonly map = new Map<string, Entry>();

  /** Вызывать на каждый полл списка сессий. */
  observe(sessions: { name: string; activityTs: number }[]): void {
    const seen = new Set<string>();
    for (const s of sessions) {
      seen.add(s.name);
      const e = this.map.get(s.name);
      if (!e) {
        // Первая встреча — baseline, НЕ горячо (stale выше порога).
        this.map.set(s.name, { prev: s.activityTs, stale: HOT_POLLS + 1 });
      } else if (s.activityTs > e.prev) {
        e.prev = s.activityTs;
        e.stale = 0;
      } else {
        e.stale += 1;
      }
    }
    for (const name of [...this.map.keys()]) {
      if (!seen.has(name)) this.map.delete(name);
    }
  }

  /** Есть ли недавняя активность (рисовать точку). */
  isHot(name: string): boolean {
    const e = this.map.get(name);
    return e !== undefined && e.stale <= HOT_POLLS;
  }

  /** Сброс состояния (для тестов). */
  reset(): void {
    this.map.clear();
  }
}

/** Общий на весь SPA: переживает пере-монтирование экранов (hash-роутинг),
 *  поэтому «горячие» сессии не остывают при переходе дашборд ↔ терминал. */
export const activity = new ActivityTracker();
