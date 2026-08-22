// @vitest-environment happy-dom
import type { GradleRunConfig, GradleTasks } from '@termhub/protocol/frames';
import { beforeEach, describe, expect, it } from 'vitest';

import type { RecentRun } from '../src/gradle-view';
import {
  filterTasks,
  groupTasks,
  pushRecent,
  recentKey,
  renderConfigRow,
  renderRecentRow,
  renderTaskRow,
} from '../src/gradle-view';
import { setLang } from '../src/i18n';

// Многомодульный набор: корневой проект, два подпроекта, три группы.
// Порядок внутри массива намеренно перемешан — его задаёт groupTasks, а не вход.
const TASKS: GradleTasks = {
  fetchedAt: 1,
  groupOrder: ['Build tasks', 'Verification tasks', 'Other tasks'],
  tasks: [
    { name: ':app:test', project: ':app', group: 'Verification tasks', description: 'Runs the unit tests' },
    { name: ':lib:jar', project: ':lib', group: 'Build tasks', description: 'Assembles a jar archive' },
    { name: ':app:assembleRelease', project: ':app', group: 'Build tasks', description: '' },
    { name: ':app:prepareKotlinBuildScriptModel', project: ':app', group: 'Other tasks', description: '' },
    { name: 'build', project: ':', group: 'Build tasks', description: 'Builds everything' },
    { name: ':app:assembleDebug', project: ':app', group: 'Build tasks', description: 'Assembles the debug build' },
  ],
};

describe('groupTasks', () => {
  beforeEach(() => setLang('ru'));

  it('корневой проект первым, подпроекты по алфавиту', () => {
    expect(groupTasks(TASKS).map((p) => p.project)).toEqual([':', ':app', ':lib']);
  });

  it('группы внутри проекта — в порядке от Gradle, «Other tasks» последней', () => {
    const app = groupTasks(TASKS).find((p) => p.project === ':app')!;
    expect(app.groups.map((g) => g.group)).toEqual(['Build tasks', 'Verification tasks', 'Other tasks']);
  });

  it('таски внутри группы — по алфавиту', () => {
    const app = groupTasks(TASKS).find((p) => p.project === ':app')!;
    const build = app.groups.find((g) => g.group === 'Build tasks')!;
    expect(build.tasks.map((task) => task.name)).toEqual([':app:assembleDebug', ':app:assembleRelease']);
  });

  it('пустых групп и проектов не заводит', () => {
    const root = groupTasks(TASKS).find((p) => p.project === ':')!;
    expect(root.groups.map((g) => g.group)).toEqual(['Build tasks']);
    expect(root.groups[0]!.tasks.map((task) => task.name)).toEqual(['build']);
  });
});

describe('filterTasks', () => {
  beforeEach(() => setLang('ru'));

  it('пустой запрос отдаёт дерево целиком', () => {
    const tree = groupTasks(TASKS);
    expect(filterTasks(tree, '   ')).toEqual(tree);
  });

  it('фильтрует по имени таски, регистр не важен', () => {
    const found = filterTasks(groupTasks(TASKS), 'ASSEMBLEdebug');
    expect(found.map((p) => p.project)).toEqual([':app']);
    expect(found[0]!.groups.map((g) => g.tasks.map((task) => task.name))).toEqual([[':app:assembleDebug']]);
  });

  it('фильтрует по описанию тоже', () => {
    const found = filterTasks(groupTasks(TASKS), 'unit tests');
    expect(found.flatMap((p) => p.groups.flatMap((g) => g.tasks.map((task) => task.name)))).toEqual([':app:test']);
  });

  it('ничего не нашлось — пустое дерево, а не дерево пустых групп', () => {
    expect(filterTasks(groupTasks(TASKS), 'zzz-нет-такой')).toEqual([]);
  });
});

describe('renderTaskRow', () => {
  const TASK = TASKS.tasks.find((task) => task.name === ':app:assembleDebug')!;

  it('имя, описание подписью и имя таски для запуска в data-task', () => {
    const el = renderTaskRow(TASK);
    expect(el.dataset.task).toBe(':app:assembleDebug');
    expect(el.querySelector('.th-grow__name')?.textContent).toBe(':app:assembleDebug');
    expect(el.querySelector('.th-grow__desc')?.textContent).toBe('Assembles the debug build');
  });

  it('таске без описания подписи не рисует', () => {
    const bare = TASKS.tasks.find((task) => task.name === ':app:assembleRelease')!;
    expect(renderTaskRow(bare).querySelector('.th-grow__desc')).toBeNull();
  });

  it('подсвечивает совпадение и в имени, и в описании', () => {
    const el = renderTaskRow(TASK, 'debug');
    const marks = [...el.querySelectorAll('mark')].map((m) => m.textContent);
    // В имени — «Debug», в описании — «debug»: подсветка сохраняет регистр текста.
    expect(marks).toEqual(['Debug', 'debug']);
    expect(el.querySelector('.th-grow__name')?.textContent).toBe(':app:assembleDebug');
  });
});

describe('renderConfigRow', () => {
  const CFG: GradleRunConfig = {
    name: 'assembleDebug (app)',
    tasks: [':app:clean', ':app:assembleDebug'],
    args: '--offline -Pfoo=bar',
    dir: '/p/app',
    source: '.run',
  };

  it('имя, таски в порядке из XML и аргументы подписью', () => {
    const el = renderConfigRow(CFG);
    expect(el.dataset.config).toBe('assembleDebug (app)');
    expect(el.querySelector('.th-grow__name')?.textContent).toBe('assembleDebug (app)');
    expect(el.querySelector('.th-grow__desc')?.textContent).toBe(':app:clean :app:assembleDebug --offline -Pfoo=bar');
  });

  it('конфигурацию без аргументов рисует одними тасками', () => {
    const el = renderConfigRow({ ...CFG, args: '' });
    expect(el.querySelector('.th-grow__desc')?.textContent).toBe(':app:clean :app:assembleDebug');
  });
});

describe('pushRecent', () => {
  const run = (name: string): RecentRun => ({ tasks: [name], args: [], subdir: '' });

  it('новый запуск — первым', () => {
    expect(pushRecent([run('a')], run('b')).map((e) => e.tasks[0])).toEqual(['b', 'a']);
  });

  it('повтор всплывает наверх, а не двоится', () => {
    const list = pushRecent(pushRecent([run('a')], run('b')), run('a'));
    expect(list.map((e) => e.tasks[0])).toEqual(['a', 'b']);
  });

  it('различает запуски по аргументам и по папке', () => {
    const base = run('a');
    const withArgs = { ...base, args: ['--offline'] };
    expect(pushRecent([base], withArgs)).toHaveLength(2);
    expect(pushRecent([base], { ...base, subdir: 'app' })).toHaveLength(2);
  });

  it('держит не больше десяти', () => {
    let list: RecentRun[] = [];
    for (let i = 0; i < 14; i += 1) list = pushRecent(list, run(`t${i}`));
    expect(list).toHaveLength(10);
    expect(list[0]!.tasks[0]).toBe('t13');
    expect(list[9]!.tasks[0]).toBe('t4');
  });
});

describe('renderRecentRow', () => {
  const A: RecentRun = { tasks: [':app:clean', ':app:test'], args: ['--offline'], subdir: '' };
  const B: RecentRun = { tasks: ['build'], args: [], subdir: '' };

  it('таски строкой, аргументы подписью', () => {
    const el = renderRecentRow(A);
    expect(el.querySelector('.th-grow__name')?.textContent).toBe(':app:clean :app:test');
    expect(el.querySelector('.th-grow__desc')?.textContent).toBe('--offline');
  });

  it('запуск без аргументов подписи не имеет', () => {
    expect(renderRecentRow(B).querySelector('.th-grow__desc')).toBeNull();
  });

  it('ручка в разметке — ключ записи: своя у каждой и одна и та же у равных', () => {
    expect(renderRecentRow(A).dataset.recent).toBe(recentKey(A));
    expect(renderRecentRow(B).dataset.recent).not.toBe(renderRecentRow(A).dataset.recent);
    expect(renderRecentRow({ ...A, tasks: [...A.tasks] }).dataset.recent).toBe(renderRecentRow(A).dataset.recent);
  });

  it('по ручке запись находится и после переупорядочивания списка', () => {
    const handle = renderRecentRow(A).dataset.recent;
    // pushRecent поднял B наверх: место A изменилось, ручка — нет.
    const list = pushRecent([A], B);
    expect(list.findIndex((e) => recentKey(e) === handle)).toBe(1);
  });
});
