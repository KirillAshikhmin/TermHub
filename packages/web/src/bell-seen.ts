// Гашение 🔔 при просмотре: звонок сессии (BEL или ✳-ожидание) показываем, пока
// пользователь не открыл эту сессию. Новый эпизод звонка (bell false→true) снова
// «непрочитан». Общий на весь SPA — переживает навигацию между экранами.

interface Entry {
  bell: boolean;
  seen: boolean;
}

const state = new Map<string, Entry>();

/** Обновить по свежему списку сессий (вызывать на каждый полл). */
export function observeBells(sessions: { name: string; bell: boolean }[]): void {
  const names = new Set<string>();
  for (const s of sessions) {
    names.add(s.name);
    const e = state.get(s.name);
    if (!e) {
      // Первая встреча: если уже звонит — показываем (непрочитано).
      state.set(s.name, { bell: s.bell, seen: false });
      continue;
    }
    if (s.bell && !e.bell) e.seen = false; // новый эпизод звонка → непрочитан
    e.bell = s.bell;
  }
  for (const n of [...state.keys()]) if (!names.has(n)) state.delete(n);
}

/** Пользователь открыл/смотрит сессию — её звонок прочитан. */
export function markBellSeen(name: string): void {
  const e = state.get(name);
  if (e) e.seen = true;
}

/** Показывать ли 🔔: есть звонок и он ещё не прочитан. */
export function bellUnseen(name: string): boolean {
  const e = state.get(name);
  return !!e && e.bell && !e.seen;
}
