// Шов: sessionFeed() над подложенными файлами. tmux и определитель первого этапа —
// подменяемые источники, поэтому ни живой сессии, ни живого агента здесь нет; файлы
// беседы настоящие, во временном каталоге. Формы строк сняты с живых данных владельца
// 14.09.2026: Codex — rollout-<стамп>-<поток>.jsonl, первая строка session_meta с полями
// id и forked_from_id. Чужие беседы не копируются: каждая строка собрана вручную.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sessionFeed, type SessionFeedSources } from '../src/session-feed.js';
import type { TranscriptResult } from '../src/agent-transcript.js';

const SESSION = 'work';
const PANE = 'work:@1.%3';

let home: string;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-sfeed-'));
});

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** Ответ определителя: агент, один файл беседы и два его поля. */
const found = (agent: 'claude' | 'codex', file: string, complete: boolean, live: boolean): TranscriptResult => ({
  ok: true,
  agent,
  files: [file],
  complete,
  live,
});

/** Источники: дом — временный каталог, панель и определитель подменены. */
const sources = (result: TranscriptResult, over: Partial<SessionFeedSources> = {}): Partial<SessionFeedSources> => ({
  home,
  activePane: async () => PANE,
  resolve: async () => result,
  ...over,
});

/** Файл Claude из реплик человека: путь произвольный, его называет определитель. */
const claudeFile = (name: string, texts: string[]): string => {
  const file = path.join(home, name);
  const lines = texts.map((text, i) =>
    JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: text },
      uuid: `u${i + 1}`,
      timestamp: new Date(Date.UTC(2026, 8, 14, 10, i)).toISOString(),
      cwd: '/w',
      sessionId: 's',
    }),
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('sessionFeed: имя сессии', () => {
  it('отдаёт страницу ленты по имени сессии, приклеив complete и live определителя', async () => {
    const file = claudeFile('claude-basic.jsonl', ['привет', 'как дела']);
    const r = await sessionFeed(SESSION, {}, sources(found('claude', file, true, false)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agent).toBe('claude');
    expect(r.entries.map((e) => e.text)).toEqual(['привет', 'как дела']);
    expect(r.complete).toBe(true);
    expect(r.live).toBe(false);
    expect(r.bof).toBe(true);
    expect(r.eof).toBe(true);
  });

  it('спрашивает панель по имени сессии и передаёт определителю её адрес', async () => {
    const file = claudeFile('claude-pane.jsonl', ['один']);
    const asked: string[] = [];
    const panes: string[] = [];
    await sessionFeed(
      SESSION,
      {},
      sources(found('claude', file, true, true), {
        activePane: async (session) => {
          asked.push(session);
          return PANE;
        },
        resolve: async (pane) => {
          panes.push(pane);
          return found('claude', file, true, true);
        },
      }),
    );
    expect(asked).toEqual([SESSION]);
    expect(panes).toEqual([PANE]);
  });
});

describe('sessionFeed: файлы определителя', () => {
  it('читает текущий файл беседы — последний в списке, а не единственный', async () => {
    const older = claudeFile('claude-older.jsonl', ['старое']);
    const middle = claudeFile('claude-middle.jsonl', ['среднее']);
    const current = claudeFile('claude-current.jsonl', ['текущее']);
    // Определитель документирует порядок «от самого раннего к текущему».
    const r = await sessionFeed(
      SESSION,
      {},
      sources({ ok: true, agent: 'claude', files: [older, middle, current], complete: true, live: true }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(['текущее']);
  });
});

describe('sessionFeed: отказы', () => {
  it('доносит причину определителя как есть, без переименования', async () => {
    const r = await sessionFeed(
      SESSION,
      {},
      sources({ ok: false, reason: 'no-agent', detail: 'В панели нет агента' }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('no-agent');
    expect(r.detail).toBe('В панели нет агента');
  });

  it('без активной панели отвечает lookup-failed, а не «агента нет»', async () => {
    const file = claudeFile('claude-nopane.jsonl', ['один']);
    const r = await sessionFeed(
      SESSION,
      {},
      sources(found('claude', file, true, true), { activePane: async () => undefined }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('lookup-failed');
    expect(r.detail).toContain(SESSION);
  });

  it('сбой tmux доезжает как lookup-failed с текстом сбоя', async () => {
    const file = claudeFile('claude-tmuxfail.jsonl', ['один']);
    const r = await sessionFeed(
      SESSION,
      {},
      sources(found('claude', file, true, true), {
        activePane: async () => {
          throw new Error('no server running on /tmp/tmux-501/termhub');
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('lookup-failed');
    expect(r.detail).toContain('no server running');
  });
});

/** Поток Codex: правдоподобный идентификатор, различающийся последней парой знаков. */
const thread = (n: number): string => `01a07307-c04e-7a62-8322-3fa3ce8122${String(n).padStart(2, '0')}`;

/** Файл Codex в каталоге сессий: имя несёт поток, первая строка — session_meta. */
const codexFile = (n: number, forkedFrom: string | undefined, texts: string[]): string => {
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', String(14 - n).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const id = thread(n);
  const file = path.join(dir, `rollout-2026-09-${String(14 - n).padStart(2, '0')}T10-00-00-${id}.jsonl`);
  const at = new Date(Date.UTC(2026, 8, 14 - n, 10)).toISOString();
  const meta = {
    timestamp: at,
    type: 'session_meta',
    payload: {
      session_id: id,
      id,
      timestamp: at,
      cwd: '/w',
      originator: 'codex-tui',
      source: 'cli',
      ...(forkedFrom ? { forked_from_id: forkedFrom } : {}),
    },
  };
  const lines = [JSON.stringify(meta)].concat(
    texts.map((text, i) =>
      JSON.stringify({
        timestamp: new Date(Date.UTC(2026, 8, 14 - n, 10, i + 1)).toISOString(),
        ordinal: i + 1,
        type: 'response_item',
        payload: { type: 'message', id: `${id}-${i + 1}`, role: 'user', content: [{ type: 'input_text', text }] },
      }),
    ),
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('sessionFeed: цепочка Codex', () => {
  it('дочитывает беседу в файле-родителе и помечает склейку записью chain', async () => {
    const parent = codexFile(1, undefined, ['п1', 'п2', 'п3']);
    const child = codexFile(0, thread(1), ['д1', 'д2']);
    expect(parent).not.toBe(child);
    const r = await sessionFeed(SESSION, { limit: 10 }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(['п1', 'п2', 'п3', '', 'д1', 'д2']);
    const seam = r.entries[3];
    expect(seam.kind).toBe('note');
    expect(seam.note).toBe('chain');
    expect(seam.at).toBe(Date.parse('2026-09-14T10:01:00.000Z'));
    expect(r.bof).toBe(true);
    expect(r.eof).toBe(true);
    // complete и live — как их отдал определитель, без пересчёта по цепочке.
    expect(r.complete).toBe(false);
    expect(r.live).toBe(true);
  });

  it('курсор с границы файлов не теряет позицию: страница продолжается в родителе', async () => {
    const parent = codexFile(3, undefined, ['п1', 'п2', 'п3']);
    const child = codexFile(2, thread(3), ['д1', 'д2']);
    expect(parent).not.toBe(child);
    const first = await sessionFeed(SESSION, { limit: 2 }, sources(found('codex', child, false, true)));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.entries.map((e) => e.text)).toEqual(['д1', 'д2']);
    // Начало беседы не достигнуто: впереди файл-родитель, и лента об этом не врёт.
    expect(first.bof).toBe(false);

    const second = await sessionFeed(
      SESSION,
      { limit: 2, before: first.head },
      sources(found('codex', child, false, true)),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.entries.map((e) => e.text)).toEqual(['п2', 'п3', '']);
    expect(second.entries[2].note).toBe('chain');
    expect(second.bof).toBe(false);

    const third = await sessionFeed(
      SESSION,
      { limit: 2, before: second.head },
      sources(found('codex', child, false, true)),
    );
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.entries.map((e) => e.text)).toEqual(['п1']);
    expect(third.bof).toBe(true);
  });

  it('глубже десяти файлов не идёт: цепочка обрывается, а не крутится', async () => {
    let last: string | undefined;
    for (let n = 15; n >= 4; n -= 1) last = codexFile(n, n === 15 ? undefined : thread(n + 1), [`f${n}`]);
    expect(last).toBeDefined();
    const src = sources(found('codex', last as string, false, true));
    const r = await sessionFeed(SESSION, { limit: 100 }, src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const texts = r.entries.filter((e) => e.kind !== 'note').map((e) => e.text);
    expect(texts).toEqual(['f13', 'f12', 'f11', 'f10', 'f9', 'f8', 'f7', 'f6', 'f5', 'f4']);
    // Девять склеек между десятью файлами и десятая — на месте обрыва по пределу глубины.
    expect(r.entries.filter((e) => e.note === 'chain').length).toBe(10);
    expect(r.entries[0].note).toBe('chain');
    // Дальше лента не пойдёт, и листать незачем: `bof` останавливает клиента, а веха
    // называет причину остановки (§7).
    expect(r.bof).toBe(true);

    // А если клиент всё же полистал дальше — новой страницы нет и прежняя не повторяется:
    // иначе предел глубины сам стал бы той петлёй, против которой он и введён.
    const next = await sessionFeed(SESSION, { limit: 100, before: r.head }, src);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.entries).toEqual([]);
    expect(next.bof).toBe(true);
  });

  it('курсор, которого нет ни в одном файле цепочки, остаётся cursor-stale', async () => {
    const parent = codexFile(17, undefined, ['п1']);
    const child = codexFile(16, thread(17), ['д1']);
    expect(parent).not.toBe(child);
    const r = await sessionFeed(SESSION, { before: '999999999:0' }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('cursor-stale');
  });
});

describe('sessionFeed: запрос вперёд', () => {
  it('after не тянет цепочку: назад по ней ходит только запрос назад', async () => {
    const parent = codexFile(19, undefined, ['п1', 'п2']);
    const child = codexFile(18, thread(19), ['д1', 'д2']);
    expect(parent).not.toBe(child);
    // Курсор на начало файла-потомка: по §4 это «<inode>:<смещение>», и начало файла —
    // единственное место, где запрос вперёд упирается в ту же границу, что и запрос назад.
    const start = `${fs.statSync(child).ino}:0`;
    const r = await sessionFeed(SESSION, { limit: 10, after: start }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(['д1', 'д2']);
    expect(r.entries.some((e) => e.note === 'chain')).toBe(false);
  });
});

/** Файл, названный одним потоком, а внутри записанный другим: так выглядит чужая беседа
 *  с похожим именем. */
const decoyFile = (nameN: number, metaN: number, texts: string[]): string => {
  const real = codexFile(metaN, undefined, texts);
  const dir = path.dirname(real);
  const file = path.join(dir, `rollout-2026-09-01T10-00-00-${thread(nameN)}.jsonl`);
  fs.renameSync(real, file);
  return file;
};

describe('sessionFeed: обрыв цепочки по данным', () => {
  it('родителя нет на диске — лента кончается на потомке, а не отказом', async () => {
    const child = codexFile(21, thread(22), ['д1', 'д2']);
    const r = await sessionFeed(SESSION, { limit: 10 }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(['д1', 'д2']);
    expect(r.entries.some((e) => e.note === 'chain')).toBe(false);
    expect(r.bof).toBe(true);
  });

  it('у файла с подходящим именем другой поток — чужая беседа в ленту не едет', async () => {
    const decoy = decoyFile(24, 25, ['ч1', 'ч2']);
    const child = codexFile(23, thread(24), ['д1']);
    expect(decoy).toContain(thread(24));
    const r = await sessionFeed(SESSION, { limit: 10 }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.text)).toEqual(['д1']);
    expect(r.bof).toBe(true);
  });

  it('родитель нечитаем — лента отдаёт показанное, а не отказ', async () => {
    const parent = codexFile(27, undefined, ['п1']);
    const child = codexFile(26, thread(27), ['д1']);
    fs.chmodSync(parent, 0o000);
    try {
      const r = await sessionFeed(SESSION, { limit: 10 }, sources(found('codex', child, false, true)));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.entries.map((e) => e.text)).toEqual(['д1']);
      expect(r.bof).toBe(true);
    } finally {
      fs.chmodSync(parent, 0o600);
    }
  });

  it('родитель пуст — склейки нет: за ней нечему ехать', async () => {
    const parent = codexFile(29, undefined, []);
    const child = codexFile(28, thread(29), ['д1']);
    expect(parent).not.toBe(child);
    const r = await sessionFeed(SESSION, { limit: 10 }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.map((e) => e.note ?? e.text)).toEqual(['д1']);
    expect(r.bof).toBe(true);
  });
});

describe('sessionFeed: пределы и обход каталога', () => {
  it('страница со склейкой не перерастает потолок ответа', async () => {
    const big = (prefix: string): string[] => Array.from({ length: 100 }, (_, i) => `${prefix}${i} ${'y'.repeat(9000)}`);
    const parent = codexFile(31, undefined, big('п'));
    const child = codexFile(30, thread(31), big('д'));
    expect(parent).not.toBe(child);
    const r = await sessionFeed(SESSION, { limit: 200 }, sources(found('codex', child, false, true)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bytes = r.entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0);
    expect(bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(r.entries.every((e) => e.text.startsWith('д'))).toBe(true);
    // Начало беседы не достигнуто: родитель не влез в бюджет и приедет следующей страницей.
    expect(r.bof).toBe(false);
  });

  it('каталог сессий обходится один раз за запрос, сколько бы файлов ни склеилось', async () => {
    for (let n = 41; n >= 33; n -= 1) codexFile(n, n === 41 ? undefined : thread(n + 1), [`g${n}`]);
    const child = codexFile(32, thread(33), ['д1']);
    let walks = 0;
    const r = await sessionFeed(
      SESSION,
      { limit: 100 },
      sources(found('codex', child, false, true), {
        sessionFiles: async (dir: string) => {
          walks += 1;
          return fs
            .readdirSync(dir, { recursive: true })
            .map((name) => String(name))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => path.join(dir, name));
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries.filter((e) => e.kind !== 'note').length).toBe(10);
    expect(walks).toBe(1);
  });
});
