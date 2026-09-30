// Непрочитанный звонок хранится до просмотра/ввода, независимо от сброса BEL в tmux.
import { sessionWaiting, sessionWorking } from './session-status';

interface Entry {
  bell: boolean;
  seen: boolean;
  working: boolean;
}
const state = new Map<string, Entry>();
const listeners = new Set<() => void>();
const changed = (): void => { for (const listener of listeners) listener(); };

/** Подписка на события терминала и подтверждение просмотра. */
export function onBellChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** BEL из открытого терминального канала — тот же источник, что и звук. */
export function recordBell(name: string): void {
  const entry = state.get(name) ?? { bell: false, seen: true, working: false };
  entry.seen = false;
  state.set(name, entry);
  changed();
}

/** Снимок tmux: ловим BEL и переход работа→ожидание, но не обычный idle при входе. */
export function observeBells(sessions: { name: string; bell: boolean; title?: string }[]): void {
  const names = new Set<string>();
  for (const s of sessions) {
    names.add(s.name);
    const working = sessionWorking(s.title ?? '');
    const e = state.get(s.name);
    if (!e) {
      state.set(s.name, { bell: s.bell, seen: !s.bell, working });
      continue;
    }
    if ((s.bell && !e.bell) || (e.working && sessionWaiting(s.title ?? ''))) e.seen = false;
    e.bell = s.bell;
    e.working = working;
  }
  for (const n of [...state.keys()]) if (!names.has(n)) state.delete(n);
}

/** Пользователь открыл сессию или взаимодействует с терминалом. */
export function markBellSeen(name: string): void {
  const e = state.get(name);
  if (e && !e.seen) {
    e.seen = true;
    changed();
  }
}

export function bellUnseen(name: string): boolean {
  const e = state.get(name);
  return !!e && !e.seen;
}

export function unseenBellCount(): number {
  let n = 0;
  for (const e of state.values()) if (!e.seen) n += 1;
  return n;
}
