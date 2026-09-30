import { describe, it, expect } from 'vitest';
import { findSessionId, isExistingSessionName } from '../src/tmux-session.js';

describe('literal session identity', () => {
  const rows = '$1\tother\n$2\t$1\n$3\tsprut.app\n$4\tsprut.app1\n';
  it('does not interpret IDs, prefixes or patterns in names', () => {
    expect(findSessionId(rows, '$1')).toBe('$2');
    expect(findSessionId(rows, 'sprut.app')).toBe('$3');
    for (const name of ['sprut', '*', '=other', 'missing']) expect(() => findSessionId(rows, name)).toThrow();
  });
  it('rejects controls and accepts long Unicode labels', () => {
    for (const name of ['', 'a\nb', 'a\tb', 'a\0b']) expect(isExistingSessionName(name)).toBe(false);
    expect(isExistingSessionName('проект '.repeat(40))).toBe(true);
  });
});
