import { describe, expect, it } from 'vitest';
import { bellUnseen, markBellSeen, observeBells } from '../src/bell-seen';

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
});
