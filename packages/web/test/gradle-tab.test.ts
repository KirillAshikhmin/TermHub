// @vitest-environment happy-dom
import type { GradleProject, GradleRunState } from '@termhub/protocol/frames';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountGradleTab } from '../src/gradle';
import { setLang, t } from '../src/i18n';
import { sgradleHash } from '../src/routes';
import { renderHoloBar } from '../src/ui';
import type { TermChannelOpts, Transport } from '../src/transport';
import { routeWorkspace } from '../src/workspace';

const PROJECT: GradleProject = { dir: '/p/app', wrapper: true, markers: ['gradlew'] };

/** Транспорт-заглушка: считает вызовы gradle('detect') и отдаёт заданный ответ. */
function stubTransport(answer: GradleProject | null, scope?: { write: boolean; files: boolean }): {
  transport: Transport;
  detectCalls: () => number;
} {
  let calls = 0;
  const transport = {
    mode: 'lan',
    clientScope: scope ?? null,
    gradle: async (action: string) => {
      if (action === 'detect') calls += 1;
      return answer;
    },
  } as unknown as Transport;
  return { transport, detectCalls: () => calls };
}

/** Ждёт микрозадачи, в которых резолвится промис детекта. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function tabHrefs(bar: HTMLElement): string[] {
  return [...bar.querySelectorAll('a.th-holotab')].map((a) => (a as HTMLAnchorElement).getAttribute('href') ?? '');
}

describe('renderHoloBar: четвёртый таб Gradle', () => {
  beforeEach(() => setLang('ru'));

  it('рисует три таба сразу и вставляет Gradle только после ответа детекта', async () => {
    const { transport } = stubTransport(PROJECT);
    const bar = renderHoloBar({ active: 'term', session: 'work', transport, onHide: () => {} });

    expect(tabHrefs(bar)).toEqual(['#/term/work', '#/sfiles/work', '#/srepo/work']);

    await settle();
    expect(tabHrefs(bar)).toEqual(['#/term/work', '#/sfiles/work', '#/srepo/work', sgradleHash('work')]);
    // Таб встаёт перед кнопкой «⋮», а не после неё.
    expect(bar.lastElementChild?.className).toContain('th-holobar__hide');
  });

  it('не рисует таб, если сессия — не Gradle-проект', async () => {
    const { transport } = stubTransport(null);
    const bar = renderHoloBar({ active: 'term', session: 'plain', transport, onHide: () => {} });
    await settle();
    expect(tabHrefs(bar)).toEqual(['#/term/plain', '#/sfiles/plain', '#/srepo/plain']);
  });

  it('кэширует ответ детекта на сессию — переключение вкладок не дёргает агента заново', async () => {
    const { transport, detectCalls } = stubTransport(PROJECT);
    renderHoloBar({ active: 'term', session: 'cached', transport, onHide: () => {} });
    await settle();
    renderHoloBar({ active: 'files', session: 'cached', transport, onHide: () => {} });
    const bar = renderHoloBar({ active: 'repo', session: 'cached', transport, onHide: () => {} });
    await settle();

    expect(detectCalls()).toBe(1);
    expect(tabHrefs(bar)).toContain(sgradleHash('cached'));
  });

  it('подсвечивает Gradle как активный таб', async () => {
    const { transport } = stubTransport(PROJECT);
    const bar = renderHoloBar({ active: 'gradle', session: 'act', transport, onHide: () => {} });
    await settle();
    const tab = bar.querySelector<HTMLAnchorElement>(`a[href="${sgradleHash('act')}"]`);
    expect(tab?.classList.contains('is-active')).toBe(true);
    expect(tab?.getAttribute('aria-selected')).toBe('true');
  });

  it('гостю без права на файлы таба не показывает и детект не спрашивает', async () => {
    const { transport, detectCalls } = stubTransport(PROJECT, { write: true, files: false });
    const bar = renderHoloBar({ active: 'term', session: 'guest', transport, onHide: () => {} });
    await settle();
    expect(tabHrefs(bar)).toEqual(['#/term/guest']);
    expect(detectCalls()).toBe(0);
  });
});

describe('роут вкладки Gradle', () => {
  it('#/sgradle/<session> — session-scoped роут рабочего пространства', () => {
    expect(sgradleHash('my sess')).toBe('#/sgradle/my%20sess');
    expect(routeWorkspace({ name: 'sgradle', session: 'work' })).toEqual({ session: 'work', tab: 'gradle' });
  });
});

// ── Вкладка целиком: xterm подменён, чтобы проверять поведение, а не рендер ──
const xterm = vi.hoisted(() => ({
  instances: [] as { written: string[]; disposed: boolean }[],
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    element = document.createElement('div');
    buffer = { active: { type: 'normal' as const } };
    written: string[] = [];
    disposed = false;
    constructor() {
      xterm.instances.push(this);
    }
    loadAddon(): void {}
    open(): void {}
    write(data: Uint8Array | string): void {
      this.written.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    }
    clear(): void {}
    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    dispose(): void {
      this.disposed = true;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    activate(): void {}
    dispose(): void {}
  },
}));

interface OpenedTerm {
  session: string;
  opts: TermChannelOpts;
  closed: boolean;
}

/** Транспорт вкладки: скриптованные ответы gradle + журнал openTerm. */
function tabTransport(opts: {
  detect?: GradleProject | null | 'error';
  status?: GradleRunState;
  run?: GradleRunState;
  stop?: GradleRunState;
  scope?: { write: boolean; files: boolean } | null;
}): {
  transport: Transport;
  calls: { action: string; params: Record<string, unknown> }[];
  opened: OpenedTerm[];
} {
  const calls: { action: string; params: Record<string, unknown> }[] = [];
  const opened: OpenedTerm[] = [];
  const transport = {
    mode: 'lan',
    clientScope: opts.scope ?? null,
    list: async () => [],
    gradle: async (action: string, params: Record<string, unknown>) => {
      calls.push({ action, params });
      if (action === 'detect') {
        if (opts.detect === 'error') throw new Error('relay down');
        return opts.detect ?? null;
      }
      if (action === 'status') return opts.status ?? IDLE;
      if (action === 'run') return opts.run ?? IDLE;
      if (action === 'stop') return opts.stop ?? IDLE;
      return null;
    },
    openTerm: (session: string, channelOpts: TermChannelOpts) => {
      const entry: OpenedTerm = { session, opts: channelOpts, closed: false };
      opened.push(entry);
      return { write: () => {}, resize: () => {}, close: () => (entry.closed = true) };
    },
    close: () => {},
  } as unknown as Transport;
  return { transport, calls, opened };
}

const IDLE: GradleRunState = { phase: 'idle', session: null, command: null, startedAt: null };
const RUNNING: GradleRunState = {
  phase: 'running',
  session: '_gradle_work_a1b2c3',
  command: './gradlew :app:assembleDebug',
  startedAt: 1000,
};

/** Прогоняет очередь микро/макрозадач (детект → статус → attach). */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function statusText(root: HTMLElement): string {
  return root.querySelector('.th-gradle__status')?.textContent ?? '';
}

describe('mountGradleTab: окно вывода сборки', () => {
  let root: HTMLElement;

  beforeEach(() => {
    setLang('ru');
    xterm.instances.length = 0;
    localStorage.clear();
    location.hash = '#/';
    root = document.createElement('div');
    document.body.append(root);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  });

  it('при монтировании спрашивает status и подключается к живой сборочной сессии', async () => {
    const { transport, calls, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    expect(calls.map((c) => c.action)).toEqual(['detect', 'status']);
    expect(opened.map((o) => o.session)).toEqual([RUNNING.session]);
    expect(statusText(root)).toContain('./gradlew :app:assembleDebug');
    tab.teardown();
  });

  it('после run переподключает openTerm — сборочная сессия пересоздана под тем же именем', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING, run: { ...RUNNING, startedAt: 2000 } });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    expect(opened).toHaveLength(1);

    await tab.run({ tasks: [':app:assembleDebug'] });
    await flush();

    expect(opened).toHaveLength(2);
    expect(opened[0]!.closed).toBe(true);
    expect(opened[1]!.session).toBe(RUNNING.session);
    tab.teardown();
  });

  it('итог сборки читает из строки [termhub] gradle exit=N в выводе', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    opened[0]!.opts.onData(new TextEncoder().encode('BUILD FAILED\n[termhub] gradle exit=1\n'));
    expect(statusText(root)).toBe('Ошибка (1)');
    tab.teardown();
  });

  it('не теряет строку exit, когда attach присылает целый экран одним куском', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    const screen = `BUILD SUCCESSFUL\n[termhub] gradle exit=0\n${'user@mac ~/project %  '.repeat(200)}`;
    opened[0]!.opts.onData(new TextEncoder().encode(screen));
    expect(statusText(root)).toBe('Готово (0)');
    tab.teardown();
  });

  it('показывает состояние канала: переподключение и закрытие', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    const conn = (): string => root.querySelector('.th-gradle__conn')?.textContent ?? '';

    opened[0]!.opts.onStatus('reconnecting');
    expect(conn()).toBe(t('term.reconnecting'));
    opened[0]!.opts.onStatus('connected');
    expect(conn()).toBe('');
    tab.teardown();
  });

  it('«Стоп» шлёт stop; гостю без права записи кнопки нет', async () => {
    const { transport, calls } = tabTransport({ detect: PROJECT, status: RUNNING, stop: { ...RUNNING, phase: 'finished' } });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    root.querySelector<HTMLButtonElement>('.th-gradle__stop')!.click();
    await flush();
    expect(calls.map((c) => c.action)).toContain('stop');
    tab.teardown();

    const guest = tabTransport({ detect: PROJECT, status: RUNNING, scope: { write: false, files: true } });
    const guestRoot = document.createElement('div');
    document.body.append(guestRoot);
    const guestTab = mountGradleTab(guestRoot, guest.transport, 'work');
    await flush();
    expect(guestRoot.querySelector('.th-gradle__stop')).toBeNull();
    guestTab.teardown();
  });

  it('раскладка: доля списка из localStorage, перетаскивание и разворот сохраняются', async () => {
    localStorage.setItem('termhub.gradleSplit', '30');
    const { transport } = tabTransport({ detect: PROJECT, status: IDLE });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    const main = root.querySelector<HTMLElement>('main.th-gradle')!;
    const list = root.querySelector<HTMLElement>('.th-gradle__list')!;
    expect(list.style.flexBasis).toBe('30%');

    main.getBoundingClientRect = () => ({ top: 0, height: 400 }) as DOMRect;
    const splitter = root.querySelector<HTMLElement>('.th-gradle__splitter')!;
    splitter.dispatchEvent(Object.assign(new Event('pointerdown'), { pointerId: 1, clientY: 120 }));
    splitter.dispatchEvent(Object.assign(new Event('pointermove'), { pointerId: 1, clientY: 280 }));
    splitter.dispatchEvent(Object.assign(new Event('pointerup'), { pointerId: 1, clientY: 280 }));
    expect(list.style.flexBasis).toBe('70%');
    expect(localStorage.getItem('termhub.gradleSplit')).toBe('70');

    root.querySelector<HTMLButtonElement>('.th-gradle__outhead .th-iconbtn')!.click();
    expect(main.classList.contains('is-expanded')).toBe(true);
    expect(localStorage.getItem('termhub.gradleExpanded')).toBe('1');
    tab.teardown();
  });

  it('teardown закрывает канал, гасит xterm и чистит корень', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    tab.teardown();

    expect(opened[0]!.closed).toBe(true);
    expect(xterm.instances[0]!.disposed).toBe(true);
    expect(root.childNodes.length).toBe(0);
  });

  it('не-Gradle сессия уводит на терминал, а сбой детекта — оставляет вкладку с повтором', async () => {
    const plain = tabTransport({ detect: null, status: IDLE });
    const plainTab = mountGradleTab(root, plain.transport, 'plain');
    await flush();
    expect(location.hash).toBe('#/term/plain');
    plainTab.teardown();

    location.hash = '#/sgradle/work';
    const broken = tabTransport({ detect: 'error', status: IDLE });
    const brokenRoot = document.createElement('div');
    document.body.append(brokenRoot);
    const brokenTab = mountGradleTab(brokenRoot, broken.transport, 'work');
    await flush();
    expect(location.hash).toBe('#/sgradle/work');
    expect(brokenRoot.querySelector('.th-loaderror')).not.toBeNull();
    brokenTab.teardown();
  });
});
