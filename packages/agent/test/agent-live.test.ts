// Шов: `sessionLive` / `sessionAct` над подменёнными источниками — без tmux и без
// агентов. Экран «панели» — снимки живых агентов из fixtures/screens; подставной агент
// меняет снимок в ответ на клавиши, а тест сверяет, какие клавиши ушли и в каком порядке.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentId, ChatAction, ScreenState } from '@termhub/protocol/chat';

import { agentInfo, sessionAct, sessionLive, type LiveSources } from '../src/agent-live.js';
import { profileOf } from '../src/agent-profiles.js';
import { readScreen } from '../src/agent-screen.js';
import type { TranscriptResult } from '../src/agent-transcript.js';

const ROOT = new URL('./fixtures/screens/', import.meta.url).pathname;

function shot(agent: AgentId, name: string): string[] {
  return readFileSync(`${ROOT}${agent}/${name}.txt`, 'utf8').split('\n');
}

/** Отпечаток вопроса на снимке — тем, чем его считает распознавание. */
function stampOf(agent: AgentId, name: string): string {
  return readScreen(shot(agent, name), profileOf(agent)).question!.stamp;
}

const PANE = 'work:@1.%1';

interface Fake {
  src: Partial<LiveSources>;
  /** Что ушло в панель, по порядку: клавиши как строка, вставка — `paste:<текст>`. */
  sent: string[];
  captures: number;
  resolves: number;
}

/** Подставная панель. `react(что ушло, номер посылки)` называет следующий экран: имя
 *  снимка или готовые строки; `undefined` — экран не изменился. */
function fake(
  agent: AgentId,
  start: string | string[],
  react: (sent: string, index: number) => string | string[] | undefined = () => undefined,
  over: Partial<LiveSources> & { found?: TranscriptResult; command?: string } = {},
): Fake {
  let lines = typeof start === 'string' ? shot(agent, start) : start;
  const state: Fake = { src: {}, sent: [], captures: 0, resolves: 0 };
  const push = (what: string): void => {
    state.sent.push(what);
    const next = react(what, state.sent.length - 1);
    if (next !== undefined) lines = typeof next === 'string' ? shot(agent, next) : next;
  };
  state.src = {
    capture: async () => {
      state.captures++;
      return { lines, alt: agent === 'claude', cols: 100, rows: 32, pane: PANE, command: over.command ?? 'node' };
    },
    send: async (_session, bytes, pane) => {
      expect(pane).toBe(PANE);
      push(new TextDecoder().decode(bytes));
    },
    paste: async (_session, text, pane) => {
      expect(pane).toBe(PANE);
      push(`paste:${text}`);
    },
    resolve: async () => {
      state.resolves++;
      return over.found ?? { ok: true, agent, files: ['/nowhere/talk.jsonl'], complete: true, live: true };
    },
    version: over.version ?? (async () => ({ version: agent === 'claude' ? '2.1.322' : '0.167.0', model: 'Fable 5.2' })),
    sleep: async () => undefined,
  };
  return state;
}

/** Снимок строки ввода Claude с другим набранным текстом. */
function claudeInput(text: string): string[] {
  return shot('claude', 'input').map((line) => line.replace('hello draft text', text));
}

function act(f: Fake, action: ChatAction): ReturnType<typeof sessionAct> {
  return sessionAct('work', action, f.src);
}

function screenOf(result: Awaited<ReturnType<typeof sessionAct>>): ScreenState {
  if (!result.ok) throw new Error(`отказ: ${result.reason} — ${result.detail}`);
  return result.screen;
}

describe('sessionLive — что на экране агента', () => {
  it('отдаёт агента, версию, проверенность, модель, экран и списки режимов и моделей', async () => {
    const f = fake('claude', 'idle-plan');
    expect(await sessionLive('work', f.src)).toEqual({
      ok: true,
      agent: 'claude',
      version: '2.1.322',
      tested: true,
      model: 'Fable 5.2',
      screen: { kind: 'idle', mode: 'plan', input: '', agentCount: 2 },
      modes: [
        { id: 'manual', label: 'Manual' },
        { id: 'accept', label: 'Accept edits' },
        { id: 'plan', label: 'Plan' },
        { id: 'auto', label: 'Auto' },
      ],
      models: [
        { id: 'opus', label: 'Opus 5.5' },
        { id: 'fable', label: 'Fable 5.2' },
        { id: 'sonnet', label: 'Sonnet 5.5' },
        { id: 'haiku', label: 'Haiku 5.5' },
      ],
    });
    expect(f.sent).toEqual([]);
  });

  it('Codex: модель называет экран, непроверенная версия так и названа', async () => {
    const f = fake('codex', 'idle', undefined, { version: async () => ({ version: '0.999.0', model: 'из транскрипта' }) });
    const live = await sessionLive('work', f.src);
    expect(live).toMatchObject({ ok: true, agent: 'codex', version: '0.999.0', tested: false, model: 'GPT-6-Astra' });
  });

  it('вопрос на экране приезжает с вариантами и отпечатком', async () => {
    const live = await sessionLive('work', fake('claude', 'permission').src);
    expect(live).toMatchObject({
      ok: true,
      screen: { kind: 'permission', question: { title: 'Do you want to create hello.txt?' } },
    });
  });

  it('сессия без агента, с opencode и несуществующая — отказ принятой причиной', async () => {
    const none = fake('claude', 'shell', undefined, { found: { ok: false, reason: 'no-agent', detail: 'pane runs zsh' } });
    expect(await sessionLive('work', none.src)).toEqual({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' });

    const open = fake('claude', 'shell', undefined, {
      found: { ok: true, agent: 'opencode', files: ['/db'], session: 's', complete: true, live: true },
    });
    expect(await sessionLive('work', open.src)).toMatchObject({ ok: false, reason: 'unknown-format' });

    const gone = fake('claude', 'idle');
    gone.src.capture = async () => {
      throw new Error("can't find session: work");
    };
    expect(await sessionLive('work', gone.src)).toMatchObject({ ok: false, reason: 'lookup-failed' });
    expect(gone.resolves).toBe(0);

    expect(await sessionLive('bad\nname', gone.src)).toMatchObject({ ok: false, reason: 'lookup-failed' });
  });

  it('беседы ещё нет, а в панели Claude — чат работает: первый запрос писать можно', async () => {
    const found: TranscriptResult = { ok: false, reason: 'no-transcript', detail: 'ещё нет' };
    const f = fake('claude', 'idle', undefined, { found, command: '2.1.322', version: agentInfo });
    expect(await sessionLive('work', f.src)).toMatchObject({ ok: true, agent: 'claude', version: '2.1.322', tested: true });
    // Та же причина без Claude в панели остаётся отказом.
    const other = fake('claude', 'idle', undefined, { found, command: 'node' });
    expect(await sessionLive('work', other.src)).toEqual({ ok: false, reason: 'no-transcript', detail: 'ещё нет' });
  });
});

describe('agentInfo — версия и модель из транскрипта', () => {
  it('Claude: версия и модель последнего ответа; Codex: версия из session_meta, модель из turn_context', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'termhub-live-'));
    try {
      const claude = path.join(dir, 'claude.jsonl');
      writeFileSync(
        claude,
        [
          '{"type":"user","version":"2.1.300","message":{"role":"user","content":"hi"}}',
          '{"type":"assistant","version":"2.1.322","message":{"model":"claude-sonnet-5-5","content":[]}}',
          '{"type":"assistant","version":"2.1.322","message":{"model":"<synthetic>","content":[]}}',
          '',
        ].join('\n'),
      );
      expect(await agentInfo('claude', claude, 'node')).toEqual({ version: '2.1.322', model: 'Sonnet 5.5' });
      // Команда панели — версия идущего процесса: она старше записанной в файле.
      expect(await agentInfo('claude', claude, '2.1.400')).toEqual({ version: '2.1.400', model: 'Sonnet 5.5' });

      const codex = path.join(dir, 'codex.jsonl');
      writeFileSync(
        codex,
        [
          '{"type":"session_meta","payload":{"id":"t1","cli_version":"0.167.0"}}',
          '{"type":"turn_context","payload":{"model":"gpt-6-astra"}}',
          '{"type":"turn_context","payload":{"model":"gpt-9-unknown"}}',
          '',
        ].join('\n'),
      );
      expect(await agentInfo('codex', codex, 'node')).toEqual({ version: '0.167.0', model: 'gpt-9-unknown' });
      expect(await agentInfo('codex', path.join(dir, 'missing.jsonl'), 'node')).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sessionAct — запрос', () => {
  it('вставляет текст одной вставкой и отправляет, убедившись, что он в строке', async () => {
    const f = fake('claude', 'idle', (sent) => (sent.startsWith('paste:') ? 'input-pasted' : sent === '\r' ? 'working' : undefined));
    const result = await act(f, { kind: 'prompt', text: 'первая\nвторая\n' });
    expect(f.sent).toEqual(['paste:первая\nвторая', '\r']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('при работающем агенте запрос уходит в его очередь тем же путём', async () => {
    const f = fake('claude', 'working', (sent) => (sent.startsWith('paste:') ? claudeInput('next') : 'queued'));
    const result = await act(f, { kind: 'prompt', text: 'next' });
    expect(f.sent).toEqual(['paste:next', '\r']);
    expect(screenOf(result)).toMatchObject({ kind: 'working', queued: 1 });
  });

  it('чужой текст в строке агента без over — stale, клавиши не отправлены', async () => {
    const f = fake('claude', 'input');
    expect(await act(f, { kind: 'prompt', text: 'привет' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([]);
  });

  it('с over строка стирается клавишами профиля и запрос отправляется', async () => {
    const f = fake('claude', 'input', (sent, index) =>
      index === 1 ? 'idle' : sent.startsWith('paste:') ? claudeInput('привет') : sent === '\r' ? 'working' : undefined,
    );
    const result = await act(f, { kind: 'prompt', text: 'привет', over: true });
    expect(f.sent).toEqual(['\x1b', '\x1b', 'paste:привет', '\r']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('строка не стёрлась — запрос не вставляется', async () => {
    const f = fake('claude', 'input', (_sent, index) => (index === 1 ? 'menu-rewind' : undefined));
    expect(await act(f, { kind: 'prompt', text: 'привет', over: true })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['\x1b', '\x1b']);
  });

  it('вставка не появилась в строке — клавиша отправки не нажимается', async () => {
    const f = fake('claude', 'idle');
    expect(await act(f, { kind: 'prompt', text: 'привет' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['paste:привет']);
  });

  it('пустой запрос и запрос на экране вопроса отвергаются без клавиш', async () => {
    const empty = fake('claude', 'idle');
    expect(await act(empty, { kind: 'prompt', text: ' \n ' })).toMatchObject({ ok: false, reason: 'unsupported' });
    const asked = fake('claude', 'question');
    expect(await act(asked, { kind: 'prompt', text: 'привет' })).toMatchObject({ ok: false, reason: 'stale' });
    expect([...empty.sent, ...asked.sent]).toEqual([]);
  });
});

describe('sessionAct — ответ на вопрос', () => {
  it('отпечаток не совпал с экраном — stale, клавиши не отправлены', async () => {
    const f = fake('claude', 'question');
    const other = stampOf('claude', 'permission');
    expect(await act(f, { kind: 'answer', stamp: other, option: '2' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([]);
  });

  it('отпечаток совпал — уходит клавиша именно этого варианта', async () => {
    const f = fake('claude', 'question', () => 'working');
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question'), option: '2' });
    expect(f.sent).toEqual(['2']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('запрос разрешения Codex отвечается так же', async () => {
    const f = fake('codex', 'permission', () => 'working');
    await act(f, { kind: 'answer', stamp: stampOf('codex', 'permission'), option: '3' });
    expect(f.sent).toEqual(['3']);
  });

  /** Диалог MCP без оформления с указателем на варианте `key`. */
  function mcpAt(key: string): string[] {
    const labels: Record<string, string> = { '2': 'Allow for this session', '3': 'Always allow', '4': 'Cancel' };
    return shot('codex', 'permission-mcp')
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''))
      .map((line) =>
        key === '1'
          ? line
          : line.replace('  › 1. Allow', '    1. Allow').replace(`    ${key}. ${labels[key]}`, `  › ${key}. ${labels[key]}`),
      );
  }

  // Замер на Codex 0.167.2: цифра в диалоге MCP отвечает сама, как в прочих диалогах, —
  // клавиши отправки после неё нет ни в одном исходе.
  it('запрос Codex на инструмент MCP: цифра отвечает сама — Enter не послан', async () => {
    const f = fake('codex', 'permission-mcp', () => 'working');
    const result = await act(f, { kind: 'answer', stamp: stampOf('codex', 'permission-mcp'), option: '2' });
    expect(f.sent).toEqual(['2']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('запрос Codex на инструмент MCP: указатель уже на выбранном варианте — та же цифра, без Enter', async () => {
    const f = fake('codex', 'permission-mcp', () => 'working');
    const result = await act(f, { kind: 'answer', stamp: stampOf('codex', 'permission-mcp'), option: '1' });
    expect(f.sent).toEqual(['1']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('запрос Codex на инструмент MCP: диалог после цифры остался — stale, Enter вдогонку не идёт', async () => {
    const stamp = stampOf('codex', 'permission-mcp');
    const still = fake('codex', 'permission-mcp');
    expect(await act(still, { kind: 'answer', stamp, option: '4' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(still.sent).toEqual(['4']);
    const moved = fake('codex', 'permission-mcp', () => mcpAt('4'));
    expect(await act(moved, { kind: 'answer', stamp, option: '4' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(moved.sent).toEqual(['4']);
  });

  it('неузнанный кадр после цифры — не успех: ответ ждёт экран, который узнан', async () => {
    const f = fake('codex', 'permission-mcp', () => ['  half-drawn frame']);
    // Два кадра перерисовки не узнаны, затем агент работает.
    const garbage = f.src.capture!;
    let after = 0;
    f.src.capture = async (session) => {
      if (f.sent.length > 0 && ++after > 2) return { ...(await garbage(session)), lines: shot('codex', 'working') };
      return garbage(session);
    };
    const result = await act(f, { kind: 'answer', stamp: stampOf('codex', 'permission-mcp'), option: '1' });
    expect(f.sent).toEqual(['1']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('экран после цифры так и не узнан — отказ stale, а не успех', async () => {
    const f = fake('claude', 'question', () => ['  half-drawn frame']);
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question'), option: '2' });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['2']);
  });

  it('вопрос Codex из нескольких: цифра отвечает, в ответе — следующий вопрос', async () => {
    const f = fake('codex', 'question-first-of-two', () => 'question-last-of-two');
    const result = await act(f, { kind: 'answer', stamp: stampOf('codex', 'question-first-of-two'), option: '2' });
    expect(f.sent).toEqual(['2']);
    expect(screenOf(result).question?.title).toBe('Which size do you prefer?');
  });

  it('запрос Codex на инструмент MCP: чужой отпечаток и неизвестный вариант — клавиши не идут', async () => {
    const f = fake('codex', 'permission-mcp');
    const other = stampOf('codex', 'permission');
    expect(await act(f, { kind: 'answer', stamp: other, option: '1' })).toMatchObject({ ok: false, reason: 'stale' });
    const stamp = stampOf('codex', 'permission-mcp');
    expect(await act(f, { kind: 'answer', stamp, option: '5' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await act(f, { kind: 'answer', stamp, text: 'yes' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(f.sent).toEqual([]);
  });

  it('варианта с такой клавишей нет, вопроса на экране нет — клавиши не идут', async () => {
    const f = fake('claude', 'question');
    const stamp = stampOf('claude', 'question');
    expect(await act(f, { kind: 'answer', stamp, option: '9' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await act(f, { kind: 'answer', stamp })).toMatchObject({ ok: false, reason: 'unsupported' });
    const idle = fake('claude', 'idle');
    expect(await act(idle, { kind: 'answer', stamp, option: '1' })).toMatchObject({ ok: false, reason: 'stale' });
    expect([...f.sent, ...idle.sent]).toEqual([]);
  });

  it('свой текст: набирается в строке свободного варианта и отправляется после проверки экрана', async () => {
    const f = fake('claude', 'question-free', (sent) => (sent === 'parrot' ? 'question-free-typed' : sent === '\r' ? 'idle' : undefined));
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question-free'), text: 'parrot' });
    expect(f.sent).toEqual(['parrot', '\r']);
    expect(screenOf(result).kind).toBe('idle');
  });

  it('свой текст: указатель не встал на свободный вариант — текст не набирается', async () => {
    const f = fake('claude', 'question');
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question'), text: 'другое' });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['4']);
  });

  it('свой текст: набранное не появилось — клавиша отправки не нажимается', async () => {
    const f = fake('claude', 'question-free');
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question-free'), text: 'parrot' });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['parrot']);
  });

  it('свой текст там, где вопрос его не допускает или в строке уже набрано, — отказ без клавиш', async () => {
    // Запрос разрешения Codex своего ответа не принимает (вопрос — принимает, заметкой).
    const codex = fake('codex', 'permission');
    expect(await act(codex, { kind: 'answer', stamp: stampOf('codex', 'permission'), text: 'teal' })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    const typed = fake('claude', 'question-free-typed');
    expect(
      await act(typed, { kind: 'answer', stamp: stampOf('claude', 'question-free-typed'), text: 'cat' }),
    ).toMatchObject({ ok: false, reason: 'stale' });
    expect([...codex.sent, ...typed.sent]).toEqual([]);
  });

  it('несколько отметок: переход к подтверждению и отправка, каждый шаг сверен с экраном', async () => {
    // На снимке отмечены 1 и 3 — их и просят: отметки не трогаются.
    const f = fake('claude', 'question-multi', (sent) => (sent === '\x1b[C' ? 'question-review' : sent === '1' ? 'idle' : undefined));
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question-multi'), options: ['1', '3'] });
    expect(f.sent).toEqual(['\x1b[C', '1']);
    expect(screenOf(result).kind).toBe('idle');
  });

  it('несколько отметок: отметка не встала — остановка, дальше клавиши не идут', async () => {
    const f = fake('claude', 'question-multi');
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question-multi'), options: ['1', '2', '3'] });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['2']);
  });

  it('несколько отметок: экран подтверждения не пришёл — отправка не нажимается', async () => {
    const f = fake('claude', 'question-multi', (sent) => (sent === '\x1b[C' ? 'question' : undefined));
    const result = await act(f, { kind: 'answer', stamp: stampOf('claude', 'question-multi'), options: ['1', '3'] });
    expect(result).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['\x1b[C']);
  });

  it('отметки на вопросе с одним ответом и один вариант на вопросе с отметками — unsupported', async () => {
    const single = fake('claude', 'question');
    expect(await act(single, { kind: 'answer', stamp: stampOf('claude', 'question'), options: ['1'] })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    const multi = fake('claude', 'question-multi');
    const stamp = stampOf('claude', 'question-multi');
    expect(await act(multi, { kind: 'answer', stamp, option: '1' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await act(multi, { kind: 'answer', stamp, options: ['1', '9'] })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect([...single.sent, ...multi.sent]).toEqual([]);
  });
});

describe('sessionAct — свой ответ Codex заметкой', () => {
  const DOWN = '\x1b[B';
  const stamp = (): string => stampOf('codex', 'question-described');

  /** Вопрос question-described без оформления: указатель на варианте `key`; `notes` —
   *  поле заметки открыто с этим текстом (пустая строка — заглушка тусклым, как на экране). */
  function codexQuestion(key: string, notes?: string): string[] {
    const lines = shot('codex', 'question-described')
      .map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
      .map((line) => line.replace(/^  › (\d\. )/, '    $1'))
      .map((line) => (line.startsWith(`    ${key}. `) ? `  › ${line.slice(4)}` : line));
    if (notes === undefined) return lines;
    const footer = lines.findIndex((line) => line.startsWith('  tab to add notes'));
    expect(footer).toBeGreaterThan(0);
    lines[footer] = '  tab or esc to clear notes | enter to submit answer';
    lines.splice(footer, 0, notes === '' ? '  \x1b[1m›\x1b[0m \x1b[2mAdd notes\x1b[0m' : `  › ${notes}`, '');
    return lines;
  }

  /** Подставной Codex: стрелка ведёт указатель вниз, Tab открывает заметку, текст в неё
   *  набирается, Enter отвечает. `broken` — шаг, который экран не подтверждает. */
  function codex(broken?: 'down' | 'tab' | 'text'): Fake {
    let at = 1;
    let notes: string | undefined;
    return fake('codex', 'question-described', (sent) => {
      if (sent === DOWN) {
        if (broken !== 'down' && at < 4) at++;
      } else if (sent === '\t') {
        if (broken !== 'tab') notes = '';
      } else if (sent === '\r') return 'working';
      else if (broken !== 'text' && notes !== undefined) notes += sent;
      return codexQuestion(String(at), notes);
    });
  }

  it('подставные экраны читаются тем же вопросом', () => {
    for (const lines of [codexQuestion('1'), codexQuestion('4'), codexQuestion('4', ''), codexQuestion('4', 'teal')]) {
      expect(readScreen(lines, profileOf('codex')).question?.stamp).toBe(stamp());
    }
    expect(readScreen(codexQuestion('4', ''), profileOf('codex')).question?.notes).toBe('');
    expect(readScreen(codexQuestion('4', 'teal'), profileOf('codex')).question?.notes).toBe('teal');
  });

  it('указатель ведётся стрелкой до «None of the above», Tab открывает заметку, текст, Enter', async () => {
    const f = codex();
    const result = await act(f, { kind: 'answer', stamp: stamp(), text: '  teal\ninstead ' });
    expect(f.sent).toEqual([DOWN, DOWN, DOWN, '\t', 'teal instead', '\r']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('указатель уже на «None of the above» — стрелок нет', async () => {
    const f = fake('codex', codexQuestion('4'), (sent) =>
      sent === '\t' ? codexQuestion('4', '') : sent === '\r' ? 'working' : codexQuestion('4', sent),
    );
    await act(f, { kind: 'answer', stamp: stamp(), text: 'teal' });
    expect(f.sent).toEqual(['\t', 'teal', '\r']);
  });

  it('указатель не сдвинулся — остановка после первой стрелки', async () => {
    const f = codex('down');
    expect(await act(f, { kind: 'answer', stamp: stamp(), text: 'teal' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([DOWN]);
  });

  it('поле заметки не открылось — текст не набирается', async () => {
    const f = codex('tab');
    expect(await act(f, { kind: 'answer', stamp: stamp(), text: 'teal' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([DOWN, DOWN, DOWN, '\t']);
  });

  it('набранное не появилось в заметке — Enter не нажимается', async () => {
    const f = codex('text');
    expect(await act(f, { kind: 'answer', stamp: stamp(), text: 'teal' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([DOWN, DOWN, DOWN, '\t', 'teal']);
  });

  it('в заметке уже набрано или она открыта на другом варианте — отказ без клавиш', async () => {
    const typed = fake('codex', 'question-notes-typed');
    expect(await act(typed, { kind: 'answer', stamp: stamp(), text: 'teal' })).toMatchObject({ ok: false, reason: 'stale' });
    const elsewhere = fake('codex', 'question-notes');
    expect(await act(elsewhere, { kind: 'answer', stamp: stamp(), text: 'teal' })).toMatchObject({ ok: false, reason: 'stale' });
    expect([...typed.sent, ...elsewhere.sent]).toEqual([]);
  });

  it('свой ответ на вопрос из нескольких, пустой текст и отметки у Codex — unsupported без клавиш', async () => {
    const several = fake('codex', 'question-first-of-two');
    const first = stampOf('codex', 'question-first-of-two');
    expect(await act(several, { kind: 'answer', stamp: first, text: 'kiwi' })).toMatchObject({ ok: false, reason: 'unsupported' });
    const one = fake('codex', 'question-described');
    expect(await act(one, { kind: 'answer', stamp: stamp(), text: '  ' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await act(one, { kind: 'answer', stamp: stamp(), options: ['1', '2'] })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect([...several.sent, ...one.sent]).toEqual([]);
  });
});

describe('sessionAct — переход между вопросами серии', () => {
  const RIGHT = '\x1b[C';
  const LEFT = '\x1b[D';
  const ON = '\x1b[38;5;16m\x1b[48;5;153m';
  const OFF = '\x1b[39m\x1b[49m';
  const NAMES = ['Животное', 'Цвет', 'Размер'];

  /** Снимок серии с текущим шагом `at` (1–3 — вопросы, 4 — отправка). */
  function series(at: number): string[] {
    if (at === 4) return shot('claude', 'question-series-review');
    const bar = `←  ${NAMES.map((name, i) => (i + 1 === at ? `${ON} ☐ ${name} ${OFF}` : ` ☐ ${name} `)).join('')} ✔ Submit  →`;
    return shot('claude', 'question-series').map((line) => (line.includes('✔ Submit') ? bar : line));
  }
  const stampAt = (at: number): string => readScreen(series(at), profileOf('claude')).question!.stamp;

  /** Подставной Claude: стрелки двигают текущий шаг. `stuck` — стрелки не действуют. */
  function claude(start: number, stuck = false): Fake {
    let at = start;
    return fake('claude', series(start), (sent) => {
      if (stuck) return undefined;
      if (sent === RIGHT && at < 4) at++;
      if (sent === LEFT && at > 1) at--;
      return series(at);
    });
  }

  it('подставные экраны читаются шагами серии', () => {
    expect([1, 2, 3, 4].map((at) => readScreen(series(at), profileOf('claude')).question!.step)).toEqual([1, 2, 3, 4]);
    expect(new Set([1, 2, 3].map(stampAt)).size).toBe(3);
  });

  it('вперёд — стрелка вправо на каждый шаг, в ответе экран нужного шага', async () => {
    const f = claude(1);
    const result = await act(f, { kind: 'step', stamp: stampAt(1), to: 3 });
    expect(f.sent).toEqual([RIGHT, RIGHT]);
    expect(screenOf(result).question).toMatchObject({ step: 3, stamp: stampAt(3) });
  });

  it('назад — стрелка влево; на шаг отправки — вправо до экрана подтверждения', async () => {
    const back = claude(3);
    expect(screenOf(await act(back, { kind: 'step', stamp: stampAt(3), to: 2 })).question?.step).toBe(2);
    expect(back.sent).toEqual([LEFT]);
    const submit = claude(3);
    const result = await act(submit, { kind: 'step', stamp: stampAt(3), to: 4 });
    expect(submit.sent).toEqual([RIGHT]);
    expect(screenOf(result).question?.title).toBe('Ready to submit your answers?');
  });

  it('уже на нужном шаге — клавиш нет', async () => {
    const f = claude(2);
    expect(screenOf(await act(f, { kind: 'step', stamp: stampAt(2), to: 2 })).question?.step).toBe(2);
    expect(f.sent).toEqual([]);
  });

  it('шаг не сменился после клавиши — остановка, дальше клавиши не идут', async () => {
    const f = claude(1, true);
    expect(await act(f, { kind: 'step', stamp: stampAt(1), to: 3 })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([RIGHT]);
  });

  it('чужой отпечаток — stale; шага нет, полосы нет или текущий не назван — unsupported; без клавиш', async () => {
    const f = claude(2);
    expect(await act(f, { kind: 'step', stamp: stampAt(1), to: 3 })).toMatchObject({ ok: false, reason: 'stale' });
    expect(await act(f, { kind: 'step', stamp: stampAt(2), to: 5 })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await act(f, { kind: 'step', stamp: stampAt(2), to: 0 })).toMatchObject({ ok: false, reason: 'unsupported' });
    const codex = fake('codex', 'question-described');
    expect(await act(codex, { kind: 'step', stamp: stampOf('codex', 'question-described'), to: 1 })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect([...f.sent, ...codex.sent]).toEqual([]);
  });

  it('ответ цифрой на вопрос серии: в ответе следующий вопрос', async () => {
    const f = fake('claude', series(2), () => series(3));
    const result = await act(f, { kind: 'answer', stamp: stampAt(2), option: '2' });
    expect(f.sent).toEqual(['2']);
    expect(screenOf(result).question?.step).toBe(3);
  });

  it('отпечаток одного вопроса серии к другому не подходит', async () => {
    const f = fake('claude', series(3));
    expect(await act(f, { kind: 'answer', stamp: stampAt(2), option: '1' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([]);
  });
});

describe('sessionAct — показать ожидающий вопрос', () => {
  it('экран говорит «вопрос ждёт» — уходит клавиша открытия из профиля, в ответе вопрос', async () => {
    const f = fake('codex', 'pending-side', () => 'pending-opened');
    const result = await act(f, { kind: 'show-question' });
    expect(f.sent).toEqual(['\x1f']);
    expect(screenOf(result)).toMatchObject({ kind: 'question', question: { title: 'Cats or dogs?' } });
  });

  it('признака на экране нет — stale без клавиш', async () => {
    for (const [agent, name] of [['codex', 'idle'], ['codex', 'question-described'], ['claude', 'idle']] as const) {
      const f = fake(agent, name);
      expect(await act(f, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
      expect(f.sent).toEqual([]);
    }
  });

  it('вопрос не открылся — отказ, клавиша ушла один раз', async () => {
    const f = fake('codex', 'pending-side');
    expect(await act(f, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['\x1f']);
    const elsewhere = fake('codex', 'pending-side', () => 'idle');
    expect(await act(elsewhere, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(elsewhere.sent).toEqual(['\x1f']);
  });
});

describe('sessionAct — вопрос в очереди отложенного ввода Codex (⇧← to answer)', () => {
  const SHIFT_LEFT = '\x1b[1;2D';
  const queued = (): string[] => shot('codex', 'pending-queued');

  it('клавишу выбирает приглашение на экране: Shift+←, а не Ctrl+/; вопрос открылся — в ответе он', async () => {
    const f = fake('codex', 'pending-queued', () => 'pending-queued-opened');
    const result = await act(f, { kind: 'show-question' });
    expect(f.sent).toEqual([SHIFT_LEFT]);
    expect(screenOf(result)).toMatchObject({ kind: 'question', question: { title: 'Cats or dogs?' } });
    // То же с таймером в строке счёта и с двумя вопросами: открывается первый.
    const two = fake('codex', 'pending-queued-two', () => 'pending-queued-first-of-two');
    expect(screenOf(await act(two, { kind: 'show-question' })).question?.title).toBe('Tea or coffee?');
    expect(two.sent).toEqual([SHIFT_LEFT]);
  });

  it('ответ на открытый вопрос очереди: цифра отвечает сама (замер)', async () => {
    const f = fake('codex', 'pending-queued-opened', () => 'working');
    const result = await act(f, { kind: 'answer', stamp: stampOf('codex', 'pending-queued-opened'), option: '2' });
    expect(f.sent).toEqual(['2']);
    expect(screenOf(result).kind).toBe('working');
  });

  it('свой ответ: цифра ставит указатель на «Other», текст набирается в его строке, Enter отвечает', async () => {
    const f = fake('codex', 'pending-queued-last-of-two', (sent) =>
      sent === '3' ? 'pending-queued-other' : sent === 'green' ? 'pending-queued-other-typed' : 'pending-queued-opened',
    );
    const stamp = stampOf('codex', 'pending-queued-last-of-two');
    const result = await act(f, { kind: 'answer', stamp, text: 'green' });
    expect(f.sent).toEqual(['3', 'green', '\r']);
    // После ответа Codex показывает следующий вопрос очереди.
    expect(screenOf(result).question?.title).toBe('Cats or dogs?');
    // В строке «Other» уже набран текст — чужое не дополняем.
    const typed = fake('codex', 'pending-queued-other-typed');
    expect(await act(typed, { kind: 'answer', stamp, text: 'more' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(typed.sent).toEqual([]);
  });

  it('после клавиши экран иной или не узнан — успех с фактическим экраном, клавиша одна', async () => {
    const other = fake('codex', 'pending-queued', () => 'menu-model');
    expect(screenOf(await act(other, { kind: 'show-question' }))).toMatchObject({ kind: 'menu', menu: 'model' });
    expect(other.sent).toEqual([SHIFT_LEFT]);

    const strange = fake('codex', 'pending-queued', () => ['', 'Answer the queued question', '', '  something new']);
    expect(await act(strange, { kind: 'show-question' })).toMatchObject({ ok: true, screen: { kind: 'unknown' } });
    expect(strange.sent).toEqual([SHIFT_LEFT]);

    // Блок ушёл, агент работает дальше — тоже фактический экран, без возвратных клавиш.
    const gone = fake('codex', 'pending-queued', () => 'working');
    const after = screenOf(await act(gone, { kind: 'show-question' }));
    expect(after.kind).toBe('working');
    expect(after.pending).toBeUndefined();
    expect(gone.sent).toEqual([SHIFT_LEFT]);
  });

  it('приглашение осталось на месте без изменений — stale, клавиша ушла один раз', async () => {
    const f = fake('codex', 'pending-queued');
    expect(await act(f, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([SHIFT_LEFT]);
    // Идёт только время в строке работы — приглашение то же.
    const ticking = fake('codex', 'pending-queued', () => queued().map((l) => l.replace('37m 06s', '37m 09s')));
    expect(await act(ticking, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(ticking.sent).toEqual([SHIFT_LEFT]);
  });

  it('вопросов в очереди стало меньше — приглашение изменилось: фактический экран', async () => {
    const two = queued().map((l) => l.replace('1 question', '2 questions'));
    const f = fake('codex', two, () => 'pending-queued');
    expect(screenOf(await act(f, { kind: 'show-question' }))).toMatchObject({ kind: 'working', pending: true });
    expect(f.sent).toEqual([SHIFT_LEFT]);
  });

  it('блока на экране нет — stale без клавиш', async () => {
    const f = fake('codex', 'working');
    expect(await act(f, { kind: 'show-question' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual([]);
  });
});

describe('sessionAct — прерывание, режим, модель, сжатие, строка агента', () => {
  it('interrupt шлёт клавишу прерывания работающему агенту', async () => {
    const f = fake('claude', 'working', () => 'idle');
    expect(screenOf(await act(f, { kind: 'interrupt' })).kind).toBe('idle');
    expect(f.sent).toEqual(['\x1b']);
  });

  it('interrupt работает и на неузнанном экране, а на ожидании ввода клавишу не шлёт', async () => {
    const unknown = fake('claude', 'shell');
    expect(await act(unknown, { kind: 'interrupt' })).toMatchObject({ ok: true, screen: { kind: 'unknown' } });
    expect(unknown.sent).toEqual(['\x1b']);
    const idle = fake('claude', 'idle');
    expect(await act(idle, { kind: 'interrupt' })).toMatchObject({ ok: true, screen: { kind: 'idle' } });
    expect(idle.sent).toEqual([]);
  });

  it('на экране unknown и menu любое действие, кроме interrupt, — stale без клавиш', async () => {
    const actions: ChatAction[] = [
      { kind: 'prompt', text: 'привет' },
      { kind: 'answer', stamp: 'x', option: '1' },
      { kind: 'mode', to: 'plan' },
      { kind: 'model', to: 'opus' },
      { kind: 'compact' },
      { kind: 'take-input' },
    ];
    for (const name of ['shell', 'menu-model']) {
      const f = fake('claude', name);
      for (const action of actions) expect(await act(f, action)).toMatchObject({ ok: false, reason: 'stale' });
      expect(f.sent).toEqual([]);
    }
  });

  it('mode жмёт клавишу цикла до нужного режима и отдаёт экран', async () => {
    const f = fake('claude', 'idle-accept', (_sent, index) => (index === 0 ? 'idle-plan' : 'idle-auto'));
    expect(screenOf(await act(f, { kind: 'mode', to: 'auto' })).mode).toBe('auto');
    expect(f.sent).toEqual(['\x1b[Z', '\x1b[Z']);
  });

  it('mode: уже нужный режим — клавиш нет; неизвестный режим — unsupported', async () => {
    const f = fake('claude', 'idle-plan');
    expect(screenOf(await act(f, { kind: 'mode', to: 'plan' })).mode).toBe('plan');
    expect(await act(f, { kind: 'mode', to: 'yolo' })).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(f.sent).toEqual([]);
  });

  it('mode: режим не сменился после нажатия — вслепую дальше не жмёт, отдаёт фактический экран', async () => {
    const f = fake('claude', 'idle-accept');
    expect(screenOf(await act(f, { kind: 'mode', to: 'auto' })).mode).toBe('accept');
    expect(f.sent).toEqual(['\x1b[Z']);
  });

  it('mode: нужного режима в круге нет — нажатий не больше числа режимов', async () => {
    // У учётной записи без auto круг короче: accept ↔ plan.
    const f = fake('claude', 'idle-accept', (_sent, index) => (index % 2 === 0 ? 'idle-plan' : 'idle-accept'));
    const result = await act(f, { kind: 'mode', to: 'auto' });
    expect(f.sent).toHaveLength(4);
    expect(screenOf(result).mode).toBe('accept');
  });

  it('model набирает команду меню моделей из профиля и отдаёт экран с меню', async () => {
    const f = fake('claude', 'idle', (sent) => (sent === '/model' ? claudeInput('/model') : sent === '\r' ? 'menu-model' : undefined));
    expect(screenOf(await act(f, { kind: 'model', to: 'opus' }))).toEqual({ kind: 'menu', menu: 'model' });
    expect(f.sent).toEqual(['/model', '\r']);
  });

  it('model: меню не открылось — ответ несёт фактический экран, а не выдуманное меню', async () => {
    const f = fake('claude', 'idle', (sent) => (sent === '/model' ? claudeInput('/model') : 'idle'));
    expect(screenOf(await act(f, { kind: 'model', to: 'opus' })).kind).toBe('idle');
  });

  it('compact шлёт команду сжатия из профиля; при работающем агенте отвергается', async () => {
    const f = fake('codex', 'idle', (sent) =>
      sent === '/compact' ? shot('codex', 'input').map((l) => l.replace('hello draft text', '/compact')) : 'working',
    );
    expect(screenOf(await act(f, { kind: 'compact' })).kind).toBe('working');
    expect(f.sent).toEqual(['/compact', '\r']);

    const busy = fake('claude', 'working');
    expect(await act(busy, { kind: 'compact' })).toMatchObject({ ok: false, reason: 'busy' });
    expect(busy.sent).toEqual([]);
  });

  it('команда не появилась в строке агента — клавиша отправки не нажимается', async () => {
    const f = fake('claude', 'idle', () => claudeInput('/mode'));
    expect(await act(f, { kind: 'compact' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['/compact']);
  });

  it('take-input возвращает текст строки агента и оставляет её пустой', async () => {
    const f = fake('claude', 'input', (_sent, index) => (index === 1 ? 'idle' : undefined));
    expect(await act(f, { kind: 'take-input' })).toEqual({
      ok: true,
      screen: { kind: 'idle', mode: 'auto', input: '', agentCount: 2 },
      taken: 'hello draft text',
    });
    expect(f.sent).toEqual(['\x1b', '\x1b']);
  });

  it('take-input: Codex стирает своей клавишей; пустая строка — без клавиш', async () => {
    const codex = fake('codex', 'input', () => 'idle');
    expect(await act(codex, { kind: 'take-input' })).toMatchObject({ ok: true, taken: 'hello draft text' });
    expect(codex.sent).toEqual(['\x03']);
    // На пустой строке те же клавиши открывают меню отката у Claude и закрывают Codex.
    const empty = fake('codex', 'idle');
    expect(await act(empty, { kind: 'take-input' })).toMatchObject({ ok: true, taken: '' });
    expect(empty.sent).toEqual([]);
  });

  it('take-input у работающего агента — busy: стирание там было бы прерыванием', async () => {
    const f = fake('codex', 'working-typing');
    expect(await act(f, { kind: 'take-input' })).toMatchObject({ ok: false, reason: 'busy' });
    expect(f.sent).toEqual([]);
  });

  it('активной стала другая панель — шаг не подтверждён, клавиши дальше не идут', async () => {
    const f = fake('claude', 'idle');
    const capture = f.src.capture!;
    let calls = 0;
    f.src.capture = async (session) => {
      const got = await capture(session);
      return ++calls > 1 ? { ...got, lines: claudeInput('привет'), pane: 'work:@1.%2' } : got;
    };
    expect(await act(f, { kind: 'prompt', text: 'привет' })).toMatchObject({ ok: false, reason: 'stale' });
    expect(f.sent).toEqual(['paste:привет']);
  });

  it('действия одной сессии идут по очереди и клавиши не перемешивают', async () => {
    const f = fake('claude', 'idle', (sent) => (sent.startsWith('paste:') ? claudeInput('x') : 'idle'));
    f.src.sleep = () => new Promise((wake) => setTimeout(wake, 1));
    await Promise.all([act(f, { kind: 'prompt', text: 'один' }), act(f, { kind: 'prompt', text: 'два' })]);
    expect(f.sent).toEqual(['paste:один', '\r', 'paste:два', '\r']);
  });

  it('сбой чтения экрана и сессия без агента — отказ, а не исключение', async () => {
    const f = fake('claude', 'idle', undefined, { found: { ok: false, reason: 'no-agent', detail: 'pane runs zsh' } });
    expect(await act(f, { kind: 'interrupt' })).toEqual({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' });
    f.src.capture = async () => {
      throw new Error('tmux is gone');
    };
    expect(await act(f, { kind: 'interrupt' })).toMatchObject({ ok: false, reason: 'lookup-failed' });
    expect(f.sent).toEqual([]);
  });
});
