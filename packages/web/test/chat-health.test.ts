// @vitest-environment happy-dom
// Счётчик сбоев чата и плашка версии живут на устройстве; сбои — по сессиям и видам.
import { beforeEach, describe, expect, it } from 'vitest';

import { healthRows, noteFailure, noteUnknown, resetHealth, versionNoticeDue } from '../src/chat-health';

beforeEach(() => localStorage.clear());

describe('сбои чата', () => {
  it('считает по сессии и виду, помнит агента, версию и время последнего', () => {
    noteUnknown('a', 'claude', '2.1.322');
    noteUnknown('a', 'claude', '2.1.322');
    noteFailure('a', 'mode', 'claude', '2.1.322');
    noteFailure('b', 'model', 'codex');
    const rows = healthRows();
    const a = rows.find((r) => r.session === 'a')!;
    expect(a).toMatchObject({ agent: 'claude', version: '2.1.322', counts: { unknown: 2, mode: 1 } });
    expect(a.last).toBeGreaterThan(0);
    expect(rows.find((r) => r.session === 'b')).toMatchObject({ agent: 'codex', counts: { model: 1 } });
  });

  it('переживает «перезагрузку» (читает из localStorage) и сбрасывается', () => {
    noteUnknown('a', 'claude');
    expect(healthRows()).toHaveLength(1);
    resetHealth();
    expect(healthRows()).toEqual([]);
  });

  it('битое содержимое хранилища не роняет', () => {
    localStorage.setItem('termhub.chatHealth', '{not json');
    expect(healthRows()).toEqual([]);
    noteUnknown('a', 'claude');
    expect(healthRows()).toHaveLength(1);
  });
});

describe('плашка версии', () => {
  it('один раз на версию агента на устройстве', () => {
    expect(versionNoticeDue('claude', '9.9.9')).toBe(true);
    expect(versionNoticeDue('claude', '9.9.9')).toBe(false);
    expect(versionNoticeDue('claude', '9.9.10')).toBe(true);
    expect(versionNoticeDue('codex', '9.9.9')).toBe(true);
  });
});
