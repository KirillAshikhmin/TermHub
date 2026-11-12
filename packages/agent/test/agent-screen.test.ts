import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { questionStamp } from '@termhub/protocol/chat';
import type { AgentId, ScreenKind } from '@termhub/protocol/chat';
import { describe, expect, it } from 'vitest';

import { profileOf } from '../src/agent-profiles.js';
import { readPending, readPopup, readScreen } from '../src/agent-screen.js';

// Снимки сняты с живых агентов на отдельном сокете tmux (`capture-pane -p -e`):
// рядом с каждым — json с версией агента и размером панели. Ожидания ниже выписаны
// глазами с этих экранов, а не взяты из разборщика.
const ROOT = fileURLToPath(new URL('./fixtures/screens/', import.meta.url));

function shot(agent: AgentId, name: string): string[] {
  const lines = readFileSync(`${ROOT}${agent}/${name}.txt`, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Тот же экран без оформления — таким его отдаёт `capture-pane -p` без `-e`. */
function plain(lines: string[]): string[] {
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\][^\x1b]*\x1b\\/g, ''));
}

/** Варианты без пояснений — для ожиданий, выписанных до того, как пояснения появились. */
function bare<T extends { hint?: string }>(options: T[]): Omit<T, 'hint'>[] {
  return options.map(({ hint: _hint, ...rest }) => rest);
}

function read(agent: AgentId, name: string) {
  return readScreen(shot(agent, name), profileOf(agent));
}

/** Фоновая работа снимков agents-*: выписано глазами с подвала («1 shell») и списка под
 *  ним («◯ general-purpose  Run the tests … 2m 2s · ↓ 94.3k tokens»). */
const LISTED_AGENTS = [
  { type: 'general-purpose', task: 'Run the tests', elapsed: 122, tokens: 94_300 },
  { type: 'general-purpose', task: 'Check the build', elapsed: 30, tokens: 102_600 },
];
const LISTED = { shells: 1, agents: LISTED_AGENTS };

const KINDS: Record<AgentId, Record<string, ScreenKind>> = {
  claude: {
    idle: 'idle',
    'idle-accept': 'idle',
    'idle-plan': 'idle',
    'idle-auto': 'idle',
    working: 'working',
    'working-start': 'working',
    question: 'question',
    'question-narrow': 'question',
    'question-multi': 'question',
    'question-review': 'question',
    'question-free': 'question',
    'question-free-typed': 'question',
    'question-series': 'question',
    'question-series-review': 'question',
    permission: 'permission',
    'permission-narrow': 'permission',
    'menu-model': 'menu',
    'menu-model-confirm': 'menu',
    'menu-rewind': 'menu',
    'menu-trust': 'menu',
    input: 'idle',
    'input-multiline': 'idle',
    'input-pasted': 'idle',
    slash: 'idle',
    queued: 'working',
    shell: 'unknown',
    'idle-footer-item': 'idle',
    'agents-working': 'working',
    'agents-idle': 'idle',
    'agents-input': 'idle',
    'agents-question': 'question',
    'agents-permission': 'permission',
    'idle-labeled': 'idle',
    'idle-labeled-shell': 'idle',
  },
  codex: {
    idle: 'idle',
    'idle-plan': 'idle',
    working: 'working',
    'working-typing': 'working',
    question: 'question',
    'question-narrow': 'question',
    permission: 'permission',
    'permission-narrow': 'permission',
    'permission-mcp': 'permission',
    'permission-mcp-live': 'permission',
    'permission-mcp-moved': 'permission',
    'question-described': 'question',
    'question-notes': 'question',
    'question-notes-typed': 'question',
    'question-first-of-two': 'question',
    'question-last-of-two': 'question',
    'pending-side': 'idle',
    'pending-side-wide': 'idle',
    'pending-opened': 'question',
    'pending-queued': 'working',
    'pending-queued-timer': 'working',
    'pending-queued-two': 'working',
    'pending-queued-opened': 'question',
    'pending-queued-first-of-two': 'question',
    'pending-queued-last-of-two': 'question',
    'pending-queued-other': 'question',
    'pending-queued-other-typed': 'question',
    'pending-queued-other-digit': 'question',
    'menu-model': 'menu',
    'menu-permissions': 'menu',
    'menu-update': 'menu',
    'menu-trust': 'menu',
    input: 'idle',
    'input-multiline': 'idle',
    slash: 'idle',
    'slash-filtered': 'idle',
    queued: 'working',
    'statusline-idle': 'idle',
    'statusline-working': 'working',
    'statusline-working-wide': 'working',
  },
};

const AGENTS: AgentId[] = ['claude', 'codex'];

describe.each(AGENTS)('снимки %s: один набор проверок на обоих агентов', (agent) => {
  const names = Object.keys(KINDS[agent]);

  it('каждый снимок описан: версия агента и размер панели', () => {
    const files = readdirSync(`${ROOT}${agent}`);
    expect(files.filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort()).toEqual(
      [...names].sort(),
    );
    for (const name of names) {
      const meta = JSON.parse(readFileSync(`${ROOT}${agent}/${name}.json`, 'utf8')) as {
        agent: string;
        version: string;
        cols: number;
        rows: number;
      };
      expect(meta.agent).toBe(agent);
      expect(meta.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(meta.cols).toBeGreaterThan(0);
      expect(shot(agent, name)).toHaveLength(meta.rows);
    }
  });

  it('в снимках нет домашних путей и адресов', () => {
    for (const name of names) {
      const text = shot(agent, name).join('\n');
      expect(text).not.toMatch(/\/Users\/|\/private\/tmp|@[\w.-]+\.(?:com|ru|local)\b/);
    }
  });

  it.each(names)('%s → ожидаемый вид экрана', (name) => {
    expect(read(agent, name).kind).toBe(KINDS[agent][name]);
  });

  it.each(names)('%s без оформления → тот же вид экрана', (name) => {
    expect(readScreen(plain(shot(agent, name)), profileOf(agent)).kind).toBe(KINDS[agent][name]);
  });

  it('обрезанный пополам снимок вопроса или разрешения — не вопрос', () => {
    for (const name of names.filter((n) => /^(question|permission)/.test(n))) {
      const lines = shot(agent, name);
      const top = readScreen(lines.slice(0, lines.length >> 1), profileOf(agent));
      expect(top.kind).toBe('unknown');
      expect(top.question).toBeUndefined();
    }
  });

  it('снимок, оборванный посреди вариантов, — не вопрос', () => {
    for (const name of ['question', 'permission']) {
      const lines = plain(shot(agent, name));
      const second = lines.findIndex((l) => /^\s*2\. /.test(l));
      expect(second).toBeGreaterThan(0);
      const cut = readScreen(shot(agent, name).slice(0, second + 1), profileOf(agent));
      expect(cut.kind).toBe('unknown');
      expect(cut.question).toBeUndefined();
    }
  });

  it('пустой экран и экран оболочки → unknown, и причина названа', () => {
    const profile = profileOf(agent);
    expect(readScreen([], profile)).toEqual({ kind: 'unknown', why: 'empty screen' });
    expect(readScreen(['', '', ''], profile)).toEqual({ kind: 'unknown', why: 'empty screen' });
    expect(readScreen(shot('claude', 'shell'), profile)).toEqual({
      kind: 'unknown',
      why: 'no agent on screen',
    });
    expect(
      readScreen(['user@host probe % ls', 'README.md  src', 'user@host probe % '], profile),
    ).toEqual({ kind: 'unknown', why: 'no agent on screen' });
  });

  it('обрезанный экран агента: причина своя, не та, что у оболочки и пустого', () => {
    // Верхняя половина снимка: переписка агента видна, низа со строкой ввода нет.
    // У Claude не сошлась рамка ввода, у Codex — подвал под строкой ввода.
    const lines = shot(agent, 'permission');
    const half = readScreen(lines.slice(0, lines.length >> 1), profileOf(agent));
    expect(half).toEqual({
      kind: 'unknown',
      why: agent === 'claude' ? 'no input frame' : 'footer not recognized',
    });
    // Оборван посреди вариантов: последняя строка — вариант без подсказки диалога.
    const second = plain(lines).findIndex((l) => /^\s*2\. /.test(l));
    expect(readScreen(lines.slice(0, second + 1), profileOf(agent))).toEqual({
      kind: 'unknown',
      why: 'dialog cut off',
    });
  });

  it('причина — только у неузнанного экрана, и текста с экрана в ней нет', () => {
    for (const name of names) {
      const screen = read(agent, name);
      if (screen.kind === 'unknown') expect(screen.why).toMatch(/^[a-z ]+$/);
      else expect(screen).not.toHaveProperty('why');
    }
  });

  it('вопрос при другой ширине панели даёт тот же отпечаток', () => {
    for (const name of ['question', 'permission']) {
      const wide = read(agent, name).question;
      const narrow = read(agent, `${name}-narrow`).question;
      expect(wide?.stamp).toMatch(/^[0-9a-f]{16}$/);
      expect(narrow?.stamp).toBe(wide?.stamp);
      expect(narrow?.title).toBe(wide?.title);
      expect(narrow?.options).toEqual(wide?.options);
    }
  });

  it('отпечаток считает общая функция протокола', () => {
    for (const name of ['question', 'permission']) {
      const q = read(agent, name).question!;
      expect(q.stamp).toBe(questionStamp(q.title, q.options, q.body));
    }
  });

  it('тот же запрос разрешения с другим телом даёт другой отпечаток', () => {
    // Меняется одна строка тела — содержимое файла у Claude, команда у Codex;
    // заголовок и варианты остаются прежними.
    const marker = agent === 'claude' ? /^\s+1 hello$/ : /^\s+\$ printf /;
    for (const name of ['permission', 'permission-narrow']) {
      const lines = shot(agent, name);
      const flat = plain(lines);
      const at = flat.findIndex((l) => marker.test(l));
      expect(at).toBeGreaterThan(0);
      const other = [...lines];
      other[at] = lines[at]!.replace(/hello(?!.*hello)/, 'world');
      const was = read(agent, name).question!;
      const now = readScreen(other, profileOf(agent)).question!;
      expect(now.title).toBe(was.title);
      expect(now.options).toEqual(was.options);
      expect(now.body).not.toBe(was.body);
      expect(now.stamp).not.toBe(was.stamp);
    }
  });

  it('на меню и неузнанном экране нет ни вопроса, ни режима', () => {
    for (const name of names.filter((n) => KINDS[agent][n] === 'menu')) {
      const screen = read(agent, name);
      expect(screen.question).toBeUndefined();
      expect(screen.mode).toBeUndefined();
      expect(screen.input).toBeUndefined();
    }
  });
});

describe('Claude Code', () => {
  it('ожидание ввода: режим из подвала, подсказка-заглушка — не текст', () => {
    // В подвале снимка стоит «← 2 agents».
    expect(read('claude', 'idle')).toEqual({ kind: 'idle', mode: 'auto', input: '', agentCount: 2 });
    expect(read('claude', 'idle-accept')).toMatchObject({ mode: 'accept', input: '' });
    expect(read('claude', 'idle-plan')).toMatchObject({ mode: 'plan', input: '' });
    expect(read('claude', 'idle-auto')).toMatchObject({ mode: 'auto', input: '' });
  });

  it('текст в строке ввода', () => {
    expect(read('claude', 'input')).toEqual({ kind: 'idle', mode: 'auto', input: 'hello draft text' });
    expect(read('claude', 'input-multiline').input).toBe(
      'Reply with exactly one word: ok\n(this is line two of the same message)\n(and line three)',
    );
    // Свёрнутая вставка: агент рисует метку, сам текст с экрана не прочитать.
    expect(read('claude', 'input-pasted').input).toBe('[Pasted text #1 +3 lines]');
    expect(read('claude', 'slash').input).toBe('/co');
  });

  it('подвал с разовой подсказкой вместо режима — режим не назван', () => {
    expect(read('claude', 'input-pasted').mode).toBeUndefined();
  });

  it('работа: строка состояния, время и режим', () => {
    expect(read('claude', 'working')).toEqual({
      kind: 'working',
      status: 'Whirlpooling…',
      elapsed: 6,
      tokens: 179,
      mode: 'manual',
      input: '',
      agentCount: 2,
    });
    expect(read('claude', 'working-start')).toEqual({
      kind: 'working',
      status: 'Cooking…',
      mode: 'auto',
      input: '',
      agentCount: 2,
    });
  });

  it('очередь: сообщение ждёт, строка ввода пуста', () => {
    expect(read('claude', 'queued')).toEqual({
      kind: 'working',
      status: 'Doodling…',
      elapsed: 14,
      tokens: 216,
      mode: 'manual',
      input: '',
      queued: 1,
      agentCount: 2,
    });
  });

  it('вопрос с вариантами', () => {
    const q = read('claude', 'question').question!;
    expect(q.title).toBe('Какой цвет вы предпочитаете — красный, зелёный или синий?');
    expect(bare(q.options)).toEqual([
      { key: '1', label: 'Красный', selected: true },
      { key: '2', label: 'Зелёный' },
      { key: '3', label: 'Синий' },
      { key: '4', label: 'Type something.', free: true },
      { key: '5', label: 'Chat about this' },
    ]);
    expect(q.freeText).toBe(true);
    expect(q.multi).toBeUndefined();
  });

  it('вопрос с несколькими отметками', () => {
    const q = read('claude', 'question-multi').question!;
    expect(q.title).toBe('Какие фрукты вам нравятся — яблоко, банан, вишня?');
    expect(q.multi).toBe(true);
    expect(bare(q.options)).toEqual([
      { key: '1', label: 'Яблоко', selected: true, checked: true },
      { key: '2', label: 'Банан', checked: false },
      { key: '3', label: 'Вишня', checked: true },
      { key: '4', label: 'Type something', checked: false, free: true },
      { key: '5', label: 'Chat about this' },
    ]);
  });

  it('подтверждение ответов — тоже вопрос', () => {
    const q = read('claude', 'question-review').question!;
    expect(q.title).toBe('Ready to submit your answers?');
    expect(q.options).toEqual([
      { key: '1', label: 'Submit answers', selected: true },
      { key: '2', label: 'Cancel' },
    ]);
  });

  it('набор своего ответа отпечаток вопроса не меняет', () => {
    const before = read('claude', 'question-free').question!;
    const typed = read('claude', 'question-free-typed').question!;
    expect(before.options[2]).toEqual({ key: '3', label: 'Type something.', selected: true, free: true });
    expect(typed.options[2]).toEqual({ key: '3', label: 'parrot', selected: true, free: true });
    expect(typed.stamp).toBe(before.stamp);
  });

  it('запрос разрешения', () => {
    const screen = read('claude', 'permission');
    const q = screen.question!;
    expect(q.title).toBe('Do you want to create hello.txt?');
    expect(q.body).toBe('Create file\nhello.txt\n1 hello');
    expect(q.options).toEqual([
      { key: '1', label: 'Yes', selected: true },
      {
        key: '2',
        label:
          'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      },
      { key: '3', label: 'No' },
    ]);
    expect(q.freeText).toBeUndefined();
  });

  it('известные меню названы', () => {
    expect(read('claude', 'menu-model')).toEqual({ kind: 'menu', menu: 'model' });
    expect(read('claude', 'menu-model-confirm')).toEqual({ kind: 'menu', menu: 'model-confirm' });
    expect(read('claude', 'menu-rewind')).toEqual({ kind: 'menu', menu: 'rewind' });
    expect(read('claude', 'menu-trust')).toEqual({ kind: 'menu', menu: 'trust' });
  });

  it('список по «/»: команды с подсказками, перенос подсказки склеен', () => {
    expect(readPopup(shot('claude', 'slash'), profileOf('claude'))).toEqual([
      {
        name: 'copy',
        hint: "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
        source: 'screen',
      },
      { name: 'color', hint: 'Set the prompt bar color for this session', source: 'screen' },
      { name: 'config', hint: 'Open settings', source: 'screen' },
      {
        name: 'compact',
        hint: 'Free up context by summarizing the conversation so far',
        source: 'screen',
      },
    ]);
  });

  it('списка на экране нет → пусто', () => {
    expect(readPopup(shot('claude', 'idle'), profileOf('claude'))).toEqual([]);
    expect(readPopup(shot('claude', 'question'), profileOf('claude'))).toEqual([]);
    expect(readPopup(shot('claude', 'shell'), profileOf('claude'))).toEqual([]);
  });
});

describe('Codex', () => {
  it('ожидание ввода: режим и модель из подвала', () => {
    expect(read('codex', 'idle')).toEqual({
      kind: 'idle',
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
    expect(read('codex', 'idle-plan')).toEqual({
      kind: 'idle',
      mode: 'plan',
      input: '',
      model: 'GPT-6-Astra',
    });
  });

  it('текст в строке ввода', () => {
    expect(read('codex', 'input').input).toBe('hello draft text');
    expect(read('codex', 'input-multiline').input).toBe(
      'Reply with exactly one word: ok\n(this is line two of the same message)\n(and line three)',
    );
    expect(read('codex', 'slash').input).toBe('/');
    expect(read('codex', 'slash-filtered').input).toBe('/mo');
  });

  it('работа: строка состояния и время', () => {
    expect(read('codex', 'working')).toEqual({
      kind: 'working',
      status: 'Working',
      elapsed: 0,
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
  });

  it('набор во время работы: подвал сменился подсказкой — режим и модель не названы', () => {
    expect(read('codex', 'working-typing')).toEqual({
      kind: 'working',
      status: 'Working',
      elapsed: 0,
      input: 'y2',
    });
  });

  it('очередь: число сообщений с экрана', () => {
    expect(read('codex', 'queued')).toMatchObject({
      kind: 'working',
      status: 'Working',
      elapsed: 1,
      queued: 1,
      input: '',
    });
  });

  it('вопрос с вариантами: подпись отделена от пояснения', () => {
    const q = read('codex', 'question').question!;
    expect(q.title).toBe('Which color do you prefer: red, green, or blue?');
    expect(bare(q.options)).toEqual([
      { key: '1', label: 'Red', selected: true },
      { key: '2', label: 'Green' },
      { key: '3', label: 'Blue' },
      { key: '4', label: 'None of the above' },
    ]);
  });

  it('запрос разрешения', () => {
    const q = read('codex', 'permission').question!;
    expect(q.title).toBe('Would you like to run the following command?');
    expect(q.body).toBe(
      [
        'Environment: local',
        'Reason: May I create hello.txt in the current directory? The filesystem sandbox is read-only.',
        "$ printf 'hello\\n' > hello.txt",
      ].join('\n'),
    );
    expect(q.options).toEqual([
      { key: '1', label: 'Yes, proceed (y)', selected: true },
      {
        key: '2',
        label:
          "Yes, and don't ask again for commands that start with `printf 'hello\\n' > hello.txt` (p)",
      },
      { key: '3', label: 'No, and tell Codex what to do differently (esc)' },
    ]);
  });

  it('известные меню названы', () => {
    expect(read('codex', 'menu-model')).toEqual({ kind: 'menu', menu: 'model' });
    expect(read('codex', 'menu-permissions')).toEqual({ kind: 'menu', menu: 'permissions' });
    expect(read('codex', 'menu-update')).toEqual({ kind: 'menu', menu: 'update' });
    expect(read('codex', 'menu-trust')).toEqual({ kind: 'menu', menu: 'trust' });
  });

  it('список по «/»: команды с подсказками', () => {
    const all = readPopup(shot('codex', 'slash'), profileOf('codex'));
    expect(all.map((c) => c.name)).toEqual([
      'model',
      'fast',
      'ultrafast',
      'presets',
      'daybreak',
      'ide',
      'permissions',
      'keymap',
    ]);
    expect(all[0]).toEqual({
      name: 'model',
      hint: 'choose what model and reasoning effort to use',
      source: 'screen',
    });
    expect(readPopup(shot('codex', 'slash-filtered'), profileOf('codex'))).toEqual([
      { name: 'model', hint: 'choose what model and reasoning effort to use', source: 'screen' },
    ]);
  });

  it('списка на экране нет → пусто', () => {
    expect(readPopup(shot('codex', 'idle'), profileOf('codex'))).toEqual([]);
    expect(readPopup(shot('codex', 'permission'), profileOf('codex'))).toEqual([]);
  });
});

describe('Claude Code с фоновыми агентами', () => {
  // Под подвалом стоит список фоновых агентов, в подвале — «1 shell», «← 2 agents»,
  // «↓ to manage». Низ снимка agents-working снят с живой сессии.
  const claude = profileOf('claude');
  const ITEM = /^\s{2}◯ general-purpose\s/;

  /** Тот же снимок со списком из `count` фоновых агентов. */
  function withAgents(name: string, count: number): string[] {
    const lines = shot('claude', name);
    const flat = plain(lines);
    const first = flat.findIndex((l) => ITEM.test(l));
    expect(first).toBeGreaterThan(0);
    const items = Array.from({ length: count }, () => lines[first]!);
    return [...lines.slice(0, first), ...items];
  }

  it('работа: строка состояния, время и режим из подвала', () => {
    expect(read('claude', 'agents-working')).toEqual({
      kind: 'working',
      status: 'Bloviating…',
      elapsed: 15,
      tokens: 784,
      waiting: 2,
      mode: 'auto',
      input: '',
      ...LISTED,
    });
  });

  it('ожидание ввода и текст в строке ввода', () => {
    expect(read('claude', 'agents-idle')).toEqual({ kind: 'idle', waiting: 2, mode: 'auto', input: '', ...LISTED });
    expect(read('claude', 'agents-input')).toEqual({
      kind: 'idle',
      waiting: 2,
      mode: 'auto',
      input: 'hello draft text',
      ...LISTED,
    });
  });

  it('список от 1 до 10 строк вердикт не меняет; в ответе он только полем agents', () => {
    const working = read('claude', 'agents-working');
    const idle = read('claude', 'agents-input');
    for (let count = 1; count <= 10; count++) {
      const agents = Array.from({ length: count }, () => LISTED_AGENTS[0]);
      expect(readScreen(withAgents('agents-working', count), claude)).toEqual({ ...working, agents });
      expect(readScreen(withAgents('agents-input', count), claude)).toEqual({ ...idle, agents });
    }
  });

  it('строка «› Message from @…» в переписке — не ввод и не вопрос', () => {
    for (const name of ['agents-working', 'agents-idle']) {
      const lines = shot('claude', name);
      expect(plain(lines)).toContain('› Message from @general-purpose (ctrl+o to expand)');
      const screen = readScreen(lines, claude);
      expect(screen.input).toBe('');
      expect(screen.question).toBeUndefined();
      expect(screen.queued).toBeUndefined();
    }
    // Та же строка прямо над рамкой ввода.
    const lines = shot('claude', 'agents-idle');
    const at = plain(lines).indexOf('› Message from @general-purpose (ctrl+o to expand)');
    const moved = [
      ...lines.slice(0, at),
      '',
      '',
      '',
      ...lines.slice(at, at + 1),
      ...lines.slice(at + 4),
    ];
    expect(moved).toHaveLength(lines.length);
    expect(readScreen(moved, claude)).toEqual({ kind: 'idle', mode: 'auto', input: '', ...LISTED });
  });

  it('вопрос и разрешение над списком — тот же отпечаток, что без списка', () => {
    for (const name of ['question', 'permission']) {
      const bare = read('claude', name);
      const listed = read('claude', `agents-${name}`);
      expect(bare.question?.stamp).toMatch(/^[0-9a-f]{16}$/);
      // Сверх вопроса — только сам список полем agents.
      expect(listed).toEqual({ ...bare, agents: LISTED_AGENTS });
      for (let count = 1; count <= 10; count++) {
        const agents = Array.from({ length: count }, () => LISTED_AGENTS[0]);
        expect(readScreen(withAgents(`agents-${name}`, count), claude)).toEqual({ ...bare, agents });
      }
    }
  });

  it('подвал с подсказкой в скобках, пунктом «⧉ имя» и счётчиком агентов — режим назван', () => {
    expect(read('claude', 'idle-footer-item')).toEqual({ kind: 'idle', mode: 'auto', input: '', agentCount: 2 });
    // Тот же подвал над списком фоновых агентов и во время работы.
    const footer = shot('claude', 'idle-footer-item').findLast((l) => l.includes('auto mode on'))!;
    for (const [name, kind] of [['agents-idle', 'idle'], ['agents-working', 'working']] as const) {
      const lines = shot('claude', name);
      const at = lines.findLastIndex((l) => l.includes('auto mode on'));
      const tail = kind === 'working' ? ' · esc to interrupt' : '';
      const swapped = [...lines.slice(0, at), footer + tail, ...lines.slice(at + 1)];
      expect(readScreen(swapped, claude)).toMatchObject({ kind, mode: 'auto', input: '' });
    }
  });

  it('незнакомый пункт подвала после узнанного режима экран неузнанным не делает', () => {
    const lines = shot('claude', 'agents-idle');
    const at = lines.findLastIndex((l) => l.includes('auto mode on'));
    for (const item of ['⧉ index', '3 shells', 'some new thing 42', '✦ whatever (ctrl+q)']) {
      const footer = `  ⏵⏵ auto mode on (shift+tab to cycle) · ${item} · ← 2 agents · ${item}`;
      const swapped = [...lines.slice(0, at), footer, ...lines.slice(at + 1)];
      // «3 shells» — пункт знакомый: он называет число фоновых команд.
      const shells = item === '3 shells' ? { shells: 3 } : {};
      expect(readScreen(swapped, claude)).toEqual({
        kind: 'idle',
        waiting: 2,
        mode: 'auto',
        input: '',
        agents: LISTED_AGENTS,
        ...shells,
      });
      const bare = shot('claude', 'idle-auto');
      const last = bare.findLastIndex((l) => l.includes('auto mode on'));
      expect(readScreen([...bare.slice(0, last), footer, ...bare.slice(last + 1)], claude)).toEqual({
        kind: 'idle',
        mode: 'auto',
        input: '',
        agentCount: 2,
        ...shells,
      });
    }
  });

  it('список сам по себе экран не узнаёт: оболочка и обрезанный снимок остаются unknown', () => {
    const tray = shot('claude', 'agents-working').slice(-4);
    expect(readScreen([...shot('claude', 'shell'), ...tray], claude).kind).toBe('unknown');
    expect(readScreen(tray, claude).kind).toBe('unknown');
    const lines = shot('claude', 'agents-working');
    expect(readScreen([...lines.slice(0, lines.length >> 1), ...tray], claude).kind).toBe('unknown');
  });

  it('под подвалом не список, а что-то ещё — экран не узнан, причина названа', () => {
    const lines = shot('claude', 'agents-idle');
    const first = plain(lines).findIndex((l) => ITEM.test(l));
    const odd = [...lines.slice(0, first - 1), '  something else', '  one more line', '  and more', ''];
    expect(readScreen(odd, claude)).toEqual({ kind: 'unknown', why: 'content below footer' });
    // Список длиннее предела профиля — тоже не узнан.
    expect(readScreen(withAgents('agents-idle', 40), claude)).toEqual({
      kind: 'unknown',
      why: 'content below footer',
    });
  });
});

describe('Claude Code: подпись сессии в линейке рамки ввода', () => {
  // Обезличенные живые снимки: верхняя линейка рамки кончается подписью «── job ─».
  const claude = profileOf('claude');

  it('рамка с подписью — рамка: ожидание ввода, режим из подвала', () => {
    expect(read('claude', 'idle-labeled')).toEqual({ kind: 'idle', mode: 'auto', input: '', agentCount: 2 });
    expect(read('claude', 'idle-labeled-shell')).toEqual({
      kind: 'idle',
      mode: 'auto',
      input: '',
      shells: 1,
      agentCount: 2,
    });
  });

  it('текст в рамке с подписью и работа по подвалу', () => {
    const lines = shot('claude', 'idle-labeled');
    const at = lines.findLastIndex((l) => plain([l])[0] === '❯ ');
    expect(at).toBeGreaterThan(0);
    const typed = [...lines.slice(0, at), `${lines[at]!}hello draft text`, ...lines.slice(at + 1)];
    expect(readScreen(typed, claude)).toEqual({
      kind: 'idle',
      mode: 'auto',
      input: 'hello draft text',
      agentCount: 2,
    });
    const last = lines.findLastIndex((l) => l.includes('auto mode on'));
    const busy = [...lines.slice(0, last), `${lines[last]!} · esc to interrupt`];
    expect(readScreen(busy, claude)).toMatchObject({ kind: 'working', mode: 'auto' });
  });

  it('линейка с подписью сама экран не узнаёт', () => {
    const lines = shot('claude', 'idle-labeled');
    const top = plain(lines).findLastIndex((l) => / job ─$/.test(l));
    expect(top).toBeGreaterThan(0);
    // Оборван сразу под подписанной линейкой и под строкой ввода.
    expect(readScreen(lines.slice(0, top + 1), claude).kind).toBe('unknown');
    expect(readScreen(lines.slice(0, top + 2), claude).kind).toBe('unknown');
    // Подпись без закрывающей черты — не линейка.
    const odd = [...lines];
    odd[top] = '──────────────── job';
    expect(readScreen(odd, claude)).toEqual({ kind: 'unknown', why: 'input frame malformed' });
    expect(readScreen([...shot('claude', 'shell'), lines[top]!], claude).kind).toBe('unknown');
  });
});

describe('Codex со строкой состояния пользователя', () => {
  // Обезличенные живые снимки: под строкой ввода — строка состояния, собранная
  // пользователем (/statusline), и под ней строка подсказок «← for agents · ? for shortcuts».
  const codex = profileOf('codex');
  const STATUS = /^\s{2}GPT-6-Astra max · /;

  /** Тот же снимок с другой строкой состояния (`null` — без неё). */
  function withStatus(name: string, status: string | null): string[] {
    const lines = shot('codex', name);
    const at = plain(lines).findIndex((l) => STATUS.test(l));
    expect(at).toBeGreaterThan(0);
    return [...lines.slice(0, at), ...(status === null ? [] : [status]), ...lines.slice(at + 1)];
  }

  it('ожидание ввода: модель и режим из строки состояния, заглушка — не текст', () => {
    expect(read('codex', 'statusline-idle')).toEqual({
      kind: 'idle',
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
  });

  it('работа: строка работы над вводом, время, модель', () => {
    expect(read('codex', 'statusline-working')).toEqual({
      kind: 'working',
      status: 'Working',
      elapsed: 3 * 3600 + 11 * 60 + 43,
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
    expect(read('codex', 'statusline-working-wide')).toMatchObject({
      kind: 'working',
      elapsed: 3 * 3600 + 11 * 60 + 11,
    });
  });

  it('слово Working в строке состояния — работа, даже когда строки работы на экране нет', () => {
    const lines = shot('codex', 'statusline-working');
    const at = plain(lines).findIndex((l) => /^• Working \(/.test(l));
    expect(at).toBeGreaterThan(0);
    const bare = [...lines.slice(0, at), '', '', ...lines.slice(at + 2)];
    expect(bare).toHaveLength(lines.length);
    expect(readScreen(bare, codex)).toEqual({
      kind: 'working',
      status: 'Working',
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
  });

  it('пункты в другом порядке и незнакомые пункты: модель и состояние находятся', () => {
    const mixed = '  ~/work/project · some new thing 42 · GPT-6-Astra max · ✦ whatever · Ready';
    expect(readScreen(withStatus('statusline-idle', mixed), codex)).toEqual({
      kind: 'idle',
      mode: 'default',
      input: '',
      model: 'GPT-6-Astra',
    });
    const busy = '  weekly 40% left · Working · 258K window · GPT-6.1 Terra high';
    expect(readScreen(withStatus('statusline-idle', busy), codex)).toEqual({
      kind: 'working',
      status: 'Working',
      mode: 'default',
      input: '',
      model: 'GPT-6.1 Terra',
    });
    // Модели в профиле ещё нет: имя узнаётся по уровню рассуждений за ним.
    expect(
      readScreen(withStatus('statusline-idle', '  ~/work/low · gpt-7-nova high · Ready'), codex),
    ).toMatchObject({ kind: 'idle', mode: 'default', model: 'gpt-7-nova' });
    // Слово Working внутри чужого пункта — не состояние.
    const word = '  GPT-6-Astra max · ~/work/Working · Working tree clean';
    expect(readScreen(withStatus('statusline-idle', word), codex).kind).toBe('idle');
  });

  it('в строке состояния нет ни модели, ни состояния — экран узнан, они не названы', () => {
    for (const status of ['  ~/work/project · Context 50% left', '  ~/work/project', null]) {
      expect(readScreen(withStatus('statusline-idle', status), codex)).toEqual({
        kind: 'idle',
        input: '',
      });
    }
    // Каталог первым пунктом моделью не становится.
    const dir = '  ~/work/project · 7.27M used';
    expect(readScreen(withStatus('statusline-working', dir), codex)).not.toHaveProperty('model');
  });

  it('текст в строке ввода над строкой состояния', () => {
    const lines = shot('codex', 'statusline-idle');
    const at = plain(lines).findIndex((l) => l === '› Ask Codex to do anything');
    expect(at).toBeGreaterThan(0);
    const typed = [...lines.slice(0, at), '› Working', '  second line', ...lines.slice(at + 1)];
    expect(readScreen(typed, codex)).toMatchObject({ kind: 'idle', input: 'Working\nsecond line' });
  });

  it('прежние отказы: подвал без строки ввода, подсказка меню, длинный хвост, обрыв', () => {
    const lines = shot('codex', 'statusline-idle');
    const flat = plain(lines);
    const input = flat.findIndex((l) => l === '› Ask Codex to do anything');
    const status = flat.findIndex((l) => STATUS.test(l));
    // Строка ввода не отделена от подвала пустой строкой.
    const glued = [...lines.slice(0, input + 1), ...lines.slice(status)];
    expect(readScreen(glued, codex)).toEqual({ kind: 'unknown', why: 'no input frame' });
    // Над подвалом нет строки ввода.
    const lost = [...lines.slice(0, input), '', ...lines.slice(input + 1)];
    expect(readScreen(lost, codex)).toEqual({ kind: 'unknown', why: 'no input frame' });
    // В подвале подсказка меню.
    const menu = '  enter select · esc back';
    expect(readScreen(withStatus('statusline-idle', menu), codex)).toEqual({
      kind: 'unknown',
      why: 'footer not recognized',
    });
    // Под строкой ввода больше строк, чем бывает у подвала.
    const tall = [...lines.slice(0, status), '  one · two', '  three · four', ...lines.slice(status)];
    expect(readScreen(tall, codex).kind).toBe('unknown');
    // Строка без отступа в подвале.
    expect(readScreen(withStatus('statusline-idle', 'plain text · more'), codex).kind).toBe('unknown');
    // Оборван над подвалом: на строке ввода и на пустой строке под ней.
    expect(readScreen(lines.slice(0, input + 1), codex).kind).toBe('unknown');
    expect(readScreen(lines.slice(0, status), codex).kind).toBe('unknown');
  });
});

describe('чужой профиль', () => {
  it('экран одного агента профилем другого за вопрос не принимается', () => {
    expect(readScreen(shot('claude', 'permission'), profileOf('codex')).question).toBeUndefined();
    expect(readScreen(shot('codex', 'permission'), profileOf('claude')).question).toBeUndefined();
    expect(readScreen(shot('codex', 'question'), profileOf('claude')).question).toBeUndefined();
    expect(readScreen(shot('claude', 'question'), profileOf('codex')).question).toBeUndefined();
  });
});

describe('Codex: запрос разрешения на инструмент MCP', () => {
  const codex = profileOf('codex');
  const TITLE = 'Allow Docs Server to run "search_pages"?';
  const OPTIONS = [
    { key: '1', label: 'Allow' },
    { key: '2', label: 'Allow for this session' },
    { key: '3', label: 'Always allow' },
    { key: '4', label: 'Cancel' },
  ];

  /** Номер строки снимка, которая без оформления начинается с `head`. */
  function rowOf(lines: string[], head: string): number {
    const at = plain(lines).findIndex((l) => l.startsWith(head));
    expect(at).toBeGreaterThan(0);
    return at;
  }

  it('читается запросом разрешения: заголовок, тело, четыре варианта, указатель на первом', () => {
    const screen = read('codex', 'permission-mcp');
    expect({ ...screen, question: { ...screen.question!, options: bare(screen.question!.options) } }).toEqual({
      kind: 'permission',
      question: {
        stamp: questionStamp(TITLE, OPTIONS, 'Query: release notes'),
        title: TITLE,
        body: 'Query: release notes',
        options: [{ ...OPTIONS[0], selected: true }, ...OPTIONS.slice(1)],
      },
    });
  });

  it('заголовок с «to use» (так Codex спрашивает про приложение) — тот же диалог', () => {
    const lines = shot('codex', 'permission-mcp');
    lines[rowOf(lines, '  Allow ')] = '  Allow Desk Helper to use "Notes"?';
    lines[rowOf(lines, '  Query: ')] = '  App: Notes';
    expect(readScreen(lines, codex).question).toMatchObject({
      title: 'Allow Desk Helper to use "Notes"?',
      body: 'App: Notes',
    });
  });

  it('указатель на другом варианте распознан, отпечаток от него не зависит', () => {
    const lines = plain(shot('codex', 'permission-mcp'));
    const first = rowOf(lines, '  › 1. Allow');
    const third = rowOf(lines, '    3. Always allow');
    lines[first] = lines[first]!.replace('  › 1.', '    1.');
    lines[third] = lines[third]!.replace('    3.', '  › 3.');
    const q = readScreen(lines, codex).question!;
    expect(q.options.map((o) => o.selected === true)).toEqual([false, false, true, false]);
    expect(q.stamp).toBe(read('codex', 'permission-mcp').question!.stamp);
  });

  it('другой инструмент или другие аргументы — другой отпечаток', () => {
    const stamp = read('codex', 'permission-mcp').question!.stamp;
    const tool = shot('codex', 'permission-mcp');
    tool[rowOf(tool, '  Allow ')] = '  Allow Docs Server to run "delete_pages"?';
    const args = shot('codex', 'permission-mcp');
    args[rowOf(args, '  Query: ')] = '  Query: everything';
    expect(readScreen(tool, codex).question!.stamp).not.toBe(stamp);
    expect(readScreen(args, codex).question!.stamp).not.toBe(stamp);
    expect(readScreen(tool, codex).question!.stamp).not.toBe(readScreen(args, codex).question!.stamp);
  });

  it('другая ширина панели — тот же отпечаток: пояснения переносятся, подписи нет', () => {
    // Узкая панель собрана по образцу question-narrow того же Codex: полоса выбранной
    // строки короче, пояснение перенесено под свою колонку.
    const lines = plain(shot('codex', 'permission-mcp')).map((l) => l.trimEnd());
    const third = rowOf(lines, '    3. Always allow');
    const column = lines[third]!.indexOf('Run the tool');
    expect(column).toBeGreaterThan(0);
    lines[third] = `${lines[third]!.slice(0, column)}Run the tool and remember this choice`;
    lines.splice(third + 1, 0, `${' '.repeat(column)}for future tool calls`);
    const q = readScreen(lines, codex);
    expect(q.kind).toBe('permission');
    expect(q.question!.options.map((o) => o.label)).toEqual(OPTIONS.map((o) => o.label));
    expect(q.question!.stamp).toBe(read('codex', 'permission-mcp').question!.stamp);
  });

  it('обрезан сверху (строки с вопросом нет) — unknown с причиной', () => {
    const lines = shot('codex', 'permission-mcp');
    const title = rowOf(lines, '  Allow ');
    expect(readScreen(lines.slice(title + 1), codex)).toEqual({
      kind: 'unknown',
      why: 'dialog not recognized',
    });
    const second = rowOf(lines, '    2. Allow for this session');
    expect(readScreen(lines.slice(second), codex)).toEqual({
      kind: 'unknown',
      why: 'dialog not recognized',
    });
  });

  it('те же варианты под чужим заголовком и без подвала диалогом не становятся', () => {
    const lines = shot('codex', 'permission-mcp');
    const other = [...lines];
    other[rowOf(lines, '  Allow ')] = '  Something else entirely';
    expect(readScreen(other, codex).kind).toBe('unknown');
    const footer = rowOf(lines, '  enter to submit');
    expect(readScreen(lines.slice(0, footer), codex).kind).toBe('unknown');
  });

  it('профилем Claude за запрос не принимается', () => {
    expect(readScreen(shot('codex', 'permission-mcp'), profileOf('claude')).question).toBeUndefined();
  });

  it('прежние вопросы и разрешения дают прежние отпечатки', () => {
    // Отпечатки посчитаны по заголовку, вариантам и телу, выписанным с экранов.
    const codexQuestion = read('codex', 'question').question!;
    expect(codexQuestion.stamp).toBe(
      questionStamp('Which color do you prefer: red, green, or blue?', codexQuestion.options, undefined),
    );
    expect(codexQuestion.body).toBeUndefined();
    const codexPermission = read('codex', 'permission').question!;
    expect(codexPermission.stamp).toBe(
      questionStamp(
        'Would you like to run the following command?',
        codexPermission.options,
        [
          'Environment: local',
          'Reason: May I create hello.txt in the current directory? The filesystem sandbox is read-only.',
          "$ printf 'hello\\n' > hello.txt",
        ].join('\n'),
      ),
    );
    expect(read('codex', 'question-narrow').question!.stamp).toBe(codexQuestion.stamp);
  });
});

describe('Claude Code: токены в строке работы и ожидание фоновых агентов', () => {
  const claude = profileOf('claude');
  const STATUS = /Whirlpooling…|Bloviating…/;

  /** Снимок, в котором строка работы заменена своей (оформление строки сохраняется). */
  function restated(name: string, from: RegExp, to: string): string[] {
    const lines = shot('claude', name);
    const at = plain(lines).findIndex((l) => from.test(l));
    expect(at).toBeGreaterThan(0);
    const next = [...lines];
    next[at] = to;
    return next;
  }

  it('строка работы с токенами: слово состояния, время и токены', () => {
    expect(read('claude', 'working')).toMatchObject({ status: 'Whirlpooling…', elapsed: 6, tokens: 179 });
    // Строка со снимка пользователя.
    const lines = restated('working', STATUS, '\x1b[38;5;174m✳\x1b[39m \x1b[38;5;216mTransmuting…\x1b[38;5;174m \x1b[38;5;246m(1m 15s · ↓\x1b[39m \x1b[38;5;246m2.1k tokens)\x1b[39m');
    expect(readScreen(lines, claude)).toEqual({
      kind: 'working',
      status: 'Transmuting…',
      elapsed: 75,
      tokens: 2100,
      mode: 'manual',
      input: '',
      agentCount: 2,
    });
  });

  it('токены в миллионах и стрелкой вверх; строки без токенов поля не дают', () => {
    const up = restated('working', STATUS, '✳ Transmuting… (2h 3m 4s · ↑ 1.25M tokens)');
    expect(readScreen(up, claude)).toMatchObject({ elapsed: 7384, tokens: 1_250_000 });
    expect(read('claude', 'working-start')).not.toHaveProperty('tokens');
    const bare = restated('working', STATUS, '✳ Transmuting… (12s)');
    expect(readScreen(bare, claude)).toMatchObject({ status: 'Transmuting…', elapsed: 12 });
    expect(readScreen(bare, claude)).not.toHaveProperty('tokens');
  });

  it('ожидание фоновых агентов рядом со строкой работы: число ожидаемых', () => {
    expect(read('claude', 'agents-working')).toEqual({
      kind: 'working',
      status: 'Bloviating…',
      elapsed: 15,
      tokens: 784,
      waiting: 2,
      mode: 'auto',
      input: '',
      ...LISTED,
    });
  });

  it('одна строка ожидания без строки работы: число ожидаемых, вид решает подвал', () => {
    const lines = shot('claude', 'agents-working');
    const at = plain(lines).findIndex((l) => STATUS.test(l));
    const only = [...lines.slice(0, at - 1), ...lines.slice(at + 1)];
    expect(plain(only).some((l) => STATUS.test(l))).toBe(false);
    // В подвале снимка стоит «esc to interrupt» — агент ещё работает.
    expect(readScreen(only, claude)).toEqual({ kind: 'working', waiting: 2, mode: 'auto', input: '', ...LISTED });
    const one = only.map((l) => (plain([l])[0]!.includes('Waiting for') ? '✻ Waiting for 1 background agent to finish' : l));
    expect(readScreen(one, claude)).toMatchObject({ kind: 'working', waiting: 1 });
    // Ход окончен, агент ждёт фоновых: строка ввода свободна — это ожидание ввода.
    expect(read('claude', 'agents-idle')).toEqual({ kind: 'idle', waiting: 2, mode: 'auto', input: '', ...LISTED });
  });

  it('строка ожидания выше по переписке (старая) состоянием не считается', () => {
    const lines = shot('claude', 'agents-idle');
    const flat = plain(lines);
    const wait = flat.findIndex((l) => l.includes('Waiting for 2 background agents'));
    const talk = flat.indexOf('› Message from @general-purpose (ctrl+o to expand)');
    expect(talk).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(talk);
    // Меняем местами: теперь между строкой ожидания и вводом стоит строка переписки.
    const stale = [...lines];
    stale[wait] = lines[talk]!;
    stale[talk] = lines[wait]!;
    expect(readScreen(stale, claude)).toEqual({ kind: 'idle', mode: 'auto', input: '', ...LISTED });
  });

  it('Codex: строка работы токенов не рисует — поля нет', () => {
    expect(read('codex', 'working')).not.toHaveProperty('tokens');
    expect(read('codex', 'statusline-working')).not.toHaveProperty('tokens');
  });
});

describe('фоновые агенты и команды оболочки', () => {
  // Ожидания выписаны глазами со снимков: подвал «1 shell», «← 2 agents» и список под
  // подвалом «◯ <тип>  <задача>      <время> · ↓ <токены> tokens».
  const claude = profileOf('claude');

  it('подвал и список вместе: число команд и агенты списком, число из подвала не дублируется', () => {
    for (const name of ['agents-working', 'agents-idle', 'agents-input']) {
      const screen = read('claude', name);
      expect(screen.shells).toBe(1);
      expect(screen.agents).toEqual([
        { type: 'general-purpose', task: 'Run the tests', elapsed: 122, tokens: 94_300 },
        { type: 'general-purpose', task: 'Check the build', elapsed: 30, tokens: 102_600 },
      ]);
      expect(screen).not.toHaveProperty('agentCount');
    }
  });

  it('список под вопросом и разрешением: агенты есть, подвала нет — числа команд тоже', () => {
    for (const name of ['agents-permission', 'agents-question']) {
      const screen = read('claude', name);
      expect(screen.agents).toEqual(LISTED_AGENTS);
      expect(screen).not.toHaveProperty('shells');
      expect(screen).not.toHaveProperty('agentCount');
    }
  });

  it('списка нет: число агентов и команд из подвала, пункты по отдельности и вместе', () => {
    const both = read('claude', 'idle-labeled-shell');
    expect(both.shells).toBe(1);
    expect(both.agentCount).toBe(2);
    expect(both).not.toHaveProperty('agents');
    for (const name of ['idle-labeled', 'idle-footer-item']) {
      const only = read('claude', name);
      expect(only.agentCount).toBe(2);
      expect(only).not.toHaveProperty('shells');
      expect(only).not.toHaveProperty('agents');
    }
    // Только команды, во множественном числе, среди других пунктов.
    const lines = shot('claude', 'idle-auto');
    const last = lines.findLastIndex((l) => l.includes('auto mode on'));
    const footer = '  ⏵⏵ auto mode on · 3 shells · ⧉ index · ↓ to manage';
    const shells = readScreen([...lines.slice(0, last), footer, ...lines.slice(last + 1)], claude);
    expect(shells).toEqual({ kind: 'idle', mode: 'auto', input: '', shells: 3 });
    const one = '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent';
    expect(readScreen([...lines.slice(0, last), one, ...lines.slice(last + 1)], claude)).toEqual({
      kind: 'idle',
      mode: 'auto',
      input: '',
      agentCount: 1,
    });
  });

  it('экран без фоновых — полей нет вовсе', () => {
    for (const name of ['input', 'slash', 'question', 'permission', 'menu-model', 'shell']) {
      const screen = read('claude', name);
      expect(screen).not.toHaveProperty('shells');
      expect(screen).not.toHaveProperty('agents');
      expect(screen).not.toHaveProperty('agentCount');
    }
  });

  it('Codex: «← for agents» — подсказка без числа, списка он не рисует: полей нет', () => {
    for (const name of ['statusline-idle', 'statusline-working', 'statusline-working-wide', 'idle', 'working']) {
      const screen = read('codex', name);
      expect(screen.kind).not.toBe('unknown');
      expect(screen).not.toHaveProperty('shells');
      expect(screen).not.toHaveProperty('agents');
      expect(screen).not.toHaveProperty('agentCount');
    }
  });

  it('указатель списка стоит на агенте — строка агента читается так же, «main» в список не входит', () => {
    const lines = plain(shot('claude', 'agents-permission'));
    const main = lines.findIndex((l) => l === '  ⏺ main');
    expect(main).toBeGreaterThan(0);
    const moved = [...lines];
    moved[main] = '  ◯ main';
    moved[main + 1] = lines[main + 1]!.replace('◯', '⏺');
    const screen = readScreen(moved, claude);
    expect(screen.agents).toEqual(LISTED_AGENTS);
    expect(screen.question?.stamp).toBe(read('claude', 'permission').question?.stamp);
  });

  it('строка списка без задачи или только с временем: что нарисовано, остальное опущено', () => {
    const lines = plain(shot('claude', 'agents-idle'));
    const first = lines.findIndex((l) => /^\s{2}◯ general-purpose\s/.test(l));
    const odd = [...lines.slice(0, first), '  ◯ Explore', '  ◯ code-reviewer  Review the diff      45s'];
    expect(readScreen(odd, claude).agents).toEqual([
      { type: 'Explore' },
      { type: 'code-reviewer', task: 'Review the diff', elapsed: 45 },
    ]);
  });

  it('строки списка не попадают во ввод, статус и очередь', () => {
    const idle = read('claude', 'agents-input');
    expect(idle.input).toBe('hello draft text');
    expect(idle).not.toHaveProperty('status');
    expect(idle).not.toHaveProperty('queued');
    const working = read('claude', 'agents-working');
    expect(working.status).toBe('Bloviating…');
    expect(working.input).toBe('');
    expect(working).not.toHaveProperty('queued');
  });

  it('неузнанный экран со списком под ним фоновых не называет', () => {
    const tray = shot('claude', 'agents-working').slice(-4);
    expect(Object.keys(readScreen([...shot('claude', 'shell'), ...tray], claude)).sort()).toEqual(['kind', 'why']);
  });
});

// Замер таска 16 на Codex 0.167.2: пояснения вариантов, заметка (свой ответ), два вопроса
// подряд, «вопрос ждёт» в побочной беседе и живой запрос на инструмент MCP. Отпечатки ниже
// выписаны распознаванием ДО этих правок — пояснения и заметка менять их не вправе.
describe('вопросы: пояснения вариантов, заметка, ожидающий вопрос', () => {
  const codex = profileOf('codex');

  it('прежние отпечатки не изменились', () => {
    const before: [AgentId, string, string][] = [
      ['claude', 'permission', '003bac1e0e0fd528'],
      ['claude', 'permission-narrow', '003bac1e0e0fd528'],
      ['claude', 'agents-permission', '003bac1e0e0fd528'],
      ['claude', 'question', '46ddd0e63b82ac40'],
      ['claude', 'question-narrow', '46ddd0e63b82ac40'],
      ['claude', 'agents-question', '46ddd0e63b82ac40'],
      ['claude', 'question-free', 'e3c5e7e98149bb87'],
      ['claude', 'question-free-typed', 'e3c5e7e98149bb87'],
      ['claude', 'question-multi', 'bd4e54736adb052d'],
      ['claude', 'question-review', 'f28682d105515327'],
      ['codex', 'question', '4b6faf99d2d7eeef'],
      ['codex', 'question-narrow', '4b6faf99d2d7eeef'],
      ['codex', 'permission', '972877912d315f17'],
      ['codex', 'permission-narrow', '972877912d315f17'],
      ['codex', 'permission-mcp', 'be48c67eec586458'],
      ['codex', 'question-described', 'dd9a21e7408b7a91'],
      ['codex', 'pending-opened', '671612fb84e9333d'],
      ['codex', 'permission-mcp-live', '6cd232cccc7d104a'],
    ];
    for (const [agent, name, stamp] of before) {
      expect(`${agent}/${name} ${read(agent, name).question?.stamp}`).toBe(`${agent}/${name} ${stamp}`);
    }
  });

  it('Codex: пояснение варианта стоит в его строке и в подпись не входит', () => {
    const q = read('codex', 'question-described').question!;
    expect(q.title).toBe('Which color do you prefer—red, green, or blue?');
    expect(q.options).toEqual([
      { key: '1', label: 'Red', hint: 'Bold and energetic.', selected: true },
      { key: '2', label: 'Green', hint: 'Fresh and natural.' },
      { key: '3', label: 'Blue', hint: 'Calm and cool.' },
      { key: '4', label: 'None of the above', hint: 'Optionally, add details in notes (tab)' },
    ]);
    expect(q.stamp).toBe(questionStamp(q.title, q.options.map(({ key, label }) => ({ key, label }))));
  });

  it('Codex: пояснение, перенесённое в узкой панели, склеено', () => {
    expect(read('codex', 'question-narrow').question!.options.map((o) => o.hint)).toEqual([
      'Choose red as your preferred color.',
      'Choose green as your preferred color.',
      'Choose blue as your preferred color.',
      'Optionally, add details in notes (tab)',
    ]);
  });

  it('Claude: пояснение — строка под вариантом; у вариантов без неё поля нет', () => {
    const q = read('claude', 'question').question!;
    expect(q.options.map((o) => [o.label, o.hint])).toEqual([
      ['Красный', 'Красный цвет'],
      ['Зелёный', 'Зелёный цвет'],
      ['Синий', 'Синий цвет'],
      ['Type something.', undefined],
      ['Chat about this', undefined],
    ]);
  });

  it('Claude: перенос подписи варианта разрешения пояснением не становится', () => {
    const wide = read('claude', 'permission').question!;
    const narrow = read('claude', 'permission-narrow').question!;
    expect(narrow.options.map((o) => o.label)).toEqual(wide.options.map((o) => o.label));
    expect(narrow.options.every((o) => o.hint === undefined)).toBe(true);
  });

  it('Codex: один вопрос принимает свой ответ заметкой; поле заметки закрыто — поля notes нет', () => {
    const q = read('codex', 'question-described').question!;
    expect(q.freeText).toBe(true);
    expect(q.notes).toBeUndefined();
    expect(q.options.some((o) => o.free)).toBe(false);
  });

  it('Codex: открытое поле заметки — тот же вопрос; пустое поле (заглушка тусклым) — пустая строка', () => {
    const open = read('codex', 'question-notes').question!;
    expect(open.stamp).toBe(read('codex', 'question-described').question!.stamp);
    expect(open.notes).toBe('');
    expect(open.options.map((o) => o.selected === true)).toEqual([false, true, false, false]);
    expect(open.freeText).toBe(true);
  });

  it('Codex: набранная заметка читается текстом, указатель — на «None of the above»', () => {
    const typed = read('codex', 'question-notes-typed').question!;
    expect(typed.stamp).toBe(read('codex', 'question-described').question!.stamp);
    expect(typed.notes).toBe('teal instead');
    expect(typed.options.find((o) => o.selected)?.key).toBe('4');
    expect(typed.options).toHaveLength(4);
  });

  it('Codex: заметка, похожая на вариант, вариантом не становится', () => {
    const lines = shot('codex', 'question-notes-typed').map((l) => l.replace('teal instead', '5. teal'));
    const q = readScreen(lines, codex).question!;
    expect(q.options).toHaveLength(4);
    expect(q.notes).toBe('5. teal');
  });

  it('Codex: два вопроса подряд — оба читаются, свой ответ на них не предлагается', () => {
    const first = read('codex', 'question-first-of-two').question!;
    expect(first.title).toBe('Which fruit do you like?');
    expect(first.options.map((o) => o.label)).toEqual(['Apple', 'Banana', 'Cherry', 'None of the above']);
    expect(first.freeText).toBeUndefined();
    const last = read('codex', 'question-last-of-two').question!;
    expect(last.title).toBe('Which size do you prefer?');
    expect(last.options.map((o) => o.label)).toEqual(['Small', 'Large', 'None of the above']);
    expect(last.freeText).toBeUndefined();
    expect(last.stamp).not.toBe(first.stamp);
  });

  it('Codex: побочная беседа, пока главный поток ждёт ответа, — ожидание ввода с признаком «вопрос ждёт»', () => {
    for (const name of ['pending-side', 'pending-side-wide']) {
      const screen = read('codex', name);
      expect(screen.kind).toBe('idle');
      expect(screen.pending).toBe(true);
      expect(screen.input).toBe('');
      expect(screen.question).toBeUndefined();
    }
  });

  it('Codex: вопрос в очереди отложенного ввода — работа с признаком «вопрос ждёт», клавиша и число из приглашения', () => {
    const lines = shot('codex', 'pending-queued');
    expect(readScreen(lines, codex)).toMatchObject({ kind: 'working', status: 'Working', input: '', pending: true });
    expect(readPending(lines, codex)).toEqual({ key: 'answerPending', count: 1 });
    const three = lines.map((l) => l.replace('1 question', '3 questions'));
    expect(readPending(three, codex)).toEqual({ key: 'answerPending', count: 3 });
    // Побочная беседа — другое приглашение и другая клавиша.
    expect(readPending(shot('codex', 'pending-side'), codex)).toEqual({ key: 'showPending' });
    expect(readPending(shot('codex', 'idle'), codex)).toBeUndefined();
    expect(readPending(shot('codex', 'pending-opened'), codex)).toBeUndefined();
  });

  it('Codex: строка счёта с таймером и строка работы с припиской — та же работа с признаком', () => {
    // Замер: «? 1 question · 20s», «Working (24s • esc to interrupt) · 1 background terminal running · …».
    const timer = shot('codex', 'pending-queued-timer');
    expect(readScreen(timer, codex)).toMatchObject({ kind: 'working', status: 'Working', elapsed: 24, pending: true });
    expect(readPending(timer, codex)).toEqual({ key: 'answerPending', count: 1 });
    const two = shot('codex', 'pending-queued-two');
    expect(readScreen(two, codex)).toMatchObject({ kind: 'working', elapsed: 21, pending: true });
    expect(readPending(two, codex)).toEqual({ key: 'answerPending', count: 2 });
  });

  it('Codex: вопрос из очереди, открытый Shift+←, — вопрос с вариантами и своим ответом последним', () => {
    const screen = read('codex', 'pending-queued-opened');
    expect(screen.pending).toBeUndefined();
    const q = screen.question!;
    expect(q.title).toBe('Cats or dogs?');
    expect(q.body).toBeUndefined();
    expect(q.options).toEqual([
      { key: '1', label: 'Cats', selected: true },
      { key: '2', label: 'Dogs' },
      { key: '3', label: 'Other', free: true },
    ]);
    expect(q.freeText).toBe(true);
    expect(q.stamp).toBe(questionStamp('Cats or dogs?', q.options));

    const first = read('codex', 'pending-queued-first-of-two').question!;
    expect(first.title).toBe('Tea or coffee?');
    expect(first.options.map((o) => o.label)).toEqual(['Tea', 'Coffee', 'Other']);
    const last = read('codex', 'pending-queued-last-of-two').question!;
    expect(last.title).toBe('Red or blue?');
    expect(last.options.map((o) => o.label)).toEqual(['Red', 'Blue', 'Other']);
    expect(last.stamp).not.toBe(first.stamp);

    // Указатель на «Other» и набранный в нём текст вопроса не меняют: отпечаток прежний.
    const other = read('codex', 'pending-queued-other').question!;
    expect(other.options[2]).toEqual({ key: '3', label: 'Other', selected: true, free: true });
    const typed = read('codex', 'pending-queued-other-typed').question!;
    expect(typed.options[2]).toEqual({ key: '3', label: 'green', selected: true, free: true });
    expect([other.stamp, typed.stamp]).toEqual([last.stamp, last.stamp]);
  });

  it('Codex: место вопроса в очереди входит в отпечаток — одинаковые вопросы подряд различимы', () => {
    const first = shot('codex', 'pending-queued-first-of-two');
    // Тот же текст и те же варианты вторым вопросом очереди (подвал — как у последнего).
    const second = first.map((l) =>
      l.replace('1 of 2', '2 of 2').replace(/⇧→.*$/u, (tail) => (plain([tail])[0]!.includes('main prompt') ? '⇧→ prev question' : tail)),
    );
    const a = readScreen(first, codex).question!;
    const b = readScreen(second, codex).question!;
    expect([a.title, b.title]).toEqual(['Tea or coffee?', 'Tea or coffee?']);
    expect(b.options).toEqual(a.options);
    expect(b.stamp).not.toBe(a.stamp);
    // Счётчик в отпечатке — только у очереди из нескольких вопросов.
    expect(a.stamp).not.toBe(questionStamp(a.title, a.options));
    // Вне диалога очереди «N of M» счётчиком не считается: это строка тела.
    expect(codex.screen.chip.test('1 of 2')).toBe(false);
  });

  it('Codex: текст своего ответа, начатый с цифры варианта, остаётся текстом в строке «Other» (замер)', () => {
    const q = read('codex', 'pending-queued-other-digit').question!;
    expect(q.options).toEqual([
      { key: '1', label: 'Tea' },
      { key: '2', label: 'Coffee' },
      { key: '3', label: '1 cup a day', selected: true, free: true },
    ]);
  });

  it('Codex: тот же диалог без заголовка очереди над ним — не вопрос', () => {
    const lines = shot('codex', 'pending-queued-opened');
    const head = lines.findIndex((l) => plain([l])[0] === '• Queued follow-up inputs');
    expect(head).toBeGreaterThan(0);
    const cut = readScreen(lines.filter((_, i) => i !== head), codex);
    expect(cut.kind).toBe('unknown');
    expect(cut.question).toBeUndefined();
  });

  it('Codex: блок очереди узнаётся по месту и по всем строкам вместе, а не по словам', () => {
    const lines = shot('codex', 'pending-queued');
    const at = (word: string): number => lines.findIndex((l) => plain([l])[0]!.includes(word));
    const head = at('Queued follow-up inputs');
    const count = at('? 1 question');
    const hint = at('⇧← to answer');
    expect([count - head, hint - count]).toEqual([1, 1]);
    const without = (...drop: number[]): string[] => lines.filter((_, i) => !drop.includes(i));
    const none = (changed: string[]): void => {
      const screen = readScreen(changed, codex);
      expect(screen.kind).toBe('working');
      expect(screen.pending).toBeUndefined();
      expect(readPending(changed, codex)).toBeUndefined();
    };
    // Нет строки приглашения, нет строки счёта, нет заголовка блока.
    none(without(hint));
    none(without(count));
    none(without(head));
    // В очереди стоит не вопрос.
    none(lines.map((l, i) => (i === count ? '  ↳ check the build log' : l)));
    // Те же три строки в переписке: между ними и строкой ввода стоит реплика агента.
    const talk = [...lines];
    talk.splice(hint + 1, 0, '', '• The block above is a quote from the manual.');
    none(talk);
    // Те же строки выше по экрану, а блока над строкой ввода нет.
    const above = without(head, count, hint);
    above.splice(2, 0, lines[head]!, lines[count]!, lines[hint]!, '');
    none(above);
    // Строка приглашения, набранная текстом (не тусклая), — не приглашение агента.
    none(lines.map((l, i) => (i === hint ? '    ⇧← to answer' : i === count ? '  ? 1 question' : l)));
  });

  it('признака «вопрос ждёт» нет там, где агент его не рисует', () => {
    expect(read('codex', 'idle').pending).toBeUndefined();
    expect(read('codex', 'statusline-idle').pending).toBeUndefined();
    expect(read('codex', 'pending-opened').pending).toBeUndefined();
    expect(read('claude', 'idle').pending).toBeUndefined();
    // Слова без клавиши переключения (главный поток уже закончил) — не признак.
    const done = shot('codex', 'pending-side').map((l) => l.replace('main needs input', 'main finished'));
    expect(readScreen(done, codex)).toMatchObject({ kind: 'idle' });
    expect(readScreen(done, codex).pending).toBeUndefined();
  });

  it('Codex: живой запрос на инструмент MCP — заголовок, тело, варианты с пояснениями', () => {
    const q = read('codex', 'permission-mcp-live').question!;
    expect(q.title).toBe('Allow the probe_notes MCP server to run tool "save_note"?');
    expect(q.body).toBe('text: hello');
    expect(q.options).toEqual([
      { key: '1', label: 'Allow', hint: 'Run the tool and continue', selected: true },
      { key: '2', label: 'Allow for this session', hint: 'Run the tool and remember this choice for this session' },
      { key: '3', label: 'Always allow', hint: 'Run the tool and remember this choice for future tool calls' },
      { key: '4', label: 'Cancel', hint: 'Cancel this tool call' },
    ]);
    const moved = read('codex', 'permission-mcp-moved').question!;
    expect(moved.stamp).toBe(q.stamp);
    expect(moved.options.find((o) => o.selected)?.key).toBe('2');
  });

  it('Codex: «Field N/M» при M>1 — форма из нескольких полей, запросом разрешения не считается', () => {
    const several = shot('codex', 'permission-mcp-live').map((l) => l.replace('Field 1/1', 'Field 1/3'));
    expect(readScreen(several, codex)).toEqual({ kind: 'unknown', why: 'dialog not recognized' });
    const second = shot('codex', 'permission-mcp').map((l) => l.replace('Field 1/1', 'Field 2/2'));
    expect(readScreen(second, codex).kind).toBe('unknown');
  });
});

// Серия вопросов Claude: над вопросом полоса шагов «←  ☒ Название  ☐ Название  ✔ Submit  →»,
// текущий шаг подсвечен фоном. Полоса одиночного вопроса и экрана подтверждения — с живых
// снимков; полоса из нескольких вопросов собрана по их геометрии (см. json снимков).
describe('Claude Code: полоса шагов над вопросом', () => {
  const claude = profileOf('claude');

  it('серия: названия, отвеченные, текущий по подсветке, шаг отправки и номер текущего', () => {
    const q = read('claude', 'question-series').question!;
    expect(q.steps).toEqual([
      { label: 'Животное', done: true },
      { label: 'Цвет', current: true },
      { label: 'Размер' },
      { label: 'Submit', submit: true },
    ]);
    expect(q.step).toBe(2);
    expect(q.title).toBe('Какой цвет вы предпочитаете — красный, зелёный или синий?');
    expect(q.body).toBeUndefined();
  });

  it('одиночный вопрос: один шаг с названием; вопрос с отметками — вопрос и шаг отправки', () => {
    expect(read('claude', 'question').question).toMatchObject({ steps: [{ label: 'Цвет', current: true }], step: 1 });
    expect(read('claude', 'question-multi').question).toMatchObject({
      steps: [{ label: 'Фрукты', done: true, current: true }, { label: 'Submit', submit: true }],
      step: 1,
    });
  });

  it('экран подтверждения: текущий — шаг отправки', () => {
    const q = read('claude', 'question-series-review').question!;
    expect(q.steps).toEqual([
      { label: 'Животное', done: true },
      { label: 'Цвет', done: true },
      { label: 'Размер', done: true },
      { label: 'Submit', submit: true, current: true },
    ]);
    expect(q.step).toBe(4);
    expect(q.title).toBe('Ready to submit your answers?');
  });

  it('без оформления текущий шаг не назван — и номера нет', () => {
    const q = readScreen(plain(shot('claude', 'question-series')), claude).question!;
    expect(q.steps?.map((step) => step.label)).toEqual(['Животное', 'Цвет', 'Размер', 'Submit']);
    expect(q.steps?.some((step) => step.current)).toBe(false);
    expect(q.step).toBeUndefined();
  });

  it('вопросы серии с разным названием дают разные отпечатки, отметка «отвечен» отпечаток не меняет', () => {
    const base = read('claude', 'question-series').question!.stamp;
    // Тот же текст и те же варианты под другим названием — другой вопрос серии.
    const renamed = shot('claude', 'question-series').map((l) => l.replace(' ☐ Цвет ', ' ☐ Тон '));
    expect(readScreen(renamed, claude).question!.stamp).not.toBe(base);
    const answered = shot('claude', 'question-series').map((l) => l.replace(' ☐ Цвет ', ' ☒ Цвет '));
    expect(readScreen(answered, claude).question!.stamp).toBe(base);
    // Одиночный вопрос с тем же текстом — отпечаток прежний, не серийный.
    expect(base).not.toBe(read('claude', 'question').question!.stamp);
    expect(read('claude', 'question').question!.stamp).toBe('46ddd0e63b82ac40');
  });

  it('у Codex полосы нет — полей нет', () => {
    const q = read('codex', 'question-described').question!;
    expect(q.steps).toBeUndefined();
    expect(q.step).toBeUndefined();
  });
});
