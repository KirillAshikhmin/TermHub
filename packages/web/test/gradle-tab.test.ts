// @vitest-environment happy-dom
import type { GradleProject, GradleRunConfig, GradleRunState, GradleTasks } from '@termhub/protocol/frames';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountGradleTab } from '../src/gradle';
import { setLang, t } from '../src/i18n';
import { sgradleHash } from '../src/routes';
import { detectGradle, knownGradle, renderHoloBar } from '../src/ui';
import type { TermChannelOpts, Transport } from '../src/transport';
import { mountWorkspace, routeWorkspace } from '../src/workspace';

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

  it('кэш детекта не вечен: папка, ставшая Gradle-проектом, получает таб без перезагрузки', async () => {
    let answer: GradleProject | null = null;
    const transport = {
      mode: 'lan',
      clientScope: null,
      gradle: async () => answer,
    } as unknown as Transport;
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const first = renderHoloBar({ active: 'term', session: 'fresh', transport, onHide: () => {} });
      await settle();
      expect(tabHrefs(first)).toEqual(['#/term/fresh', '#/sfiles/fresh', '#/srepo/fresh']);

      // `gradle init` в этой папке прямо при живой странице.
      answer = PROJECT;
      const cached = renderHoloBar({ active: 'term', session: 'fresh', transport, onHide: () => {} });
      await settle();
      expect(tabHrefs(cached)).toHaveLength(3);

      clock.mockReturnValue(base + 60 * 60 * 1000);
      const later = renderHoloBar({ active: 'term', session: 'fresh', transport, onHide: () => {} });
      await settle();
      expect(tabHrefs(later)).toContain(sgradleHash('fresh'));
    } finally {
      clock.mockRestore();
    }
  });

  it('опоздавший ответ просроченного детекта не перебивает свежий', async () => {
    let calls = 0;
    let answerFirst!: (project: GradleProject | null) => void;
    const transport = {
      mode: 'lan',
      clientScope: null,
      gradle: () => {
        calls += 1;
        if (calls === 1) return new Promise<GradleProject | null>((resolve) => (answerFirst = resolve));
        return Promise.resolve(null);
      },
    } as unknown as Transport;
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      void detectGradle(transport, 'slow');
      // Срок первого ответа вышел, пока он был в полёте: второй рендер бара
      // спрашивает заново и узнаёт, что папка — не Gradle-проект.
      clock.mockReturnValue(base + 60 * 60 * 1000);
      await detectGradle(transport, 'slow');
      expect(knownGradle(transport, 'slow')).toBeNull();

      answerFirst(PROJECT);
      await settle();
      expect(knownGradle(transport, 'slow')).toBeNull();
    } finally {
      clock.mockRestore();
    }
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
  tasks?: GradleTasks | 'error';
  tasksGate?: Promise<unknown>;
  configs?: GradleRunConfig[];
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
      if (action === 'tasks') {
        if (opts.tasksGate) await opts.tasksGate;
        if (opts.tasks === 'error') throw new Error('FAILURE: build file broken');
        return opts.tasks ?? EMPTY_TASKS;
      }
      if (action === 'configs') return opts.configs ?? [];
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
const EMPTY_TASKS: GradleTasks = { tasks: [], groupOrder: [], fetchedAt: 0 };
const TASKS_ANSWER: GradleTasks = {
  fetchedAt: 5,
  groupOrder: ['Build tasks', 'Other tasks'],
  tasks: [
    { name: 'build', project: ':', group: 'Build tasks', description: 'Builds everything' },
    { name: ':app:assembleDebug', project: ':app', group: 'Build tasks', description: 'Assembles the debug build' },
  ],
};
const CONFIGS: GradleRunConfig[] = [
  {
    name: 'app debug',
    tasks: [':app:clean', ':app:assembleDebug'],
    args: '--offline',
    dir: '/p/app/app',
    source: '.run',
  },
];
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

    expect(calls.map((c) => c.action)).toEqual(['detect', 'tasks', 'configs', 'status']);
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

  it('не теряет строку exit в кадре, который длиннее окна поиска', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    // Итог в начале всплеска, за ним — больше 64 КБ прокрутки: искать надо в том,
    // что пришло, а не в окне фиксированной длины, куда итог уже не влезает.
    const burst = `[termhub] gradle exit=0\n${'scrollback line\n'.repeat(6000)}`;
    opened[0]!.opts.onData(new TextEncoder().encode(burst));
    expect(statusText(root)).toBe('Готово (0)');
    tab.teardown();
  });

  it('опознаёт строку exit, разрезанную между двумя кадрами', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    opened[0]!.opts.onData(new TextEncoder().encode('BUILD SUCCESSFUL\n[termhub] gra'));
    expect(statusText(root)).toContain('./gradlew :app:assembleDebug');
    opened[0]!.opts.onData(new TextEncoder().encode('dle exit=0\n'));
    expect(statusText(root)).toBe('Готово (0)');
    tab.teardown();
  });

  it('ждёт перевод строки: код, разрезанный между кадрами, не читается наполовину', async () => {
    const { transport, opened } = tabTransport({ detect: PROJECT, status: RUNNING });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    opened[0]!.opts.onData(new TextEncoder().encode('[termhub] gradle exit=1'));
    expect(statusText(root)).toContain('./gradlew :app:assembleDebug');
    opened[0]!.opts.onData(new TextEncoder().encode('2\n'));
    expect(statusText(root)).toBe('Ошибка (12)');
    tab.teardown();
  });

  it('две вкладки читают каждая свой итог: состояние разбора не общее', async () => {
    const a = tabTransport({ detect: PROJECT, status: RUNNING });
    const tabA = mountGradleTab(root, a.transport, 'work');
    const rootB = document.createElement('div');
    document.body.append(rootB);
    const b = tabTransport({ detect: PROJECT, status: RUNNING });
    const tabB = mountGradleTab(rootB, b.transport, 'other');
    await flush();

    // Первой вкладке — длинный кадр с итогом в конце.
    const long = `${'gradle log line\n'.repeat(500)}[termhub] gradle exit=1\n`;
    a.opened[0]!.opts.onData(new TextEncoder().encode(long));
    expect(statusText(root)).toBe('Ошибка (1)');
    // Второй — короткий, итог в начале: общий на две вкладки курсор поиска
    // (или общий хвост прошлого кадра) увёл бы разбор мимо него.
    b.opened[0]!.opts.onData(new TextEncoder().encode('[termhub] gradle exit=0\ndone\n'));
    expect(statusText(rootB)).toBe('Готово (0)');
    expect(statusText(root)).toBe('Ошибка (1)');
    tabA.teardown();
    tabB.teardown();
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

// ── Панель списка: конфигурации, таски, поиск, аргументы, недавние ──────────
const DONE: GradleRunState = {
  phase: 'finished',
  session: '_gradle_work_a1b2c3',
  command: './gradlew build',
  startedAt: 2000,
};

function rowNames(host: HTMLElement, sel: string): string[] {
  return [...host.querySelectorAll(sel)].map((el) => el.querySelector('.th-grow__name')?.textContent ?? '');
}

describe('mountGradleTab: панель тасок и конфигураций', () => {
  let root: HTMLElement;

  beforeEach(() => {
    setLang('ru');
    xterm.instances.length = 0;
    localStorage.clear();
    location.hash = '#/';
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  });

  it('конфигурации — отдельной секцией над тасками; нет ни одной → секции нет вовсе', async () => {
    const { transport } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER, configs: CONFIGS });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    expect(rowNames(root, '.th-gsec--configs .th-grow--config')).toEqual(['app debug']);
    const order = [...root.querySelectorAll('.th-gsec')].map((el) => el.className);
    expect(order.findIndex((c) => c.includes('configs'))).toBeLessThan(order.findIndex((c) => c.includes('tasks')));
    tab.teardown();

    const empty = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER, configs: [] });
    const emptyRoot = document.createElement('div');
    document.body.append(emptyRoot);
    const emptyTab = mountGradleTab(emptyRoot, empty.transport, 'work');
    await flush();
    expect(emptyRoot.querySelector('.th-gsec--configs')).toBeNull();
    emptyTab.teardown();
  });

  it('пока список едет — «Читаю таски проекта…», кнопка «Обновить» перечитывает', async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const { transport, calls } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER, tasksGate: gate });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    // Ответ ещё не пришёл: заметку рисует список тасок, а не стартовая заглушка.
    const list = root.querySelector<HTMLElement>('.th-gsec--tasks .th-glist')!;
    expect(list.textContent).toContain(t('gradle.loadingTasks'));
    expect(list.querySelector('.th-spinner')).not.toBeNull();
    open();
    await flush();

    expect(rowNames(root, '.th-grow--task')).toEqual(['build', ':app:assembleDebug']);
    root.querySelector<HTMLButtonElement>('.th-gsec--tasks .th-iconbtn')!.click();
    await flush();
    expect(calls.filter((c) => c.action === 'tasks').map((c) => c.params.refresh)).toEqual([false, true]);
    tab.teardown();
  });

  it('Gradle не отдал список → хвост stderr и «Повторить»; ручной ввод таски работает', async () => {
    const { transport, calls } = tabTransport({ detect: PROJECT, status: IDLE, tasks: 'error', run: DONE });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    expect(root.querySelector('.th-loaderror')?.textContent).toContain('FAILURE: build file broken');
    root.querySelector<HTMLInputElement>('.th-grun__task')!.value = ':app:test';
    root.querySelector<HTMLInputElement>('.th-grun__args')!.value = '--offline';
    root.querySelector<HTMLFormElement>('.th-grun')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    const run = calls.find((c) => c.action === 'run')!;
    expect(run.params.tasks).toEqual([':app:test']);
    expect(run.params.args).toEqual(['--offline']);
    tab.teardown();
  });

  it('поиск фильтрует по имени и описанию; пустой результат — «ничего не нашлось»', async () => {
    const { transport } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    const search = root.querySelector<HTMLInputElement>('.th-gsearch')!;

    search.value = 'debug build';
    search.dispatchEvent(new Event('input'));
    expect(rowNames(root, '.th-grow--task')).toEqual([':app:assembleDebug']);
    expect(root.querySelector('.th-grow--task mark')?.textContent).toBe('debug build');

    search.value = 'zzz-нет-такой';
    search.dispatchEvent(new Event('input'));
    expect(rowNames(root, '.th-grow--task')).toEqual([]);
    expect(root.textContent).toContain(t('gradle.noMatches'));
    tab.teardown();
  });

  it('конфигурация запускается одной командой: таски в порядке XML, args в поле, своя папка', async () => {
    const { transport, calls } = tabTransport({
      detect: PROJECT,
      status: IDLE,
      tasks: TASKS_ANSWER,
      configs: CONFIGS,
      run: DONE,
    });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    root.querySelector<HTMLButtonElement>('.th-grow--config')!.click();
    await flush();

    const run = calls.find((c) => c.action === 'run')!;
    expect(run.params.tasks).toEqual([':app:clean', ':app:assembleDebug']);
    expect(run.params.args).toEqual(['--offline']);
    // PROJECT.dir = /p/app, конфигурация запускается из /p/app/app.
    expect(run.params.subdir).toBe('app');
    expect(root.querySelector<HTMLInputElement>('.th-grun__args')!.value).toBe('--offline');
    tab.teardown();
  });

  it('запуск поверх идущей сборки спрашивает, а не запускает молча', async () => {
    const { transport, calls } = tabTransport({
      detect: PROJECT,
      status: RUNNING,
      tasks: TASKS_ANSWER,
      run: { ...RUNNING, startedAt: 3000 },
    });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    root.querySelector<HTMLButtonElement>('.th-grow--task')!.click();
    await flush();
    expect(calls.some((c) => c.action === 'run')).toBe(false);
    const dialog = document.querySelector('.th-gbusy')!;
    expect(dialog.textContent).toContain('./gradlew :app:assembleDebug');

    dialog.querySelector<HTMLButtonElement>('.th-gbusy__go')!.click();
    await flush();
    expect(calls.find((c) => c.action === 'run')!.params.force).toBe(true);
    tab.teardown();
  });

  it('недавние: запуск попадает в список и в localStorage, повтор — одним нажатием', async () => {
    const { transport, calls } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER, run: DONE });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    expect(root.querySelector('.th-gsec--recent')).toBeNull();

    root.querySelector<HTMLButtonElement>('.th-grow--task')!.click();
    await flush();

    expect(rowNames(root, '.th-gsec--recent .th-grow--recent')).toEqual(['build']);
    expect(JSON.parse(localStorage.getItem('termhub.gradleRecent.work')!)).toEqual([
      { tasks: ['build'], args: [], subdir: '' },
    ]);

    root.querySelector<HTMLButtonElement>('.th-gsec--recent .th-grow--recent')!.click();
    await flush();
    expect(calls.filter((c) => c.action === 'run')).toHaveLength(2);
    tab.teardown();
  });

  it('недавние переживают перемонтирование вкладки и живут на свою сессию', async () => {
    localStorage.setItem(
      'termhub.gradleRecent.work',
      JSON.stringify([{ tasks: [':app:test'], args: ['--offline'], subdir: '' }]),
    );
    const { transport } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    expect(rowNames(root, '.th-grow--recent')).toEqual([':app:test']);
    tab.teardown();

    const other = document.createElement('div');
    document.body.append(other);
    const otherTab = mountGradleTab(other, transport, 'другая');
    await flush();
    expect(other.querySelector('.th-gsec--recent')).toBeNull();
    otherTab.teardown();
  });

  it('гость без права записи видит список, но запустить не может', async () => {
    const { transport, calls } = tabTransport({
      detect: PROJECT,
      status: IDLE,
      tasks: TASKS_ANSWER,
      configs: CONFIGS,
      scope: { write: false, files: true },
    });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    expect(rowNames(root, '.th-grow--task')).toEqual(['build', ':app:assembleDebug']);
    expect(root.querySelector('.th-grun')).toBeNull();
    expect([...root.querySelectorAll('.th-grow')].every((el) => (el as HTMLButtonElement).disabled)).toBe(true);

    root.querySelector<HTMLButtonElement>('.th-grow--task')!.click();
    await flush();
    expect(calls.some((c) => c.action === 'run')).toBe(false);
    tab.teardown();
  });
});

describe('mountWorkspace: показ вкладки Gradle', () => {
  let root: HTMLElement;

  beforeEach(() => {
    setLang('ru');
    xterm.instances.length = 0;
    localStorage.clear();
    location.hash = '#/';
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  });

  /** Транспорт со сценарием ответов детекта: по одному на каждый запрос подряд. */
  function scriptedTransport(script: (GradleProject | null | 'error')[], tasks?: GradleTasks): Transport {
    let i = 0;
    return {
      mode: 'lan',
      clientScope: null,
      list: async () => [],
      gradle: async (action: string) => {
        if (action === 'detect') {
          const answer = script[Math.min(i++, script.length - 1)];
          if (answer === 'error') throw new Error('relay down');
          return answer;
        }
        if (action === 'tasks') return tasks ?? EMPTY_TASKS;
        if (action === 'configs') return [];
        if (action === 'status') return IDLE;
        return null;
      },
      openTerm: () => ({ write: () => {}, resize: () => {}, close: () => {} }),
      close: () => {},
    } as unknown as Transport;
  }

  it('сбой детекта на переиспользуемом виде: «не удалось проверить» и «Повторить», а не вечная заглушка', async () => {
    const transport = scriptedTransport([null, 'error']);
    const ws = mountWorkspace(root, 'plain', transport);
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      location.hash = '#/sgradle/plain';
      ws.show('gradle');
      await flush();
      expect(location.hash).toBe('#/term/plain');

      clock.mockReturnValue(base + 60 * 60 * 1000);
      location.hash = '#/sgradle/plain';
      ws.show('gradle');
      await flush();

      expect(root.querySelector('.th-loaderror')?.textContent).toContain(t('gradle.detectError'));
      expect(root.textContent).not.toContain(t('gradle.loadingTasks'));
    } finally {
      clock.mockRestore();
      ws.teardown();
    }
  });

  it('сбой детекта не стирает уже загруженный список тасок', async () => {
    const transport = scriptedTransport([PROJECT, 'error'], TASKS_ANSWER);
    const ws = mountWorkspace(root, 'work', transport);
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      ws.show('gradle');
      await flush();
      expect(rowNames(root, '.th-grow--task')).toEqual(['build', ':app:assembleDebug']);

      clock.mockReturnValue(base + 60 * 60 * 1000);
      ws.show('gradle');
      await flush();

      expect(rowNames(root, '.th-grow--task')).toEqual(['build', ':app:assembleDebug']);
      expect(root.querySelector('.th-loaderror')).toBeNull();
    } finally {
      clock.mockRestore();
      ws.teardown();
    }
  });

  it('возврат к смонтированному виду с протухшим детектом уводит на терминал, а не показывает его', async () => {
    const { transport, calls } = tabTransport({ detect: null, status: IDLE });
    const ws = mountWorkspace(root, 'plain', transport);
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    try {
      // Первая навигация — прямая ссылка: бар ещё не спрашивал, вид монтируется и уводит сам.
      location.hash = '#/sgradle/plain';
      ws.show('gradle');
      await flush();
      expect(location.hash).toBe('#/term/plain');

      // Возврат по закладке спустя срок кэша: вид тот же, его askDetect уже отработал
      // и сам не повторится — показывать этот вид нельзя, пока детект не ответил снова.
      clock.mockReturnValue(base + 60 * 60 * 1000);
      location.hash = '#/sgradle/plain';
      ws.show('gradle');
      await flush();

      expect(calls.filter((c) => c.action === 'detect')).toHaveLength(2);
      expect(location.hash).toBe('#/term/plain');
    } finally {
      clock.mockRestore();
      ws.teardown();
    }
  });
});

describe('mountGradleTab: отказы вместо правдоподобной подмены', () => {
  let root: HTMLElement;

  beforeEach(() => {
    setLang('ru');
    xterm.instances.length = 0;
    localStorage.clear();
    location.hash = '#/';
    document.body.replaceChildren();
    root = document.createElement('div');
    document.body.append(root);
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe(): void {}
      disconnect(): void {}
    };
  });

  it('конфигурация с папкой вне корня сессии не запускается и говорит почему', async () => {
    const outside: GradleRunConfig[] = [{ ...CONFIGS[0]!, name: 'чужая', dir: '/other/app' }];
    const { transport, calls } = tabTransport({
      detect: PROJECT,
      status: IDLE,
      tasks: TASKS_ANSWER,
      configs: outside,
      run: DONE,
    });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    root.querySelector<HTMLButtonElement>('.th-grow--config')!.click();
    await flush();

    expect(calls.some((c) => c.action === 'run')).toBe(false);
    expect(document.querySelector('.th-toasts')?.textContent).toContain('чужая');
    tab.teardown();
  });

  it('отказ агента на ПЕРВОМ запуске (прежний старт неизвестен) опознаётся по команде', async () => {
    // status ещё не показал идущую сборку: phase = idle, startedAt = null.
    const { transport, calls } = tabTransport({
      detect: PROJECT,
      status: IDLE,
      tasks: TASKS_ANSWER,
      run: RUNNING, // агент вернул состояние ЧУЖОЙ сборки — значит, отказал
    });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    root.querySelector<HTMLButtonElement>('.th-grow--task')!.click();
    await flush();

    expect(calls.filter((c) => c.action === 'run')).toHaveLength(1);
    expect(document.querySelector('.th-gbusy')).not.toBeNull();
    // Отказ — не запуск: в «Недавние» строка не уходит.
    expect(root.querySelector('.th-gsec--recent')).toBeNull();
    expect(localStorage.getItem('termhub.gradleRecent.work')).toBeNull();
    tab.teardown();
  });

  it('повтор недавнего запускает ту запись, что в строке, а не ту, что на её месте', async () => {
    const a = { tasks: ['build'], args: [], subdir: '' };
    const b = { tasks: [':app:assembleDebug'], args: ['--offline'], subdir: '' };
    localStorage.setItem('termhub.gradleRecent.work', JSON.stringify([b, a]));
    const { transport, calls } = tabTransport({ detect: PROJECT, status: IDLE, tasks: TASKS_ANSWER, run: DONE });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();

    // Запуск таски `build` поднимает a наверх — места строк меняются.
    root.querySelector<HTMLButtonElement>('.th-grow--task')!.click();
    await flush();
    expect(rowNames(root, '.th-grow--recent')).toEqual(['build', ':app:assembleDebug']);

    const rows = [...root.querySelectorAll<HTMLButtonElement>('.th-grow--recent')];
    rows.find((el) => el.textContent?.includes(':app:assembleDebug'))!.click();
    await flush();

    const last = calls.filter((c) => c.action === 'run').at(-1)!;
    expect(last.params.tasks).toEqual([':app:assembleDebug']);
    expect(last.params.args).toEqual(['--offline']);
    tab.teardown();
  });

  it('в проекте нет тасок — это не «поиск ничего не дал»', async () => {
    const { transport } = tabTransport({ detect: PROJECT, status: IDLE, tasks: EMPTY_TASKS });
    const tab = mountGradleTab(root, transport, 'work');
    await flush();
    expect(root.textContent).toContain(t('gradle.noTasks'));
    expect(root.textContent).not.toContain(t('gradle.noMatches'));
    tab.teardown();
  });
});
