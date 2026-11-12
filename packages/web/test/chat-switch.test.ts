// @vitest-environment happy-dom
// Переключатель вида «Терминал / Чат» в плашке сессии полосы разделов: он заменяет кнопку
// ленты там, где чат возможен (Claude/Codex + возможность `chat`), и не появляется нигде
// больше — там вкладка остаётся прежней лентой.
import { beforeEach, describe, expect, it } from 'vitest';

import { forgetCaps, negotiateCaps } from '../src/capabilities';
import { setLang } from '../src/i18n';
import type { Transport } from '../src/transport';
import { renderHoloBar } from '../src/ui';
import { sessionViewPref } from '../src/view-pref';

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function transportOf(command: string | null, caps: string[], list?: () => Promise<unknown[]>): Transport {
  return {
    mode: 'lan',
    clientScope: null,
    capabilities: async () => caps,
    gradle: async () => null,
    list: list ?? (async () => (command === null ? [] : [{ name: 'work', command, path: '/p' }])),
  } as unknown as Transport;
}

async function bar(transport: Transport, active: 'term' | 'files' | 'feed' = 'term'): Promise<HTMLElement> {
  await negotiateCaps(transport);
  const el = renderHoloBar({ active, session: 'work', transport, onHide: () => {} });
  document.body.replaceChildren(el);
  await settle();
  return el;
}

const sw = (el: HTMLElement): HTMLElement | null => el.querySelector('.th-viewsw');
const opt = (el: HTMLElement, view: 'term' | 'chat'): HTMLButtonElement =>
  el.querySelector(`.th-viewsw__opt[data-view="${view}"]`)!;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  location.hash = '';
});

describe('переключатель вида', () => {
  it('у Claude с возможностью chat — переключатель «Терминал / Чат» вместо кнопки ленты', async () => {
    const el = await bar(transportOf('claude', ['feed', 'chat']));
    expect(sw(el)).not.toBeNull();
    expect(opt(el, 'term').textContent).toBe('Терминал');
    expect(opt(el, 'chat').textContent).toBe('Чат');
    expect(el.querySelector('.th-holotab__feed')).toBeNull();
    // Вкладок в ряду по-прежнему три: отдельной вкладки «Лента» нет.
    expect(el.querySelectorAll('a.th-holotab').length).toBe(3);
  });

  it('Codex и голая версия Claude тоже опознаются', async () => {
    expect(sw(await bar(transportOf('codex', ['feed', 'chat'])))).not.toBeNull();
    forgetCaps();
    expect(sw(await bar(transportOf('2.1.322', ['feed', 'chat'])))).not.toBeNull();
  });

  it('нет переключателя: opencode, оболочка, агент старше чата, не удалось спросить сессии', async () => {
    for (const t of [
      transportOf('opencode', ['feed', 'chat']),
      transportOf('zsh', ['feed', 'chat']),
      transportOf('claude', ['feed']),
      transportOf('claude', ['feed', 'chat'], () => Promise.reject(new Error('down'))),
    ]) {
      forgetCaps();
      const el = await bar(t);
      expect(sw(el)).toBeNull();
      // вкладка ленты прежняя: кнопка внутри плашки «Терминал»
      expect(el.querySelector('a.th-holotab--term .th-holotab__feed')).not.toBeNull();
    }
  });

  it('подсвечена позиция текущего вида: чат на экране ленты, терминал на терминале, ни одна — на проводнике', async () => {
    const pressed = (el: HTMLElement): string[] =>
      (['term', 'chat'] as const).filter((v) => opt(el, v).getAttribute('aria-pressed') === 'true');
    expect(pressed(await bar(transportOf('claude', ['feed', 'chat']), 'feed'))).toEqual(['chat']);
    forgetCaps();
    expect(pressed(await bar(transportOf('claude', ['feed', 'chat']), 'term'))).toEqual(['term']);
    forgetCaps();
    expect(pressed(await bar(transportOf('claude', ['feed', 'chat']), 'files'))).toEqual([]);
  });

  it('нажатие: выбор запоминается по сессии, адрес меняется, плашка не переключается сама', async () => {
    const el = await bar(transportOf('claude', ['feed', 'chat']), 'term');
    const tab = el.querySelector('a.th-holotab--term') as HTMLElement;
    let tabClicks = 0;
    tab.addEventListener('click', () => (tabClicks += 1));

    const press = new MouseEvent('click', { bubbles: true, cancelable: true });
    opt(el, 'chat').dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    expect(tabClicks).toBe(0);
    expect(location.hash).toBe('#/sfeed/work');
    expect(sessionViewPref('work')).toBe('chat');
    expect(sessionViewPref('other')).toBeNull();

    opt(el, 'term').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(location.hash).toBe('#/term/work');
    expect(sessionViewPref('work')).toBe('term');
  });

  it('плашка мимо переключателя ведёт в текущий вид сессии: умолчание — чат, после выбора «Терминал» — терминал', async () => {
    const el = await bar(transportOf('claude', ['feed', 'chat']), 'files');
    const tab = el.querySelector('a.th-holotab--term') as HTMLAnchorElement;
    expect(tab.getAttribute('href')).toBe('#/sfeed/work'); // умолчание — чат
    opt(el, 'term').click();
    expect(sessionViewPref('work')).toBe('term');
    expect(tab.getAttribute('href')).toBe('#/term/work');
  });
});
