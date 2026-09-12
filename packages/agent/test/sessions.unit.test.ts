import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionService, parseListOutput, pickFreeName, isCreatableSessionName } from '../src/sessions.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const mockExecFile = vi.mocked(execFile);

/** Ставит на execFile простой ответ (stdout по признаку подкоманды). */
function stubTmux(handler: (args: string[]) => { err?: unknown; stdout?: string; stderr?: string }): void {
  mockExecFile.mockImplementation(((_bin: string, args: string[], _opts: unknown, cb: (e: unknown, o: string, s: string) => void) => {
    const r = handler(args);
    cb(r.err ?? null, r.stdout ?? '', r.stderr ?? '');
    return {} as never;
  }) as never);
}

beforeEach(() => {
  mockExecFile.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseListOutput', () => {
  it('парсит оба формата, выбирает не-shell команду и агрегирует bell', () => {
    const sessions =
      'main\t/Users/x/projects/app\t1783744494\t1\t⠂ Сборка\n' +
      'work\t/Users/x/projects/api\t1783744400\t0\t✳ Готово, жду\n';
    const panes =
      'main\tzsh\t0\n' +
      'main\tvim\t1\n' +
      'work\tzsh\t0\n' +
      'work\t-zsh\t0\n';
    expect(parseListOutput(sessions, panes)).toEqual([
      {
        name: 'main',
        path: '/Users/x/projects/app',
        command: 'vim',
        activityTs: 1783744494000,
        attached: 1,
        bell: true, // BEL из панели vim
        title: '⠂ Сборка',
      },
      {
        name: 'work',
        path: '/Users/x/projects/api',
        command: 'zsh',
        activityTs: 1783744400000,
        attached: 0,
        bell: false, // ✳ (ожидание) — дефолтное idle-состояние, НЕ звонок; BEL нет
        title: '✳ Готово, жду',
      },
    ]);
  });

  it('command = zsh, если все панели — оболочки; bell = OR по всем панелям', () => {
    const sessions = 'srv\t/srv\t10\t0\tsrv\n';
    const panes = 'srv\tbash\t0\nsrv\tsh\t1\nsrv\tlogin\t0\n';
    const [info] = parseListOutput(sessions, panes);
    expect(info.command).toBe('zsh');
    expect(info.bell).toBe(true);
  });

  it('сессия без панелей → команда zsh, bell false', () => {
    const [info] = parseListOutput('lone\t/lone\t5\t0\tlone\n', '');
    expect(info).toMatchObject({ command: 'zsh', bell: false });
  });

  it('пустой ввод → []', () => {
    expect(parseListOutput('', '')).toEqual([]);
  });

  it('переживает таб внутри session_path: name/path/activityTs/attached разбираются верно', () => {
    // Путь содержит буквальный таб — единственное поле, способное его содержать.
    const sessions = 'main\t/Users/x/pro\tjects/app\t1783744494\t1\t⠂ task\n';
    const [info] = parseListOutput(sessions, '');
    expect(info).toMatchObject({
      name: 'main',
      path: '/Users/x/pro\tjects/app',
      activityTs: 1783744494000,
      attached: 1,
      title: '⠂ task',
    });
  });

  it('переживает таб внутри pane_current_command', () => {
    const sessions = 'main\t/p\t100\t0\tmain\n';
    const panes = 'main\tvim\tfile.txt\t1\n';
    const [info] = parseListOutput(sessions, panes);
    expect(info.command).toBe('vim\tfile.txt');
    expect(info.bell).toBe(true);
  });
});

describe('SessionService.list', () => {
  it('«no server running» / exit 1 → []', async () => {
    stubTmux((args) => {
      if (args.includes('list-sessions'))
        return { err: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'no server running on /tmp/tmux-501/termhub-test\n' };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'], socketName: 'termhub-test-u' });
    expect(await svc.list()).toEqual([]);
  });

  it('«error connecting … (No such file or directory)» → []', async () => {
    stubTmux((args) => {
      if (args.includes('list-sessions'))
        return { err: Object.assign(new Error('exit 1'), { code: 1 }), stderr: 'error connecting to /tmp/x (No such file or directory)\n' };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'] });
    expect(await svc.list()).toEqual([]);
  });

  it('прокидывает socketName как -L и парсит вывод', async () => {
    const seen: string[][] = [];
    stubTmux((args) => {
      seen.push(args);
      if (args.includes('list-sessions')) return { stdout: 'main\t/p\t100\t0\tmain\n' };
      if (args.includes('list-panes')) return { stdout: 'main\tnode\t0\n' };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'], socketName: 'termhub-test-u' });
    const list = await svc.list();
    expect(list).toEqual([
      { name: 'main', path: '/p', command: 'node', activityTs: 100000, attached: 0, bell: false, title: 'main' },
    ]);
    for (const args of seen) expect(args.slice(0, 2)).toEqual(['-L', 'termhub-test-u']);
  });

  it('иная ошибка exit 1 (не no-server) пробрасывается', async () => {
    stubTmux((args) => {
      if (args.includes('list-sessions'))
        return { err: Object.assign(new Error('boom'), { code: 1 }), stderr: 'unknown option\n' };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'] });
    await expect(svc.list()).rejects.toThrow();
  });
});

describe('SessionService.create — валидация', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-root-'));
    fs.mkdirSync(path.join(root, 'projectA'));
    stubTmux(() => ({}));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('отвергает недопустимое имя сессии', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'bad name!', root, dir: 'projectA', preset: 'zsh' })).rejects.toThrow(/name/i);
  });

  it('отвергает точку/двоеточие в имени (tmux не адресует такую сессию)', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'VrnBus.StationScreen', root, dir: 'projectA', preset: 'zsh' })).rejects.toThrow(/name/i);
    await expect(svc.create({ name: 'a:b', root, dir: 'projectA', preset: 'zsh' })).rejects.toThrow(/name/i);
  });

  it('отвергает слишком длинное имя (>40)', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'a'.repeat(41), root, dir: 'projectA', preset: 'zsh' })).rejects.toThrow(/name/i);
  });

  it('отвергает root вне списка roots', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'main', root: '/etc', dir: 'projectA', preset: 'zsh' })).rejects.toThrow(/root/i);
  });

  it('отвергает dir со слэшем', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'main', root, dir: 'sub/deep', preset: 'zsh' })).rejects.toThrow(/directory/i);
  });

  it('отвергает dir = ..', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'main', root, dir: '..', preset: 'zsh' })).rejects.toThrow(/directory/i);
  });

  it('отвергает несуществующий каталог', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.create({ name: 'main', root, dir: 'nope', preset: 'zsh' })).rejects.toThrow(/directory/i);
  });

  it('preset zsh → new-session без команды; -c указывает на каталог', async () => {
    const svc = new SessionService({ roots: [root], socketName: 'termhub-test-u' });
    await svc.create({ name: 'main', root, dir: 'projectA', preset: 'zsh' });
    const args = mockExecFile.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual([
      '-L', 'termhub-test-u',
      'new-session', '-d', '-s', 'main', '-c', path.join(root, 'projectA'),
    ]);
  });

  it('preset claude → команда claude в конце', async () => {
    const svc = new SessionService({ roots: [root] });
    await svc.create({ name: 'main', root, dir: 'projectA', preset: 'claude' });
    const args = mockExecFile.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual(['new-session', '-d', '-s', 'main', '-c', path.join(root, 'projectA'), 'claude']);
  });

  it('preset codex → process-local overrides и inline-режим без альтернативного экрана', async () => {
    const svc = new SessionService({ roots: [root] });
    await svc.create({ name: 'main', root, dir: 'projectA', preset: 'codex' });
    const args = mockExecFile.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual([
      'new-session', '-d', '-s', 'main', '-c', path.join(root, 'projectA'),
      'codex',
      '-c', 'tui.animations=false',
      '-c', 'tui.terminal_title=["activity","thread-title"]',
      '--no-alt-screen',
    ]);
  });

  it('отвергает недопустимый preset', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(
      svc.create({ name: 'main', root, dir: 'projectA', preset: 'rm -rf' as unknown as 'zsh' }),
    ).rejects.toThrow(/preset/i);
  });

  it('rename → rename-session с точным (=) старым именем', async () => {
    const svc = new SessionService({ roots: [root] });
    await svc.rename('old', 'new');
    const args = mockExecFile.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual(['rename-session', '-t', '=old', 'new']);
  });

  it('rename отвергает недопустимое имя (старое или новое)', async () => {
    const svc = new SessionService({ roots: [root] });
    await expect(svc.rename('bad name!', 'ok')).rejects.toThrow(/name/i);
    await expect(svc.rename('ok', 'a.b')).rejects.toThrow(/name/i);
  });
});

describe('SessionService.kill', () => {
  it('вызывает kill-session -t =<name> (без fuzzy-матчинга)', async () => {
    stubTmux(() => ({}));
    const svc = new SessionService({ roots: ['/tmp'], socketName: 'termhub-test-u' });
    await svc.kill('main');
    const args = mockExecFile.mock.calls.at(-1)![1] as string[];
    expect(args).toEqual(['-L', 'termhub-test-u', 'kill-session', '-t', '=main']);
  });

  it('отвергает недопустимое имя без вызова tmux', async () => {
    stubTmux(() => ({}));
    const svc = new SessionService({ roots: ['/tmp'] });
    await expect(svc.kill('bad name!')).rejects.toThrow(/name/i);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('SessionService.dirs', () => {
  it('возвращает отсортированные несокрытые подкаталоги; несуществующий root → []', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-dirs-'));
    fs.mkdirSync(path.join(root, 'beta'));
    fs.mkdirSync(path.join(root, 'alpha'));
    fs.mkdirSync(path.join(root, '.hidden'));
    fs.writeFileSync(path.join(root, 'file.txt'), 'x');
    stubTmux(() => ({}));
    const svc = new SessionService({ roots: [root, '/no/such/root'] });
    expect(await svc.dirs()).toEqual([
      { root, dirs: ['alpha', 'beta'] },
      { root: '/no/such/root', dirs: [] },
    ]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  // Не-ENOENT ошибка readdir (EACCES) не маскируется под пустой список — пробрасывается.
  // Root игнорирует права доступа, поэтому под ним кейс невоспроизводим — пропускаем.
  it.skipIf(process.getuid?.() === 0)('non-ENOENT ошибка (EACCES) пробрасывается, а не → []', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-eacces-'));
    fs.chmodSync(root, 0o000);
    stubTmux(() => ({}));
    const svc = new SessionService({ roots: [root] });
    try {
      await expect(svc.dirs()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      fs.chmodSync(root, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('SessionService.onBell — переход false→true', () => {
  it('эмитит один раз на переходе, поллинг unref/идемпотентен', async () => {
    vi.useFakeTimers();
    let bell = false;
    stubTmux((args) => {
      if (args.includes('list-sessions')) return { stdout: 'main\t/p\t1\t0\tmain\n' };
      if (args.includes('list-panes')) return { stdout: `main\tzsh\t${bell ? '1' : '0'}\n` };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'], socketName: 'termhub-test-u' });
    const cb = vi.fn();
    svc.onBell(cb);
    svc.startPolling();
    svc.startPolling(); // идемпотентно

    await vi.advanceTimersByTimeAsync(2000); // poll1: bell=false → нет эмита
    expect(cb).not.toHaveBeenCalled();

    bell = true;
    await vi.advanceTimersByTimeAsync(2000); // poll2: false→true → эмит
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('main', '');

    await vi.advanceTimersByTimeAsync(2000); // poll3: true→true → нет эмита
    expect(cb).toHaveBeenCalledTimes(1);

    svc.stopPolling();
    await vi.advanceTimersByTimeAsync(4000); // остановлен → без новых вызовов
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('звонок (реальный BEL) несёт последнюю задачу из рабочего заголовка', async () => {
    vi.useFakeTimers();
    let bell = false;
    // Сессия работает (брайлевый заголовок с задачей); реальный BEL приходит позже.
    stubTmux((args) => {
      if (args.includes('list-sessions')) return { stdout: 's\t/p\t1\t0\t⠂ Сборка проекта\n' };
      if (args.includes('list-panes')) return { stdout: `s\tzsh\t${bell ? '1' : '0'}\n` };
      return {};
    });
    const svc = new SessionService({ roots: ['/tmp'], socketName: 'termhub-test-u' });
    const cb = vi.fn();
    svc.onBell(cb);
    svc.startPolling();

    await vi.advanceTimersByTimeAsync(2000); // poll1: работает, задачу запомнили, BEL нет
    expect(cb).not.toHaveBeenCalled();

    bell = true;
    await vi.advanceTimersByTimeAsync(2000); // poll2: BEL false→true → эмит с задачей
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith('s', 'Сборка проекта');

    svc.stopPolling();
  });
});

describe('pickFreeName — свободное имя с числовым суффиксом', () => {
  it('свободная база берётся как есть — даже если занята база с суффиксом', () => {
    expect(pickFreeName('MyProject', new Set())).toBe('MyProject');
    expect(pickFreeName('MyProject', new Set(['MyProject1']))).toBe('MyProject');
  });

  it('первый дубль — «1» без разделителя, дальше 2, 3…', () => {
    expect(pickFreeName('MyProject', new Set(['MyProject']))).toBe('MyProject1');
    expect(pickFreeName('MyProject', new Set(['MyProject', 'MyProject1']))).toBe('MyProject2');
    expect(pickFreeName('MyProject', new Set(['MyProject', 'MyProject1', 'MyProject2']))).toBe('MyProject3');
  });

  it('дыры заполняются: заняты база и «2» → «1»', () => {
    expect(pickFreeName('MyProject', new Set(['MyProject', 'MyProject2']))).toBe('MyProject1');
  });

  it('цифра на конце базы не увеличивается: v2 → v21 → v22', () => {
    expect(pickFreeName('v2', new Set(['v2']))).toBe('v21');
    expect(pickFreeName('v2', new Set(['v2', 'v21']))).toBe('v22');
  });

  it('база в 40 символов обрезается под суффикс: 39 × «a» + «1»; под двузначный — 38 + «10»', () => {
    const base = 'a'.repeat(40);
    expect(pickFreeName(base, new Set([base]))).toBe('a'.repeat(39) + '1');
    const taken = new Set([base, ...Array.from({ length: 9 }, (_, i) => 'a'.repeat(39) + String(i + 1))]);
    const picked = pickFreeName(base, taken);
    expect(picked).toBe('a'.repeat(38) + '10');
    expect(isCreatableSessionName(picked)).toBe(true);
  });

  it('потолок перебора (10 000) → ошибка с именем базы', () => {
    const taken = new Set(['x', ...Array.from({ length: 10_000 }, (_, i) => `x${i + 1}`)]);
    expect(() => pickFreeName('x', taken)).toThrow(/«x»/);
  });
});

describe('SessionService.create — autoName: свободное имя по живому списку tmux', () => {
  let root: string;
  let svc: SessionService;
  const DUP = (name: string) => ({ err: { code: 1 }, stderr: `duplicate session: ${name}\n` });

  /** Стаб tmux, помнящий занятые имена: list-sessions отдаёт их сырым списком,
   *  new-session на занятое отвечает «duplicate session», на свободное — занимает. */
  function stubTmuxWithSessions(taken: Set<string>, over: Partial<{ list: () => { err?: unknown; stdout?: string; stderr?: string } }> = {}) {
    stubTmux((args) => {
      if (args.includes('list-sessions')) return over.list ? over.list() : { stdout: [...taken].map((n) => n + '\n').join('') };
      if (args.includes('new-session')) {
        const name = args[args.indexOf('-s') + 1]!;
        if (taken.has(name)) return DUP(name);
        taken.add(name);
        return {};
      }
      return {};
    });
  }

  function newSessionNames(): string[] {
    return mockExecFile.mock.calls
      .map((c) => c[1] as string[])
      .filter((a) => a.includes('new-session'))
      .map((a) => a[a.indexOf('-s') + 1]!);
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-root-'));
    fs.mkdirSync(path.join(root, 'MyProject'));
    svc = new SessionService({ roots: [root], socketName: 'termhub-test-u' });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    [[], 'MyProject'],
    [['MyProject'], 'MyProject1'],
    [['MyProject', 'MyProject1'], 'MyProject2'],
    [['MyProject', 'MyProject2'], 'MyProject1'],
  ])('заняты %j → создаётся %s и имя возвращается', async (taken, expected) => {
    stubTmuxWithSessions(new Set(taken));
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).resolves.toEqual({ name: expected });
    expect(newSessionNames()).toEqual([expected]);
  });

  it('занятые имена берутся сырым list-sessions -F #{session_name} (сборочные сессии видны), без list-panes', async () => {
    stubTmuxWithSessions(new Set(['MyProject', '_gradle_MyProject_ab12cd']));
    // Сборочная сессия скрыта из list(), но имя занимает — кандидат с её именем недопустим.
    await expect(svc.create({ name: '_gradle_MyProject_ab12cd', root, dir: 'MyProject', preset: 'zsh', autoName: true }))
      .resolves.toEqual({ name: '_gradle_MyProject_ab12cd1' });
    // Ровно одна попытка new-session — сразу со свободным именем: занятое из сырого списка
    // видно заранее, пробовать его и ловить «duplicate session» не пришлось.
    expect(newSessionNames()).toEqual(['_gradle_MyProject_ab12cd1']);
    const calls = mockExecFile.mock.calls.map((c) => c[1] as string[]);
    const listCall = calls.find((a) => a.includes('list-sessions'))!;
    expect(listCall).toEqual(['-L', 'termhub-test-u', 'list-sessions', '-F', '#{session_name}']);
    expect(calls.some((a) => a.includes('list-panes'))).toBe(false);
  });

  it('«no server running» при чтении списка → пустой список, имя папки как есть', async () => {
    stubTmuxWithSessions(new Set(), { list: () => ({ err: { code: 1 }, stderr: 'no server running on /tmp/tmux-501/termhub-test-u\n' }) });
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).resolves.toEqual({ name: 'MyProject' });
  });

  it('иная ошибка list-sessions пробрасывается, new-session не вызывается', async () => {
    stubTmuxWithSessions(new Set(), { list: () => ({ err: { code: 1 }, stderr: 'permission denied\n' }) });
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).rejects.toMatchObject({ code: 1 });
    expect(newSessionNames()).toEqual([]);
  });

  it('гонка: список пуст, но new-session отвечает «duplicate session» → следующий номер', async () => {
    stubTmuxWithSessions(new Set(['MyProject', 'MyProject1']), { list: () => ({ stdout: '' }) });
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).resolves.toEqual({ name: 'MyProject2' });
    expect(newSessionNames()).toEqual(['MyProject', 'MyProject1', 'MyProject2']);
  });

  it('вечный «duplicate session» → не больше 5 попыток и внятная ошибка с базой', async () => {
    stubTmux((args) => (args.includes('new-session') ? DUP(args[args.indexOf('-s') + 1]!) : { stdout: '' }));
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).rejects.toThrow(/«MyProject».*5/);
    expect(newSessionNames()).toEqual(['MyProject', 'MyProject1', 'MyProject2', 'MyProject3', 'MyProject4']);
  });

  it('иная ошибка new-session при autoName — сразу наружу, без повторов', async () => {
    stubTmux((args) => (args.includes('new-session') ? { err: { code: 1 }, stderr: 'unknown option -- Q\n' } : { stdout: '' }));
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName: true })).rejects.toMatchObject({ code: 1, stderr: /unknown option/ });
    expect(newSessionNames()).toEqual(['MyProject']);
  });

  it.each([undefined, false])('autoName=%s: имя как есть, дубль от tmux пробрасывается без повторов и без чтения списка', async (autoName) => {
    stubTmuxWithSessions(new Set(['MyProject']));
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh', autoName })).rejects.toMatchObject({ stderr: /duplicate session/ });
    expect(newSessionNames()).toEqual(['MyProject']);
    expect(mockExecFile.mock.calls.some((c) => (c[1] as string[]).includes('list-sessions'))).toBe(false);
  });

  it('без autoName успех возвращает запрошенное имя', async () => {
    stubTmuxWithSessions(new Set());
    await expect(svc.create({ name: 'MyProject', root, dir: 'MyProject', preset: 'zsh' })).resolves.toEqual({ name: 'MyProject' });
  });

  it('autoName не ослабляет валидацию: плохое имя отвергается до всякого tmux', async () => {
    stubTmuxWithSessions(new Set());
    await expect(svc.create({ name: 'bad name!', root, dir: 'MyProject', preset: 'zsh', autoName: true })).rejects.toThrow(/name/i);
    await expect(svc.create({ name: 'a'.repeat(41), root, dir: 'MyProject', preset: 'zsh', autoName: true })).rejects.toThrow(/name/i);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
