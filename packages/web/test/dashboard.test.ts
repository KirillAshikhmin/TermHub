// @vitest-environment happy-dom
import type { SessionInfo } from '@termhub/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderSessionCard, updateSessionCard } from '../src/dashboard';
import { setLang, t } from '../src/i18n';

const NOW = 1_700_000_000_000;

function fixture(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    name: 'work',
    path: '/Users/me/projects/cool-app',
    command: 'zsh',
    activityTs: NOW - 5 * 60_000,
    attached: 0,
    bell: false,
    title: '',
    ...overrides,
  };
}

describe('renderSessionCard', () => {
  beforeEach(() => setLang('ru'));

  it('содержит имя, basename каталога и относительное время', () => {
    const card = renderSessionCard(fixture(), t, { now: NOW });
    const text = card.textContent ?? '';
    expect(text).toContain('work');
    expect(text).toContain('cool-app');
    expect(text).not.toContain('/Users/me/projects');
    expect(text).toContain('5 мин назад');
  });

  it('бейдж команды claude получает акцентный класс', () => {
    const claude = renderSessionCard(fixture({ command: 'claude' }), t, { now: NOW });
    const badge = claude.querySelector('.th-badge');
    expect(badge?.textContent).toContain('claude');
    expect(badge?.classList.contains('th-badge--claude')).toBe(true);

    const zsh = renderSessionCard(fixture({ command: 'zsh' }), t, { now: NOW });
    expect(zsh.querySelector('.th-badge')?.classList.contains('th-badge--claude')).toBe(false);
  });

  it('значок звонка показывается только при bell', () => {
    expect(renderSessionCard(fixture({ bell: true }), t, { now: NOW }).querySelector('.th-bell')).not.toBeNull();
    expect(renderSessionCard(fixture({ bell: false }), t, { now: NOW }).querySelector('.th-bell')).toBeNull();
  });

  it('точка активности рисуется перед именем при showActivity', () => {
    const card = renderSessionCard(fixture(), t, { now: NOW, showActivity: true });
    const name = card.querySelector<HTMLElement>('.th-card__name')!;
    expect(name.querySelector('.th-card__activity')).not.toBeNull();
    // точка — первый ребёнок имени (перед текстом)
    expect(name.firstElementChild!.classList.contains('th-card__activity')).toBe(true);
  });

  it('без showActivity точки нет', () => {
    expect(renderSessionCard(fixture(), t, { now: NOW }).querySelector('.th-card__activity')).toBeNull();
  });

  it('счётчик подключений показывается только при attached > 0', () => {
    expect(renderSessionCard(fixture({ attached: 2 }), t, { now: NOW }).querySelector('.th-attached')).not.toBeNull();
    expect(renderSessionCard(fixture({ attached: 0 }), t, { now: NOW }).querySelector('.th-attached')).toBeNull();
  });

  it('клик по карточке вызывает onOpen', () => {
    let opened = '';
    const card = renderSessionCard(fixture(), t, { now: NOW, onOpen: () => (opened = 'work') });
    card.click();
    expect(opened).toBe('work');
  });
});

describe('updateSessionCard', () => {
  beforeEach(() => setLang('ru'));

  it('обновляет команду, время, attached и bell на месте (тот же узел)', () => {
    const card = renderSessionCard(fixture({ command: 'zsh', attached: 0, bell: false }), t, { now: NOW });
    const badgeBefore = card.querySelector('.th-badge');
    expect(card.querySelector('.th-attached')).toBeNull();
    expect(card.querySelector('.th-bell')).toBeNull();

    updateSessionCard(
      card,
      fixture({ command: 'claude', attached: 2, bell: true, activityTs: NOW - 2 * 60 * 60_000 }),
      t,
      NOW,
    );

    // Тот же самый узел бейджа — карточка не пересоздана.
    expect(card.querySelector('.th-badge')).toBe(badgeBefore);
    expect(badgeBefore?.textContent).toBe('claude');
    expect(badgeBefore?.classList.contains('th-badge--claude')).toBe(true);
    expect(card.querySelector('.th-card__time')?.textContent).toBe('2 ч назад');
    expect(card.querySelector('.th-attached')?.textContent).toBe('2');
    expect(card.querySelector('.th-bell')).not.toBeNull();
  });

  it('снимает attached и bell при сбросе флагов', () => {
    const card = renderSessionCard(fixture({ command: 'claude', attached: 3, bell: true }), t, { now: NOW });
    expect(card.querySelector('.th-attached')).not.toBeNull();
    expect(card.querySelector('.th-bell')).not.toBeNull();

    updateSessionCard(card, fixture({ command: 'zsh', attached: 0, bell: false }), t, NOW);

    expect(card.querySelector('.th-attached')).toBeNull();
    expect(card.querySelector('.th-bell')).toBeNull();
    const badge = card.querySelector('.th-badge');
    expect(badge?.textContent).toBe('zsh');
    expect(badge?.classList.contains('th-badge--claude')).toBe(false);
  });

  it('включает и выключает точку активности на месте', () => {
    const card = renderSessionCard(fixture(), t, { now: NOW });
    updateSessionCard(card, fixture(), t, NOW, true);
    expect(card.querySelector('.th-card__activity')).not.toBeNull();
    updateSessionCard(card, fixture(), t, NOW, false);
    expect(card.querySelector('.th-card__activity')).toBeNull();
  });
});
