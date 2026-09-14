// @vitest-environment happy-dom
// Пятая вкладка сессии: маршрут #/sfeed/<сессия> и её появление в Holo-баре ровно
// тогда, когда агент объявил возможность `feed` (старый агент — вкладки нет вовсе).
import { beforeEach, describe, expect, it } from 'vitest';

import { forgetCaps, negotiateCaps } from '../src/capabilities';
import { setLang } from '../src/i18n';
import { sfeedHash } from '../src/routes';
import type { Transport } from '../src/transport';
import { renderHoloBar } from '../src/ui';
import { routeWorkspace } from '../src/workspace';

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

describe('вкладка «Лента»', () => {
  beforeEach(() => {
    setLang('ru');
    forgetCaps();
  });

  it('маршрут #/sfeed/<сессия> ведёт на вкладку ленты рабочего пространства', () => {
    expect(sfeedHash('my sess')).toBe('#/sfeed/my%20sess');
    expect(routeWorkspace({ name: 'sfeed', session: 'work' })).toEqual({ session: 'work', tab: 'feed' });
  });

  it('стоит в баре последней, когда агент объявил возможность feed', async () => {
    const transport = capsTransport(['feed']);
    await negotiateCaps(transport);
    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });
    await settle();
    expect(tabHrefs(bar)).toEqual(['#/term/work', '#/sfiles/work', '#/srepo/work', sfeedHash('work')]);
  });

  it('вкладки нет вовсе, если возможности feed у агента нет', async () => {
    const transport = capsTransport([]);
    await negotiateCaps(transport);
    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });
    await settle();
    expect(tabHrefs(bar)).toEqual(['#/term/work', '#/sfiles/work', '#/srepo/work']);
  });
});
