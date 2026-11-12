// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { chatCapable, defaultView, effectiveView, sessionViewPref, setSessionViewPref } from '../src/view-pref';

const CAPS = ['feed', 'chat'];

describe('выбор вида по сессии', () => {
  beforeEach(() => localStorage.clear());

  it('пока выбора нет — null; выбор помнится по сессии и переживает перезагрузку (читается из localStorage)', () => {
    expect(sessionViewPref('a')).toBeNull();
    setSessionViewPref('a', 'term');
    expect(sessionViewPref('a')).toBe('term');
    expect(sessionViewPref('b')).toBeNull();
    // «Перезагрузка»: состояние только в localStorage.
    expect(JSON.parse(localStorage.getItem('termhub.sessionView')!)).toEqual({ a: 'term' });
  });

  it('битое значение в хранилище — как отсутствие, не исключение', () => {
    localStorage.setItem('termhub.sessionView', '{oops');
    expect(sessionViewPref('a')).toBeNull();
    localStorage.setItem('termhub.sessionView', JSON.stringify({ a: 'zzz', b: 'chat' }));
    expect(sessionViewPref('a')).toBeNull();
    expect(sessionViewPref('b')).toBe('chat');
  });

  it('defaultView: чат — только для Claude/Codex при возможности chat; прочее — терминал', () => {
    expect(defaultView({ command: 'claude' }, CAPS)).toBe('chat');
    expect(defaultView({ command: '2.1.322' }, CAPS)).toBe('chat'); // Claude называет процесс версией
    expect(defaultView({ command: 'codex' }, CAPS)).toBe('chat');
    expect(defaultView({ command: 'opencode' }, CAPS)).toBe('term');
    expect(defaultView({ command: 'zsh' }, CAPS)).toBe('term');
    expect(defaultView({ command: 'claude' }, ['feed'])).toBe('term'); // агент старше чата
  });

  it('chatCapable: переключатель нужен ровно там, где чат возможен', () => {
    expect(chatCapable({ command: 'claude' }, CAPS)).toBe(true);
    expect(chatCapable({ command: 'opencode' }, CAPS)).toBe(false);
    expect(chatCapable({ command: 'claude' }, [])).toBe(false);
  });

  it('effectiveView: ручной выбор старше умолчания, но чат без возможности не навязывается', () => {
    expect(effectiveView('a', { command: 'claude' }, CAPS)).toBe('chat');
    setSessionViewPref('a', 'term');
    expect(effectiveView('a', { command: 'claude' }, CAPS)).toBe('term');
    setSessionViewPref('z', 'chat');
    expect(effectiveView('z', { command: 'zsh' }, CAPS)).toBe('term');
    expect(effectiveView('z', { command: 'claude' }, [])).toBe('term');
  });
});
