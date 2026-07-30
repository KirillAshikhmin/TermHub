// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';

import { readSortMode, sortSessions, writeSortMode, SORT_MODES } from '../src/session-sort';

const s = (name: string, activityTs: number): { name: string; activityTs: number } => ({ name, activityTs });

beforeEach(() => {
  localStorage.clear();
});

describe('session-sort — режим', () => {
  it('по умолчанию — по активности', () => {
    expect(readSortMode()).toBe('activity');
  });

  it('выбор переживает перечитывание', () => {
    writeSortMode('name');
    expect(readSortMode()).toBe('name');
  });

  it('мусор в хранилище → режим по умолчанию', () => {
    localStorage.setItem('termhub.sessionSort', 'nonsense');
    expect(readSortMode()).toBe('activity');
  });

  it('все объявленные режимы сохраняются и читаются', () => {
    for (const mode of SORT_MODES) {
      writeSortMode(mode);
      expect(readSortMode()).toBe(mode);
    }
  });
});

describe('session-sort — порядок', () => {
  const list = [s('beta', 100), s('alpha', 300), s('gamma', 200)];

  it('activity: свежие сверху', () => {
    expect(sortSessions(list, 'activity').map((x) => x.name)).toEqual(['alpha', 'gamma', 'beta']);
  });

  it('name: по алфавиту', () => {
    expect(sortSessions(list, 'name').map((x) => x.name)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('bell: звонящие сверху, внутри группы — по активности', () => {
    const unseen = (n: string): boolean => n === 'beta';
    expect(sortSessions(list, 'bell', unseen).map((x) => x.name)).toEqual(['beta', 'alpha', 'gamma']);
  });

  it('равная активность разрешается именем — порядок не «дрожит» между поллами', () => {
    const same = [s('b', 5), s('a', 5), s('c', 5)];
    expect(sortSessions(same, 'activity').map((x) => x.name)).toEqual(['a', 'b', 'c']);
  });

  it('вход не мутируется (снимок переиспользуется вызывающими)', () => {
    const input = [s('b', 1), s('a', 2)];
    const before = input.map((x) => x.name);
    sortSessions(input, 'name');
    expect(input.map((x) => x.name)).toEqual(before);
  });
});
