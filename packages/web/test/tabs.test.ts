// @vitest-environment happy-dom
import type { SessionInfo } from '@termhub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { mountSessionTabs, pickNeighbor, renderSessionTab, updateSessionTab } from '../src/tabs';
import { activity } from '../src/activity';
import type { Transport } from '../src/transport';

function sessionFixture(name: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return { name, path: `/p/${name}`, command: 'zsh', activityTs: 0, attached: 0, bell: false, title: '', ...overrides };
}

/** Транспорт-заглушка: list() отдаёт очередной снимок, последний — навсегда. */
function stubTransport(snapshots: SessionInfo[][]): { transport: Transport; listCalls: () => number } {
  let calls = 0;
  let last: SessionInfo[] = [];
  const transport = {
    mode: 'lan',
    list: async () => {
      calls += 1;
      if (snapshots.length > 0) last = snapshots.shift()!;
      return last;
    },
    create: async () => {},
    kill: async () => {},
    rename: async () => {},
    dirs: async () => [],
    openTerm: () => ({ write() {}, resize() {}, close() {} }),
    close() {},
  } as unknown as Transport;
  return { transport, listCalls: () => calls };
}

const noop = (): void => {};

describe('renderSessionTab / updateSessionTab', () => {
  beforeEach(() => setLang('ru'));

  it('рендерит имя, подсветку активного и aria-current', () => {
    const tab = renderSessionTab({ name: 'work', bell: false, title: '' }, true, t, noop, noop);
    expect(tab.textContent).toContain('work');
    expect(tab.classList.contains('is-active')).toBe(true);
    expect(tab.querySelector('.th-tab__btn')!.getAttribute('aria-current')).toBe('true');
  });

  it('звонок виден только на неактивном табе', () => {
    const inactive = renderSessionTab({ name: 'a', bell: true, title: '' }, false, t, noop, noop);
    expect(inactive.querySelector('.th-tab__bell')).not.toBeNull();
    const active = renderSessionTab({ name: 'a', bell: true, title: '' }, true, t, noop, noop);
    expect(active.querySelector('.th-tab__bell')).toBeNull();
  });

  it('клик по имени вызывает onSwitch с именем', () => {
    const onSwitch = vi.fn();
    const tab = renderSessionTab({ name: 'work', bell: false, title: '' }, false, t, onSwitch, noop);
    tab.querySelector<HTMLButtonElement>('.th-tab__btn')!.click();
    expect(onSwitch).toHaveBeenCalledWith('work');
  });

  it('крестик вызывает onKill (и не вызывает onSwitch)', () => {
    const onSwitch = vi.fn();
    const onKill = vi.fn();
    const tab = renderSessionTab({ name: 'work', bell: false, title: '' }, false, t, onSwitch, onKill);
    tab.querySelector<HTMLButtonElement>('.th-tab__close')!.click();
    expect(onKill).toHaveBeenCalledWith('work');
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('updateSessionTab меняет узел на месте (звонок появляется и исчезает)', () => {
    const tab = renderSessionTab({ name: 'a', bell: false, title: '' }, false, t, noop, noop);
    updateSessionTab(tab, { name: 'a', bell: true, title: '' }, false, t);
    expect(tab.querySelector('.th-tab__bell')).not.toBeNull();
    updateSessionTab(tab, { name: 'a', bell: false, title: '' }, false, t);
    expect(tab.querySelector('.th-tab__bell')).toBeNull();
  });

  it('точка активности рисуется перед именем при showActivity (в т.ч. на активном табе)', () => {
    const tab = renderSessionTab({ name: 'a', bell: false, title: '' }, true, t, noop, noop, true);
    const btn = tab.querySelector<HTMLElement>('.th-tab__btn')!;
    expect(btn.querySelector('.th-tab__activity')).not.toBeNull();
    // точка — первый ребёнок кнопки (перед именем)
    expect(btn.firstElementChild!.classList.contains('th-tab__activity')).toBe(true);
  });

  it('без showActivity точки нет', () => {
    const tab = renderSessionTab({ name: 'a', bell: false, title: '' }, false, t, noop, noop, false);
    expect(tab.querySelector('.th-tab__activity')).toBeNull();
  });

  it('updateSessionTab включает и выключает точку на месте', () => {
    const tab = renderSessionTab({ name: 'a', bell: false, title: '' }, false, t, noop, noop, false);
    updateSessionTab(tab, { name: 'a', bell: false, title: '' }, false, t, true);
    expect(tab.querySelector('.th-tab__activity')).not.toBeNull();
    updateSessionTab(tab, { name: 'a', bell: false, title: '' }, false, t, false);
    expect(tab.querySelector('.th-tab__activity')).toBeNull();
  });

  it('таб: заголовок терминала крупно + tmux-имя второй строкой (индикатор срезан)', () => {
    const tab = renderSessionTab({ name: 'main', bell: false, title: '⠋ Рефакторинг' }, true, t, noop, noop);
    expect(tab.querySelector('.th-tab__name')?.textContent).toBe('Рефакторинг');
    expect(tab.querySelector('.th-tab__sub')?.textContent).toBe('main');
  });

  it('таб: без заголовка (или он совпал с именем) — только tmux-имя, без второй строки', () => {
    const tab = renderSessionTab({ name: 'main', bell: false, title: '' }, false, t, noop, noop);
    expect(tab.querySelector('.th-tab__name')?.textContent).toBe('main');
    expect(tab.querySelector('.th-tab__sub')).toBeNull();
  });

  it('updateSessionTab обновляет заголовок и вторую строку на месте', () => {
    const tab = renderSessionTab({ name: 'main', bell: false, title: '' }, false, t, noop, noop);
    updateSessionTab(tab, { name: 'main', bell: false, title: '⠋ Сборка' }, false, t);
    expect(tab.querySelector('.th-tab__name')?.textContent).toBe('Сборка');
    expect(tab.querySelector('.th-tab__sub')?.textContent).toBe('main');
    updateSessionTab(tab, { name: 'main', bell: false, title: '' }, false, t);
    expect(tab.querySelector('.th-tab__name')?.textContent).toBe('main');
    expect(tab.querySelector('.th-tab__sub')).toBeNull();
  });
});

describe('mountSessionTabs', () => {
  beforeEach(() => {
    setLang('ru');
    vi.useFakeTimers();
    activity.reset();
  });
  afterEach(() => vi.useRealTimers());

  const baseOpts = { current: 'a', onSwitch: noop, onKill: noop, onCreate: noop };

  it('точка активности загорается на табе после роста activityTs', async () => {
    const { transport } = stubTransport([
      [sessionFixture('a', { activityTs: 100 }), sessionFixture('b', { activityTs: 100 })], // baseline
      [sessionFixture('a', { activityTs: 100 }), sessionFixture('b', { activityTs: 500 })], // b вырос
    ]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'a' });
    await vi.advanceTimersByTimeAsync(0); // первый refresh — baseline, точек нет
    const bTab1 = [...tabs.el.querySelectorAll('.th-tab')].find(
      (el) => el.querySelector('.th-tab__name')?.textContent === 'b',
    )!;
    expect(bTab1.querySelector('.th-tab__activity')).toBeNull();
    await vi.advanceTimersByTimeAsync(3000); // второй refresh — b вырос → горячо
    const bTab2 = [...tabs.el.querySelectorAll('.th-tab')].find(
      (el) => el.querySelector('.th-tab__name')?.textContent === 'b',
    )!;
    expect(bTab2.querySelector('.th-tab__activity')).not.toBeNull();
    tabs.teardown();
  });

  it('точка активности по брайлевому заголовку; ✳ — без точки', async () => {
    const { transport } = stubTransport([
      [sessionFixture('a', { title: '⠂ Работаю' }), sessionFixture('b', { title: '✳ Жду' })],
    ]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    const dot = (name: string) =>
      [...tabs.el.querySelectorAll('.th-tab')]
        .find(
          (el) =>
            el.querySelector('.th-tab__name')?.textContent === name ||
            el.querySelector('.th-tab__sub')?.textContent === name,
        )!
        .querySelector('.th-tab__activity');
    expect(dot('a')).not.toBeNull(); // ⠂ → работает → точка
    expect(dot('b')).toBeNull(); // ✳ → ждёт (managed, не работает) → без точки
    tabs.teardown();
  });

  it('сразу показывает таб текущей сессии, после полла — весь список по порядку', async () => {
    const { transport } = stubTransport([[sessionFixture('a'), sessionFixture('b')]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'b' });
    expect(tabs.el.textContent).toContain('b'); // до полла — только текущая
    await vi.advanceTimersByTimeAsync(0); // флаш первого refresh
    const names = [...tabs.el.querySelectorAll('.th-tab__name')].map((n) => n.textContent);
    expect(names).toEqual(['a', 'b']);
    tabs.teardown();
  });

  it('таб текущей сессии не исчезает, даже когда её нет в списке', async () => {
    const { transport } = stubTransport([[sessionFixture('a')]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'gone' });
    await vi.advanceTimersByTimeAsync(0);
    const names = [...tabs.el.querySelectorAll('.th-tab__name')].map((n) => n.textContent);
    expect(names).toEqual(['a', 'gone']);
    tabs.teardown();
  });

  it('исчезнувшая чужая сессия удаляется из полосы', async () => {
    const { transport } = stubTransport([
      [sessionFixture('a'), sessionFixture('b')],
      [sessionFixture('b')],
    ]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000); // второй полл
    const names = [...tabs.el.querySelectorAll('.th-tab__name')].map((n) => n.textContent);
    expect(names).toEqual(['b']);
    tabs.teardown();
  });

  it('teardown останавливает поллинг', async () => {
    const { transport, listCalls } = stubTransport([[sessionFixture('a')]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport });
    await vi.advanceTimersByTimeAsync(0);
    const before = listCalls();
    tabs.teardown();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(listCalls()).toBe(before);
  });

  it('refresh() перечитывает список немедленно (для kill-флоу)', async () => {
    const { transport, listCalls } = stubTransport([[sessionFixture('a')]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport });
    await vi.advanceTimersByTimeAsync(0);
    const before = listCalls();
    await tabs.refresh();
    expect(listCalls()).toBe(before + 1);
    tabs.teardown();
  });

  it('стрелка разворачивает панель; «Создать сессию» в панели вызывает onCreate', async () => {
    const onCreate = vi.fn();
    const { transport } = stubTransport([[]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, onCreate });
    const expand = tabs.el.querySelector<HTMLButtonElement>('.th-tabs-expand')!;
    const panel = tabs.el.querySelector<HTMLElement>('.th-spanel')!;
    expand.click();
    expect(panel.classList.contains('is-open')).toBe(true);
    expect(expand.classList.contains('is-open')).toBe(true); // стрелка повёрнута
    tabs.el.querySelector<HTMLButtonElement>('.th-spanel__create')!.click();
    expect(onCreate).toHaveBeenCalled();
    expect(panel.classList.contains('is-open')).toBe(false); // создание закрывает панель
    tabs.teardown();
  });

  it('клик по строке панели вызывает onSwitch и закрывает панель', async () => {
    const onSwitch = vi.fn();
    const { transport } = stubTransport([[sessionFixture('a'), sessionFixture('b')]]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'a', onSwitch });
    await vi.advanceTimersByTimeAsync(0); // дать поллингу наполнить список
    const expand = tabs.el.querySelector<HTMLButtonElement>('.th-tabs-expand')!;
    expand.click();
    const rows = tabs.el.querySelectorAll<HTMLElement>('.th-spanel__list .th-card');
    const bRow = [...rows].find((r) => r.textContent?.includes('b'))!;
    bRow.click();
    expect(onSwitch).toHaveBeenCalledWith('b');
    expect(tabs.el.querySelector('.th-spanel')!.classList.contains('is-open')).toBe(false);
    tabs.teardown();
  });

  // Панель и дашборд должны показывать ОДНО И ТО ЖЕ: карточку со всеми полями, а не
  // упрощённую строку. Проверяем по признакам карточки дашборда.
  it('панель рисует карточки дашборда: каталог, команда, звонок', async () => {
    const { transport } = stubTransport([
      [sessionFixture('a'), sessionFixture('b', { command: 'claude', bell: true })],
    ]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    tabs.el.querySelector<HTMLButtonElement>('.th-tabs-expand')!.click();

    const cards = [...tabs.el.querySelectorAll<HTMLElement>('.th-spanel__list .th-card')];
    const bCard = cards.find((c) => c.textContent?.includes('b'))!;
    expect(bCard.querySelector('.th-card__dir')!.textContent).toContain('b');
    expect(bCard.querySelector('.th-badge')!.textContent).toBe('claude');
    expect(bCard.querySelector('.th-bell')).not.toBeNull();
    tabs.teardown();
  });

  it('панель и полоса идут в выбранном порядке (по имени)', async () => {
    localStorage.setItem('termhub.sessionSort', 'name');
    const { transport } = stubTransport([
      [sessionFixture('gamma', { activityTs: 300 }), sessionFixture('alpha', { activityTs: 100 })],
    ]);
    const tabs = mountSessionTabs({ ...baseOpts, transport, current: 'alpha' });
    await vi.advanceTimersByTimeAsync(0);
    tabs.el.querySelector<HTMLButtonElement>('.th-tabs-expand')!.click();

    const names = [...tabs.el.querySelectorAll<HTMLElement>('.th-spanel__list .th-card__name-text')].map(
      (n) => n.textContent,
    );
    expect(names).toEqual(['alpha', 'gamma']); // по активности было бы gamma первой
    tabs.teardown();
    localStorage.clear();
  });
});

describe('pickNeighbor', () => {
  it('сосед слева при закрытии среднего или последнего таба', () => {
    expect(pickNeighbor(['a', 'b', 'c'], 'b')).toBe('a');
    expect(pickNeighbor(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('при закрытии самого левого — новый первый (сосед справа)', () => {
    expect(pickNeighbor(['a', 'b', 'c'], 'a')).toBe('b');
  });

  it('единственная (или пустой список) → null (уходим на дашборд)', () => {
    expect(pickNeighbor(['a'], 'a')).toBeNull();
    expect(pickNeighbor([], 'a')).toBeNull();
  });

  it('имя не в списке → первый оставшийся', () => {
    expect(pickNeighbor(['a', 'b'], 'gone')).toBe('a');
  });
});
