// Шов один: resolve() на подменённых источниках — реестре Claude, таблице процессов,
// списке панелей и списке открытых файлов. Живые агенты, живой tmux и настоящие ps/lsof
// здесь не участвуют. Формы записей и путей взяты с живых данных владельца 13.09.2026.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve, clearCache, type TranscriptSources, type ProcessRow } from '../src/agent-transcript.js';

const HOME = '/home/u';
const PANE = 'SprutApp:@6.%6';
const SESSION_ID = '6d01e8cf-a7e0-431e-bd42-dd0769492ef9';
const CWD = '/Users/u/projects/Sprut.App';
// Каталог транскриптов разобран вручную по правилу Claude: каждый символ вне [A-Za-z0-9]
// заменён дефисом (на живых данных «/Users/u/GitHub/Sprut.Hub_Tools» лежит в
// «-Users-u-GitHub-Sprut-Hub-Tools»).
const CURRENT = `${HOME}/.claude/projects/-Users-u-projects-Sprut-App/${SESSION_ID}.jsonl`;
const PREV = `${HOME}/.claude/projects/-Users-u-projects-Sprut-App/d2d64e42-5893-4e6e-8a30-5c05ce3cf867.jsonl`;

// procStart в реестре — UTC; ps отдаёт то же время по локальному календарю. Под
// Europe/Moscow это 14:24:49Z и 17:24:49 на часах — один и тот же момент.
const PROC_START_UTC = 'Thu Sep  3 14:24:49 2026';
const localStart = (): Date => new Date(2026, 8, 3, 17, 24, 49);
const row = (pid: number, startedAt: Date, ppid = 1, args?: string): ProcessRow => ({
  pid,
  ppid,
  startedAt,
  args,
});

const CODEX_DIR = `${HOME}/.codex/sessions`;
const ROOT_FILE = `${CODEX_DIR}/2026/09/05/rollout-2026-09-05T22-24-43-01a07307-c04e-7a62-8322-3fa3ce8122cb.jsonl`;
const NESTED_FILE = `${CODEX_DIR}/2026/09/08/rollout-2026-09-08T00-44-21-01a07dd4-5240-7b60-a3d7-30bbd8c3e4b0.jsonl`;
// Живая форма первой строки rollout: у корневого потока нет parent_thread_id, а source
// — строка «cli»; у вложенного есть родитель и source.subagent.
const ROOT_META =
  JSON.stringify({
    timestamp: '2026-09-05T19:24:43.211Z',
    type: 'session_meta',
    payload: {
      session_id: '01a07307-c04e-7a62-8322-3fa3ce8122cb',
      id: '01a07307-c04e-7a62-8322-3fa3ce8122cb',
      timestamp: '2026-09-05T19:24:43.211Z',
      cwd: '/Users/u/projects/App',
      originator: 'codex-tui',
      source: 'cli',
      thread_source: 'user',
    },
  }) + '\n{"timestamp":"2026-09-05T19:24:44.000Z","type":"event_msg","payload":{"type":"task_started"}}\n';
const NESTED_META =
  JSON.stringify({
    timestamp: '2026-09-07T21:44:22.232Z',
    type: 'session_meta',
    payload: {
      session_id: '01a07307-c04e-7a62-8322-3fa3ce8122cb',
      id: '01a07dd4-5240-7b60-a3d7-30bbd8c3e4b0',
      parent_thread_id: '01a07307-c04e-7a62-8322-3fa3ce8122cb',
      timestamp: '2026-09-07T21:44:21.967Z',
      source: { subagent: { other: 'guardian' } },
      thread_source: 'guardian_review',
    },
  }) + '\n';
// Открытый .jsonl вне каталога сессий Codex: правдоподобный корневой rollout, но чужой.
const OUTSIDE_FILE = '/tmp/rollout-2026-09-13T10-00-00-01a09999-0000-7000-8000-000000000000.jsonl';
const OUTSIDE_META = ROOT_META.replace(/2026-09-05T19:24:43\.211Z/g, '2026-09-13T10:00:00.000Z');

const FORKED_META = ROOT_META.replace(
  '"source":"cli"',
  '"forked_from_id":"01a06ddb-c70c-7a13-839d-acc85e9611d5","source":"cli"',
);

/** Панель существует, и её процесс старше записи реестра: только при этом запись,
 *  пережившая своего агента, вообще рассматривается. */
const olderPane = (startedAt = new Date(2026, 8, 3, 17, 0, 0)): Partial<TranscriptSources> => ({
  panePids: async () => new Map([[PANE, 900]]),
  processTable: async () => [row(900, startedAt)],
});

const savedTz = process.env.TZ;

beforeEach(() => {
  // Зона нужна с ненулевым смещением: под UTC сверка времён старта перестала бы
  // различать правильное сравнение и наивное.
  process.env.TZ = 'Europe/Moscow';
  clearCache();
});

afterEach(() => {
  vi.useRealTimers();
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
  clearCache();
});

/** Полный набор источников-заглушек: наружу (в ps, tmux, lsof, файловую систему) тест не
 *  выходит ни одним вызовом. */
function sources(over: Partial<TranscriptSources> = {}): Partial<TranscriptSources> {
  return {
    home: HOME,
    readDir: async () => [],
    readHead: async () => '',
    isFile: async () => true,
    processTable: async () => [],
    // Панель по умолчанию существует: «панели нет» — это отдельный ответ (lookup-failed),
    // и делать его фоном всех остальных проверок значило бы проверять не то.
    panePids: async () => new Map([[PANE, 900]]),
    openFiles: async () => [],
    ...over,
  };
}

/** Запись реестра Claude в живой форме; поле со значением undefined исчезает из JSON, как
 *  у фоновой сессии без tmux. */
function record(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: 13432,
    sessionId: SESSION_ID,
    cwd: CWD,
    startedAt: 1788445493026,
    procStart: PROC_START_UTC,
    version: '2.1.259',
    kind: 'interactive',
    tmux: PANE,
    name: 'sprutapp-93',
    status: 'idle',
    ...over,
  });
}

/** Реестр как каталог с файлами: имя → содержимое. */
function registry(files: Record<string, string>): Partial<TranscriptSources> {
  return {
    readDir: async (dir: string) => (dir === `${HOME}/.claude/sessions` ? Object.keys(files) : []),
    readHead: async (file: string) => {
      const body = files[file.slice(file.lastIndexOf('/') + 1)];
      // Реестр самоочищается: файл мог исчезнуть между readDir и чтением.
      if (body === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return body;
    },
  };
}

describe('resolve: панель Claude', () => {
  it('берёт файлы из записи реестра с этим адресом панели', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({
          '13432.json': record(),
          // Соседняя панель: запись живая и более поздняя — без привязки по адресу
          // выиграла бы она.
          '4360.json': record({
            pid: 4360,
            sessionId: '3b48b93a-9a54-42e4-8dfd-61606c71fbc8',
            cwd: '/Users/u/projects/Other',
            startedAt: 1789252259152,
            tmux: 'SprutApp2:@2.%2',
          }),
          // Фоновая сессия вовсе без поля tmux — в живом реестре такие есть.
          '47778.json': record({ pid: 47778, sessionId: '353d6219-23f0-4770-8d22-69ece8353d2e', tmux: undefined }),
        }),
        processTable: async () => [row(13432, localStart()), row(4360, localStart())],
      }),
    );
    expect(res).toEqual({ ok: true, agent: 'claude', files: [CURRENT], complete: true, live: true });
  });

  it('запись про другую панель с тем же каталогом не подставляется', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '4360.json': record({ pid: 4360, tmux: 'SprutApp2:@2.%2' }) }),
        processTable: async () => [row(4360, localStart())],
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'no-agent', detail: expect.stringContaining(PANE) });
  });

  it('имя сессии с дефисом и точкой разбирается: грамматика адреса общая с sessions.ts', async () => {
    const pane = 'my-proj.1:@11.%12';
    const res = await resolve(
      pane,
      sources({
        ...registry({ '13432.json': record({ tmux: pane }) }),
        processTable: async () => [row(13432, localStart())],
      }),
    );
    expect(res).toMatchObject({ ok: true, agent: 'claude', files: [CURRENT] });
  });

  it('сверяет время старта из реестра (UTC) с локальным временем процесса', async () => {
    const res = await resolve(
      PANE,
      sources({ ...registry({ '13432.json': record() }), processTable: async () => [row(13432, localStart())] }),
    );
    expect(res).toMatchObject({ ok: true, agent: 'claude' });
  });

  it('pid переиспользован: чужое время старта — запись не берётся', async () => {
    // Тот же циферблат, но в локальной зоне: момент на смещение зоны раньше — чужой процесс.
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record() }),
        processTable: async () => [row(13432, new Date(2026, 8, 3, 14, 24, 49))],
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });

  it('запись пережила агента: файл отдаём, если панель не моложе её, и помечаем live: false', async () => {
    const res = await resolve(PANE, sources({ ...registry({ '13432.json': record() }), ...olderPane() }));
    expect(res).toEqual({ ok: true, agent: 'claude', files: [CURRENT], complete: true, live: false });
  });

  it('панель моложе мёртвой записи: адрес переиспользован, чужая беседа не отдаётся', async () => {
    // Живой случай владельца: все записи реестра от умерших процессов, а адрес
    // «SprutApp:@0.%0» уже занят панелью нового сервера tmux.
    const res = await resolve(
      PANE,
      sources({ ...registry({ '13432.json': record() }), ...olderPane(new Date(2026, 8, 13, 10, 0, 0)) }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });

  it('мёртвая запись не опережает живой обход: панель с Codex отдаёт свой поток', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record() }),
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, new Date(2026, 8, 3, 17, 0, 0))],
        openFiles: async () => [ROOT_FILE],
        readHead: async (file: string) => (file.endsWith('13432.json') ? record() : ROOT_META),
      }),
    );
    expect(res).toMatchObject({ ok: true, agent: 'codex', files: [ROOT_FILE] });
  });

  it('из двух живых записей панели берётся более поздняя', async () => {
    const late = `${HOME}/.claude/projects/-Users-u-projects-Sprut-App/353d6219-23f0-4770-8d22-69ece8353d2e.jsonl`;
    const res = await resolve(
      PANE,
      sources({
        ...registry({
          '13432.json': record({ startedAt: 1788445493026 }),
          '30467.json': record({
            pid: 30467,
            sessionId: '353d6219-23f0-4770-8d22-69ece8353d2e',
            startedAt: 1789252259152,
          }),
        }),
        processTable: async () => [row(13432, localStart()), row(30467, localStart())],
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [late], complete: true });
  });

  it('из двух записей без живого процесса берётся более поздняя', async () => {
    const late = `${HOME}/.claude/projects/-Users-u-projects-Sprut-App/353d6219-23f0-4770-8d22-69ece8353d2e.jsonl`;
    const res = await resolve(
      PANE,
      sources({
        ...registry({
          '13432.json': record({ startedAt: 1788445493026 }),
          '30467.json': record({
            pid: 30467,
            sessionId: '353d6219-23f0-4770-8d22-69ece8353d2e',
            startedAt: 1789252259152,
          }),
        }),
        ...olderPane(),
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [late], live: false });
  });

  it('живая запись важнее более поздней, пережившей свой процесс', async () => {
    // Модуль отвечает, какой агент в панели РАБОТАЕТ: файл умершего вместо файла живого
    // был бы неверным ответом, даже если запись умершего новее.
    const res = await resolve(
      PANE,
      sources({
        ...registry({
          '13432.json': record({ startedAt: 1788445493026 }),
          '30467.json': record({
            pid: 30467,
            sessionId: '353d6219-23f0-4770-8d22-69ece8353d2e',
            startedAt: 1789252259152,
          }),
        }),
        processTable: async () => [row(13432, localStart())],
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [CURRENT], complete: true });
  });

  it('живой процесс без времени старта в записи — незнакомый формат, а не находка', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record({ procStart: undefined }) }),
        processTable: async () => [row(13432, localStart())],
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'unknown-format' });
  });

  it('транскрипта на диске ещё нет — своя причина, а не незнакомый формат', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record() }),
        processTable: async () => [row(13432, localStart())],
        isFile: async () => false,
      }),
    );
    // Формат тут знаком, путь собран по его правилу — на живых данных так выглядит
    // запущенная и ни разу не спрошенная сессия. Экрану ленты нужно сказать «беседа
    // пуста», а не «формат не разобран».
    expect(res).toMatchObject({ ok: false, reason: 'no-transcript', detail: expect.stringContaining(CURRENT) });
  });

  it('битые записи реестра пропускаются, а не роняют обход', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({
          'broken.json': '{не json',
          'empty.json': '',
          'notjson.txt': 'мусор',
          '13432.json': record(),
        }),
        processTable: async () => [row(13432, localStart())],
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [CURRENT] });
  });
});

describe('resolve: вся беседа — один файл (D01)', () => {
  it('продолженная сессия отдаётся текущим файлом: прежний не ищется и в ответ не идёт', async () => {
    // Живая пара с диска владельца: прежний файл существует, но форк скопировал беседу в
    // текущий — прежний в ленте был бы дублем, поэтому к нему даже не обращаются.
    const touched: string[] = [];
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record() }),
        processTable: async () => [row(13432, localStart())],
        isFile: async (file: string) => {
          touched.push(file);
          return true;
        },
      }),
    );
    expect(res).toEqual({ ok: true, agent: 'claude', files: [CURRENT], complete: true, live: true });
    expect(touched).toEqual([CURRENT]);
    expect(touched).not.toContain(PREV);
  });

  it('идентификатор сессии из реестра не уводит путь за каталог: отказ, а не чтение', async () => {
    // Запись пришла из чужого файла: идентификатор с переходами вверх обязан отбрасываться
    // ДО сборки пути, иначе он увёл бы чтение за каталог транскриптов.
    const touched: string[] = [];
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record({ sessionId: '../../../../etc/passwd' }) }),
        processTable: async () => [row(13432, localStart())],
        isFile: async (file: string) => {
          touched.push(file);
          return true;
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'unknown-format' });
    expect(touched).toEqual([]);
  });
});

describe('resolve: панель Codex', () => {
  it('берёт корневой поток среди открытых файлов процесса панели и его потомков', async () => {
    let asked: number[] = [];
    const res = await resolve(
      PANE,
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        // Живая форма: в панели node-обёртка, rollout держит открытым её потомок.
        processTable: async () => [row(10608, localStart()), row(10632, localStart(), 10608)],
        openFiles: async (pids: number[]) => {
          asked = pids;
          // Среди открытых есть и чужой rollout вне каталога сессий — он новее корневого,
          // и без проверки каталога выиграл бы он.
          return ['/dev/ttys004', OUTSIDE_FILE, NESTED_FILE, ROOT_FILE];
        },
        readHead: async (file: string) =>
          file === ROOT_FILE ? ROOT_META : file === NESTED_FILE ? NESTED_META : OUTSIDE_META,
      }),
    );
    expect(res).toEqual({ ok: true, agent: 'codex', files: [ROOT_FILE], complete: true, live: true });
    expect(asked.sort()).toEqual([10608, 10632]);
  });

  it('корневой поток отпочкован от другого: полнота не подтверждена', async () => {
    const res = await resolve(
      PANE,
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, localStart())],
        openFiles: async () => [ROOT_FILE],
        readHead: async () => FORKED_META,
      }),
    );
    expect(res).toEqual({ ok: true, agent: 'codex', files: [ROOT_FILE], complete: false, live: true });
  });

  it('отрицательный ответ кэша протухает: оболочка сохраняет pid, когда в ней стартует агент', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 8, 13, 22, 0, 0).getTime();
    vi.setSystemTime(base);
    let calls = 0;
    let agentStarted = false;
    const src = (): Partial<TranscriptSources> =>
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, localStart())],
        openFiles: async () => {
          calls++;
          return agentStarted ? [ROOT_FILE] : ['/dev/ttys004'];
        },
        readHead: async () => ROOT_META,
      });

    expect(await resolve(PANE, src())).toMatchObject({ ok: false, reason: 'no-agent' });
    await resolve(PANE, src());
    expect(calls).toBe(1);

    // pid оболочки не меняется — ответ «агента нет» обязан протухнуть сам.
    agentStarted = true;
    vi.setSystemTime(base + 6000);
    expect(await resolve(PANE, src())).toMatchObject({ ok: true, agent: 'codex' });
    expect(calls).toBe(2);
  });

  it('первая строка rollout не session_meta — незнакомый формат', async () => {
    const res = await resolve(
      PANE,
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, localStart())],
        openFiles: async () => [ROOT_FILE],
        readHead: async () => '{"timestamp":"2026-09-05T19:24:44.000Z","type":"event_msg","payload":{}}\n',
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'unknown-format' });
  });

  it('обход открытых файлов недоступен — «определить не удалось»', async () => {
    const res = await resolve(
      PANE,
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, localStart())],
        openFiles: async () => {
          throw new Error('lsof: command not found');
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'lookup-failed' });
  });

  it('дорогой обход кэшируется на панель; смена процесса и clearCache сбрасывают запись', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 8, 13, 22, 0, 0).getTime();
    vi.setSystemTime(base);
    let calls = 0;
    let started = localStart();
    const src = (): Partial<TranscriptSources> =>
      sources({
        panePids: async () => new Map([[PANE, 10608]]),
        processTable: async () => [row(10608, started)],
        openFiles: async () => {
          calls++;
          return [ROOT_FILE];
        },
        readHead: async () => ROOT_META,
      });

    await resolve(PANE, src());
    await resolve(PANE, src());
    expect(calls).toBe(1);

    // Тот же pid, другой процесс. Снимок общих источников живёт секунду — сдвигаем часы.
    started = new Date(2026, 8, 12, 22, 30, 48);
    vi.setSystemTime(base + 5000);
    await resolve(PANE, src());
    expect(calls).toBe(2);

    clearCache();
    await resolve(PANE, src());
    expect(calls).toBe(3);
  });

  it('запись кэша об исчезнувшей панели выселяется', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 8, 13, 22, 0, 0).getTime();
    vi.setSystemTime(base);
    let calls = 0;
    let present = true;
    const src = (): Partial<TranscriptSources> =>
      sources({
        panePids: async () => (present ? new Map([[PANE, 10608]]) : new Map<string, number>()),
        processTable: async () => [row(10608, localStart())],
        openFiles: async () => {
          calls++;
          return [ROOT_FILE];
        },
        readHead: async () => ROOT_META,
      });

    await resolve(PANE, src());
    expect(calls).toBe(1);

    // Обе проверки укладываются в срок записи кэша: повторный обход объясним только тем,
    // что запись выселена вместе с исчезнувшей панелью, а не тем, что она протухла.
    present = false;
    vi.setSystemTime(base + 1500);
    expect(await resolve(PANE, src())).toMatchObject({ ok: false, reason: 'lookup-failed' });

    present = true;
    vi.setSystemTime(base + 3000);
    await resolve(PANE, src());
    expect(calls).toBe(2);
  });
});

describe('resolve: цена обхода', () => {
  it('обход, начатый до истечения снимка, не удваивает чтения даже на медленном источнике', async () => {
    const codexPane = 'Codex:@1.%1';
    let dirs = 0;
    let tables = 0;
    let panes = 0;
    // Источник отвечает дольше срока снимка — ровно та нагрузка, ради которой снимок заведён.
    const slow = <T>(value: T): Promise<T> => new Promise((done) => setTimeout(() => done(value), 1200));
    const shared = sources({
      readDir: async () => {
        dirs++;
        return slow(['13432.json']);
      },
      readHead: async (file: string) => (file.endsWith('13432.json') ? record() : ROOT_META),
      processTable: async () => {
        tables++;
        return slow([row(13432, localStart()), row(10608, localStart())]);
      },
      panePids: async () => {
        panes++;
        return slow(new Map([[codexPane, 10608]]));
      },
      openFiles: async () => [ROOT_FILE],
    });

    const first = resolve(PANE, shared);
    // Второй обход стартует, пока первый ещё висит на чтении, а срок снимка уже вышел.
    await new Promise((done) => setTimeout(done, 1100));
    const second = resolve(codexPane, shared);
    expect(await first).toMatchObject({ ok: true, agent: 'claude', files: [CURRENT] });
    expect(await second).toMatchObject({ ok: true, agent: 'codex', files: [ROOT_FILE] });
    // Третий обход идёт уже после того, как чтения завершились: срок снимка считается с их
    // завершения, а не с создания, поэтому данные ещё свежие и перечитывать нечего.
    expect(await resolve(PANE, shared)).toMatchObject({ ok: true, agent: 'claude' });
    expect({ dirs, tables, panes }).toEqual({ dirs: 1, tables: 1, panes: 1 });
  });

  it('снимок не переживает смену источников: второй вызов отвечает по своим подменам', async () => {
    // Часы стоят, срок снимка не истёк — разойтись ответы могут только потому, что снимок
    // знает, чьи данные держит.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 13, 22, 0, 0).getTime());
    const withAgent = sources({
      ...registry({ '13432.json': record() }),
      processTable: async () => [row(13432, localStart())],
    });
    expect(await resolve(PANE, withAgent)).toMatchObject({ ok: true, agent: 'claude', files: [CURRENT] });
    expect(await resolve(PANE, sources())).toMatchObject({ ok: false, reason: 'no-agent' });
  });
});

describe('resolve: клиент подключён к фоновой сессии', () => {
  // Живая форма 14.09.2026: у фоновой сессии (`kind: "bg"`) поля `tmux` в реестре нет
  // вовсе, а в панели сидит её клиент — `claude attach 353d6219`. По адресу панели реестр
  // про такую сессию не знает ничего, и до этой ветки панель отвечала «агента нет».
  const BG_ID = '353d6219-23f0-4770-8d22-69ece8353d2e';
  const BG_FILE = `${HOME}/.claude/projects/-Users-u-projects-Sprut-App/${BG_ID}.jsonl`;
  const bg = (over: Record<string, unknown> = {}): string =>
    record({ pid: 47778, sessionId: BG_ID, kind: 'bg', tmux: undefined, ...over });
  /** Оболочка панели и её потомок-клиент. */
  const withClient = (args: string, over: Partial<TranscriptSources> = {}): Partial<TranscriptSources> =>
    sources({
      ...registry({ '47778.json': bg() }),
      panePids: async () => new Map([[PANE, 900]]),
      processTable: async () => [
        row(900, new Date(2026, 8, 3, 17, 0, 0)),
        row(49941, new Date(2026, 8, 3, 17, 30, 0), 900, args),
        row(47778, localStart()),
      ],
      ...over,
    });

  it('клиент в панели называет сессию началом её идентификатора — отдаём её беседу', async () => {
    const res = await resolve(PANE, withClient('claude attach 353d6219'));
    expect(res).toEqual({ ok: true, agent: 'claude', files: [BG_FILE], complete: true, live: true });
  });

  it('фоновый агент завершился, а клиент остался — файл тот же, но не живой', async () => {
    const res = await resolve(
      PANE,
      withClient('claude attach 353d6219', {
        processTable: async () => [
          row(900, new Date(2026, 8, 3, 17, 0, 0)),
          row(49941, new Date(2026, 8, 3, 17, 30, 0), 900, 'claude attach 353d6219'),
        ],
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [BG_FILE], live: false });
  });

  it('своя запись панели старше клиента: беседу отдаёт агент этой панели, а не чужой', async () => {
    const res = await resolve(
      PANE,
      withClient('claude attach 353d6219', {
        ...registry({ '47778.json': bg(), '13432.json': record() }),
        processTable: async () => [
          row(900, new Date(2026, 8, 3, 17, 0, 0)),
          row(49941, new Date(2026, 8, 3, 17, 30, 0), 900, 'claude attach 353d6219'),
          row(13432, localStart()),
          row(47778, localStart()),
        ],
      }),
    );
    expect(res).toMatchObject({ ok: true, files: [CURRENT] });
  });

  it('начало подходит двум сессиям — не угадываем', async () => {
    const twin = bg({ pid: 47779, sessionId: '353d6219-0000-4000-8000-000000000000' });
    const res = await resolve(
      PANE,
      withClient('claude attach 353d6219', {
        ...registry({ '47778.json': bg(), '47779.json': twin }),
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });

  it('идентификатор в аргументах не claude — не наш случай (хеш в git те же шестнадцать знаков)', async () => {
    const res = await resolve(PANE, withClient('git log 353d6219'));
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });

  it('аргумент короче восьми знаков не берём', async () => {
    const res = await resolve(PANE, withClient('claude attach 353d'));
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });

  it('источник не отдал аргументов — прежние способы работают как работали', async () => {
    const res = await resolve(
      PANE,
      withClient('claude attach 353d6219', {
        processTable: async () => [row(900, new Date(2026, 8, 3, 17, 0, 0)), row(49941, localStart(), 900)],
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'no-agent' });
  });
});

describe('resolve: различимый отказ', () => {
  it('незнакомый адрес панели — отказ по формату, без обхода источников', async () => {
    let touched = 0;
    const res = await resolve(
      '%6',
      sources({
        readDir: async () => {
          touched++;
          return [];
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'unknown-format', detail: expect.stringContaining('%6') });
    expect(touched).toBe(0);
  });

  it('имя сессии не по общему правилу — отказ по формату, а не «агента нет»', async () => {
    // Существующие имена не ограничены длиной формы создания, но управляющие запрещены.
    for (const pane of ['bad\u0007name:@1.%1'])
      expect(await resolve(pane, sources())).toMatchObject({ ok: false, reason: 'unknown-format' });
  });

  it('длинное существующее имя проходит проверку формата', async () => {
    const pane = `${'x'.repeat(41)}:@1.%1`;
    const result = await resolve(pane, sources());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe('unknown-format');
  });

  it('ни реестра, ни агента в панели — «агента нет»', async () => {
    const res = await resolve(PANE, sources());
    expect(res).toEqual({ ok: false, reason: 'no-agent', detail: expect.stringContaining(PANE) });
  });

  it('панели нет на сокете — «смотреть негде», а не «в панели нет агента»', async () => {
    const res = await resolve(
      PANE,
      sources({ panePids: async () => new Map([['Other:@1.%1', 900]]) }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'lookup-failed', detail: expect.stringContaining('1 панел') });
  });

  it('сокет не отдал ни одной панели — причина называет именно это', async () => {
    const res = await resolve(PANE, sources({ panePids: async () => new Map<string, number>() }));
    expect(res).toMatchObject({ ok: false, reason: 'lookup-failed', detail: expect.stringContaining('ни одной') });
  });

  it('каталог реестра недоступен — «определить не удалось», а не «агента нет»', async () => {
    const res = await resolve(
      PANE,
      sources({
        readDir: async () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'lookup-failed' });
  });

  it('опрос процессов сорвался — «определить не удалось», а не «процесса нет»', async () => {
    const res = await resolve(
      PANE,
      sources({
        ...registry({ '13432.json': record() }),
        processTable: async () => {
          throw Object.assign(new Error('ps: killed'), { code: null, killed: true });
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'lookup-failed' });
  });
});
