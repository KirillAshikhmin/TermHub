// Непрочитанный звонок хранится до просмотра/ввода, независимо от сброса BEL в tmux.
import { sessionWaiting, sessionWorking } from './session-status';

interface Entry {
  bell: boolean;
  seen: boolean;
  working: boolean;
  // Polling can report the same completion after its live BEL was acknowledged.
  // Consume the title and tmux echoes separately because they may arrive apart.
  pendingTitle: boolean;
  pendingTmux: boolean;
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
  const entry = state.get(name) ?? { bell: false, seen: true, working: false, pendingTitle: false, pendingTmux: false };
  entry.seen = false;
  entry.pendingTitle = entry.working;
  entry.pendingTmux = !entry.bell;
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
      state.set(s.name, { bell: s.bell, seen: !s.bell, working, pendingTitle: s.bell && working, pendingTmux: false });
      continue;
    }
    // A new observed work cycle rearms both fallback sources. Repeated working
    // snapshots can still precede the delayed completion title after a live BEL.
    if (working && !e.working) {
      e.pendingTitle = false;
      e.pendingTmux = false;
    }
    if (s.bell && !e.bell) {
      if (!e.pendingTmux) {
        e.seen = false;
        e.pendingTitle = e.working || working;
      }
      e.pendingTmux = false;
    }
    if (e.working && sessionWaiting(s.title ?? '')) {
      if (!e.pendingTitle) {
        e.seen = false;
        e.pendingTmux = !s.bell;
      }
      e.pendingTitle = false;
    }
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
