import { describe, expect, it } from 'vitest';

import { actionOfUrl, parseAction } from '../src/app-actions';

describe('действия приложения из адреса', () => {
  it('разбирает известные действия', () => {
    expect(parseAction('#/do/new')).toBe('new');
    expect(parseAction('#/do/usage')).toBe('usage');
    expect(parseAction('#/do/settings')).toBe('settings');
  });

  it('незнакомое действие и чужой адрес — не действие', () => {
    expect(parseAction('#/do/reboot')).toBeNull();
    expect(parseAction('#/do/new/extra')).toBeNull();
    expect(parseAction('#/term/do')).toBeNull();
    expect(parseAction('')).toBeNull();
  });

  it('берёт действие из полного адреса запуска', () => {
    expect(actionOfUrl('https://host.example:7710/#/do/usage')).toBe('usage');
    expect(actionOfUrl('https://host.example:7710/')).toBeNull();
    expect(actionOfUrl('not a url')).toBeNull();
  });
});
