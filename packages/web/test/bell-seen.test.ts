import { describe, expect, it, vi } from 'vitest';
import { bellUnseen, markBellSeen, observeBells, recordBell, unseenBellCount } from '../src/bell-seen';

describe('bell-seen', () => {
  it('звонок непрочитан, пока не открыли; markBellSeen гасит', () => {
    observeBells([{ name: 'a', bell: true }]);
    expect(bellUnseen('a')).toBe(true);
    markBellSeen('a');
    expect(bellUnseen('a')).toBe(false);
  });

  it('новый эпизод звонка (false→true) снова непрочитан', () => {
    observeBells([{ name: 'b', bell: true }]);
    markBellSeen('b');
    expect(bellUnseen('b')).toBe(false);
    observeBells([{ name: 'b', bell: false }]); // отзвонил
    observeBells([{ name: 'b', bell: true }]); // зазвонил снова
    expect(bellUnseen('b')).toBe(true);
  });

  it('нет звонка → не показываем; исчезнувшие/неизвестные — false', () => {
    observeBells([{ name: 'c', bell: false }]);
    expect(bellUnseen('c')).toBe(false);
    observeBells([]); // c пропала
    expect(bellUnseen('c')).toBe(false);
    expect(bellUnseen('nope')).toBe(false);
  });

  // Число для бейджа на иконке приложения: держится, пока звонок не просмотрен.
  it('unseenBellCount считает только непрочитанные звонки', () => {
    observeBells([
      { name: 'a', bell: true },
      { name: 'b', bell: true },
      { name: 'c', bell: false },
    ]);
    expect(unseenBellCount()).toBe(2);
    markBellSeen('a');
    expect(unseenBellCount()).toBe(1);
    // Пропавшая сессия выбывает из счёта.
    observeBells([{ name: 'b', bell: true }]);
    expect(unseenBellCount()).toBe(1);
    markBellSeen('b');
    expect(unseenBellCount()).toBe(0);
  });
});

describe('persistent bell events', () => {
  it('keeps a short tmux bell until acknowledged', () => {
    observeBells([{ name: 'pulse', bell: true }]);
    observeBells([{ name: 'pulse', bell: false }]);
    expect(bellUnseen('pulse')).toBe(true);
    markBellSeen('pulse');
    expect(bellUnseen('pulse')).toBe(false);
  });

  it('marks working to waiting even when tmux has already cleared BEL', () => {
    observeBells([{ name: 'task', bell: false, title: '⠋ Build' }]);
    observeBells([{ name: 'task', bell: false, title: '✳ Build' }]);
    expect(bellUnseen('task')).toBe(true);
    markBellSeen('task');
    observeBells([{ name: 'task', bell: false, title: '✳ Build' }]);
    expect(bellUnseen('task')).toBe(false);
  });

  it('does not ring for an idle session first seen at startup', () => {
    observeBells([{ name: 'idle', bell: false, title: '✳ Idle' }]);
    expect(bellUnseen('idle')).toBe(false);
  });
});

describe('completion signal reconciliation', () => {
  it('keeps an acknowledged terminal BEL read when the waiting title arrives later', () => {
    observeBells([{ name: 'late-title', bell: false, title: '⠋ Build' }]);
    recordBell('late-title');
    markBellSeen('late-title');
    observeBells([{ name: 'late-title', bell: false, title: '⠙ Build' }]);
    observeBells([{ name: 'late-title', bell: false, title: '✳ Build' }]);
    expect(bellUnseen('late-title')).toBe(false);

    observeBells([{ name: 'late-title', bell: false, title: '⠋ Build' }]);
    observeBells([{ name: 'late-title', bell: false, title: '✳ Build' }]);
    expect(bellUnseen('late-title')).toBe(true);
  });

  it.each(['title-first', 'flag-first'])('consumes delayed title and flag independently (%s)', (order) => {
    observeBells([{ name: order, bell: false, title: '⠋ Build' }]);
    recordBell(order);
    markBellSeen(order);
    if (order === 'title-first') {
      observeBells([{ name: order, bell: false, title: '✳ Build' }]);
    } else {
      observeBells([{ name: order, bell: true, title: '⠋ Build' }]);
    }
    expect(bellUnseen(order)).toBe(false);
    observeBells([{ name: order, bell: true, title: '✳ Build' }]);
    expect(bellUnseen(order)).toBe(false);
    observeBells([{ name: order, bell: false, title: '✳ Build' }]);
    observeBells([{ name: order, bell: true, title: '✳ Build' }]);
    expect(bellUnseen(order)).toBe(true);
  });

  it('keeps a title-only completion read when its tmux flag arrives later', () => {
    observeBells([{ name: 'title-only', bell: false, title: '⠋ Build' }]);
    observeBells([{ name: 'title-only', bell: false, title: '✳ Build' }]);
    markBellSeen('title-only');
    observeBells([{ name: 'title-only', bell: true, title: '✳ Build' }]);
    expect(bellUnseen('title-only')).toBe(false);
  });

  it('keeps an acknowledged tmux flag read when its completion title arrives later', () => {
    observeBells([{ name: 'flag-only', bell: false, title: '⠋ Build' }]);
    observeBells([{ name: 'flag-only', bell: true, title: '⠋ Build' }]);
    markBellSeen('flag-only');
    observeBells([{ name: 'flag-only', bell: false, title: '✳ Build' }]);
    expect(bellUnseen('flag-only')).toBe(false);
  });

  it('still records a subsequent terminal BEL without requiring a polling transition', () => {
    observeBells([{ name: 'live', bell: false, title: '⠋ Build' }]);
    recordBell('live');
    markBellSeen('live');
    recordBell('live');
    expect(bellUnseen('live')).toBe(true);
  });

  // Флаг звонка tmux гаснет только у окна, которое показал клиент tmux; чат им не бывает.
  it('просмотренный звонок помнится после перезагрузки страницы, пока флаг tmux стоит', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    try {
      observeBells([{ name: 'p', bell: true }]);
      markBellSeen('p');
      const kept = store.get('termhub.bellAck')!;
      expect(JSON.parse(kept)).toEqual(['p']);
      observeBells([]); // страница перезагружена: память модуля пуста…
      store.set('termhub.bellAck', kept); // …а отметка просмотра осталась
      observeBells([{ name: 'p', bell: true }]);
      expect(bellUnseen('p')).toBe(false);
      // Флаг погас и встал снова — это новый звонок.
      observeBells([{ name: 'p', bell: false }]);
      observeBells([{ name: 'p', bell: true }]);
      expect(bellUnseen('p')).toBe(true);
      expect(JSON.parse(store.get('termhub.bellAck')!)).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
