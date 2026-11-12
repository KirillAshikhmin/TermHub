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

  it('пустой экран и экран оболочки → unknown', () => {
    const profile = profileOf(agent);
    expect(readScreen([], profile)).toEqual({ kind: 'unknown' });
    expect(readScreen(['', '', ''], profile)).toEqual({ kind: 'unknown' });
    expect(readScreen(shot('claude', 'shell'), profile)).toEqual({ kind: 'unknown' });
    expect(
      readScreen(['user@host probe % ls', 'README.md  src', 'user@host probe % '], profile),
    ).toEqual({ kind: 'unknown' });
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
      expect(q.stamp).toBe(questionStamp(q.title, q.options));
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

describe('чужой профиль', () => {
  it('экран одного агента профилем другого за вопрос не принимается', () => {
    expect(readScreen(shot('claude', 'permission'), profileOf('codex')).question).toBeUndefined();
    expect(readScreen(shot('codex', 'permission'), profileOf('claude')).question).toBeUndefined();
    expect(readScreen(shot('codex', 'question'), profileOf('claude')).question).toBeUndefined();
    expect(readScreen(shot('claude', 'question'), profileOf('codex')).question).toBeUndefined();
  });
});
