// @vitest-environment happy-dom
// Лента — не вкладка в ряду, а кнопка внутри вкладки «Терминал». Маршрут
// #/sfeed/<сессия> при этом работает как раньше, а кнопка есть ровно тогда, когда
// агент объявил возможность `feed` (у старого агента её нет вовсе).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps, negotiateCaps } from '../src/capabilities';
import { setLang } from '../src/i18n';
import { sfeedHash } from '../src/routes';
import { mountTerminal } from '../src/term';
import type { Transport } from '../src/transport';
import { renderHoloBar } from '../src/ui';
import { routeWorkspace } from '../src/workspace';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

/** Транспорт, объявляющий заданный список возможностей; Gradle-проектом не является. */
function capsTransport(caps: string[]): Transport {
  return {
    mode: 'lan',
    clientScope: null,
    capabilities: async () => caps,
    gradle: async () => null,
  } as unknown as Transport;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function tabHrefs(bar: HTMLElement): string[] {
  return [...bar.querySelectorAll('a.th-holotab')].map((a) => a.getAttribute('href') ?? '');
}

/** Кнопка ленты внутри плашки вкладки «Терминал». */
const feedBtn = (host: HTMLElement): HTMLButtonElement | null =>
  host.querySelector('a.th-holotab--term .th-holotab__feed');

/** Терминал с заданным набором возможностей агента. */
function termWithCaps(caps: string[]): Transport {
  const { transport } = termTransport();
  const patch = transport as unknown as { capabilities: () => Promise<string[]>; gradle: () => Promise<null> };
  patch.capabilities = async () => caps;
  patch.gradle = async () => null;
  return transport;
}

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  FakeTerminal.instances.length = 0;
  stubResizeObserver();
  location.hash = '';
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('маршрут ленты', () => {
  it('#/sfeed/<сессия> по-прежнему открывает ленту напрямую', () => {
    expect(sfeedHash('my sess')).toBe('#/sfeed/my%20sess');
    expect(routeWorkspace({ name: 'sfeed', session: 'work' })).toEqual({ session: 'work', tab: 'feed' });
  });
});

describe('ряд вкладок', () => {
  it('ленты в нём нет, даже когда агент её умеет: вкладок четыре, а не пять', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);

    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });
    await settle();

    expect(tabHrefs(bar)).toEqual(['#/term/work', '#/sfiles/work', '#/srepo/work']);
  });

  it('из ленты видно дорогу назад: вкладка «Терминал» на месте и ведёт в терминал', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);

    const bar = renderHoloBar({ active: 'feed', session: 'work', transport, onHide: () => {} });
    await settle();

    expect(tabHrefs(bar)[0]).toBe('#/term/work');
  });
});

describe('кнопка ленты внутри плашки «Терминал»', () => {
  it('сидит в самой плашке, справа от подписи, — а не рядом с ней в ряду', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);

    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });
    await settle();

    const tab = bar.querySelector('a.th-holotab--term') as HTMLElement;
    const btn = feedBtn(bar);
    expect(btn).not.toBeNull();
    // Подпись первой, кнопка за ней: «слева надпись, справа кнопка».
    expect(tab.firstElementChild?.className).toBe('th-holotab__label');
    expect(tab.lastElementChild).toBe(btn);
    expect(btn!.title).toBe('Лента');
  });

  it('нажатие на кнопку открывает ленту и НЕ переключает вкладку', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);
    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });
    await settle();
    const tab = bar.querySelector('a.th-holotab--term') as HTMLElement;
    let tabClicks = 0;
    tab.addEventListener('click', () => {
      tabClicks += 1;
    });

    const press = new MouseEvent('click', { bubbles: true, cancelable: true });
    feedBtn(bar)!.dispatchEvent(press);

    // Кнопка живёт внутри ссылки на терминал: промахнуться мимо ленты нельзя —
    // ни всплытия к плашке, ни перехода по её ссылке.
    expect(tabClicks).toBe(0);
    expect(press.defaultPrevented).toBe(true);
    expect(location.hash).toBe(sfeedHash('work'));
  });

  it('нажатие по плашке мимо кнопки ведёт в терминал', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);
    const bar = renderHoloBar({ active: 'feed', session: 'work', transport, onHide: () => {} });
    await settle();
    const tab = bar.querySelector('a.th-holotab--term') as HTMLAnchorElement;

    const press = new MouseEvent('click', { bubbles: true, cancelable: true });
    tab.dispatchEvent(press);

    expect(press.defaultPrevented).toBe(false);
    expect(tab.getAttribute('href')).toBe('#/term/work');
  });

  it('её нет вовсе, если возможности feed у агента нет', async () => {
    const transport = termWithCaps([]);
    const handle = mountTerminal(root, 'work', transport);
    await settle();

    expect(feedBtn(root)).toBeNull();
    handle.teardown();
  });

  it('в смонтированном терминале она на месте, когда агент ленту умеет', async () => {
    const transport = termWithCaps(['feed']);
    const handle = mountTerminal(root, 'work', transport);
    await settle();

    expect(feedBtn(root)).not.toBeNull();
    handle.teardown();
  });
});
