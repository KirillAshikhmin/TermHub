import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { questionStamp } from '@termhub/protocol/chat';
import type { AgentId, ScreenKind } from '@termhub/protocol/chat';
import { describe, expect, it } from 'vitest';

import { profileOf } from '../src/agent-profiles.js';
import { readPopup, readScreen } from '../src/agent-screen.js';

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

function read(agent: AgentId, name: string) {
  return readScreen(shot(agent, name), profileOf(agent));
}

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
    expect(read('claude', 'idle')).toEqual({ kind: 'idle', mode: 'auto', input: '' });
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
      mode: 'manual',
      input: '',
    });
    expect(read('claude', 'working-start')).toEqual({
      kind: 'working',
      status: 'Cooking…',
      mode: 'auto',
      input: '',
    });
  });

  it('очередь: сообщение ждёт, строка ввода пуста', () => {
    expect(read('claude', 'queued')).toEqual({
      kind: 'working',
      status: 'Doodling…',
      elapsed: 14,
      mode: 'manual',
      input: '',
      queued: 1,
    });
  });

  it('вопрос с вариантами', () => {
    const q = read('claude', 'question').question!;
    expect(q.title).toBe('Какой цвет вы предпочитаете — красный, зелёный или синий?');
    expect(q.options).toEqual([
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
    expect(q.options).toEqual([
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
    expect(q.options).toEqual([
      { key: '1', label: 'Red', selected: true },
      { key: '2', label: 'Green' },
      { key: '3', label: 'Blue' },
      { key: '4', label: 'None of the above' },
    ]);
    expect(q.freeText).toBeUndefined();
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
      mode: 'auto',
      input: '',
    });
  });

  it('ожидание ввода и текст в строке ввода', () => {
    expect(read('claude', 'agents-idle')).toEqual({ kind: 'idle', mode: 'auto', input: '' });
    expect(read('claude', 'agents-input')).toEqual({
      kind: 'idle',
      mode: 'auto',
      input: 'hello draft text',
    });
  });

  it('список от 1 до 10 строк вердикт не меняет и в ответ не попадает', () => {
    const working = read('claude', 'agents-working');
    const idle = read('claude', 'agents-input');
    for (let count = 1; count <= 10; count++) {
      expect(readScreen(withAgents('agents-working', count), claude)).toEqual(working);
      expect(readScreen(withAgents('agents-input', count), claude)).toEqual(idle);
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
    expect(readScreen(moved, claude)).toEqual({ kind: 'idle', mode: 'auto', input: '' });
  });

  it('вопрос и разрешение над списком — тот же отпечаток, что без списка', () => {
    for (const name of ['question', 'permission']) {
      const bare = read('claude', name);
      const listed = read('claude', `agents-${name}`);
      expect(bare.question?.stamp).toMatch(/^[0-9a-f]{16}$/);
      expect(listed).toEqual(bare);
      for (let count = 1; count <= 10; count++) {
        expect(readScreen(withAgents(`agents-${name}`, count), claude)).toEqual(bare);
      }
    }
  });

  it('подвал с подсказкой в скобках, пунктом «⧉ имя» и счётчиком агентов — режим назван', () => {
    expect(read('claude', 'idle-footer-item')).toEqual({ kind: 'idle', mode: 'auto', input: '' });
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
      expect(readScreen(swapped, claude)).toEqual({ kind: 'idle', mode: 'auto', input: '' });
      const bare = shot('claude', 'idle-auto');
      const last = bare.findLastIndex((l) => l.includes('auto mode on'));
      expect(readScreen([...bare.slice(0, last), footer, ...bare.slice(last + 1)], claude)).toEqual({
        kind: 'idle',
        mode: 'auto',
        input: '',
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
    expect(read('claude', 'idle-labeled')).toEqual({ kind: 'idle', mode: 'auto', input: '' });
    expect(read('claude', 'idle-labeled-shell')).toEqual({ kind: 'idle', mode: 'auto', input: '' });
  });

  it('текст в рамке с подписью и работа по подвалу', () => {
    const lines = shot('claude', 'idle-labeled');
    const at = lines.findLastIndex((l) => plain([l])[0] === '❯ ');
    expect(at).toBeGreaterThan(0);
    const typed = [...lines.slice(0, at), `${lines[at]!}hello draft text`, ...lines.slice(at + 1)];
    expect(readScreen(typed, claude)).toEqual({ kind: 'idle', mode: 'auto', input: 'hello draft text' });
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
