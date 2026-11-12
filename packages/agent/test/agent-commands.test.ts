// Шов: `sessionCommands` над подменёнными источниками — без tmux и без агентов. Экран
// «панели» строится из снимка живого Claude (fixtures/screens/claude/idle.txt): подставной
// агент ведёт строку ввода и окно списка команд и отвечает на клавиши так, как в замере
// (docs/native-agent-ui.ru.md, «Подсказки по "/"»): окно в четыре строки, стрелка вниз
// двигает указатель, а прокрутка начинается, когда он упирается в край окна.
// Каталоги команд и навыков — временные; домашний каталог подменён.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionCommands, type CommandsSources } from '../src/agent-commands.js';
import { sessionAct } from '../src/agent-live.js';
import { profileOf } from '../src/agent-profiles.js';
import type { TranscriptResult } from '../src/agent-transcript.js';

const ROOT = new URL('./fixtures/screens/', import.meta.url).pathname;
const PANE = 'work:@1.%1';
const WINDOW = 4;
const DOWN = '\x1b[B';

let tmp: string;
let home: string;
let project: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-commands-'));
  home = path.join(tmp, 'home');
  project = path.join(tmp, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function shot(name: string): string[] {
  return fs.readFileSync(`${ROOT}claude/${name}.txt`, 'utf8').split('\n');
}

/** Подставной Claude с открытым списком по «/». */
class Sim {
  input = '';
  ptr = 0;
  scroll = 0;
  sent: string[] = [];
  captures = 0;
  /** Имена в списке агента, по порядку. */
  constructor(
    readonly names: string[],
    readonly opts: { delClears?: boolean; kind?: 'idle' | 'working' | 'input' } = {},
  ) {}

  lines(): string[] {
    const base = shot('idle');
    const prompt = base.findIndex((l) => l.includes('Try "write a test'));
    const out = base.slice();
    if (this.opts.kind === 'working') return shot('working');
    if (this.opts.kind === 'input' && this.input === '') return shot('input');
    out[prompt] = `❯ ${this.input}`;
    if (this.input.startsWith('/')) {
      const rows = this.names
        .slice(this.scroll, this.scroll + WINDOW)
        .map((name, i) => `  ${this.scroll + i === this.ptr ? '❯' : ' '} /${name}  hint of ${name}`);
      out.splice(prompt - 1, 0, ...rows);
      // Окно выросло вставкой — снизу столько же пустых строк уходит, чтобы строк осталось 32.
      out.splice(0, rows.length);
    }
    return out;
  }

  press(keys: string): void {
    this.sent.push(keys);
    if (keys === '/') {
      this.input = '/';
      this.ptr = 0;
      this.scroll = 0;
    } else if (keys === DOWN && this.input.startsWith('/')) {
      this.ptr = Math.min(this.ptr + 1, this.names.length - 1);
      if (this.ptr >= this.scroll + WINDOW) this.scroll = this.ptr - WINDOW + 1;
    } else if (keys === '\x7f' && this.opts.delClears !== false) {
      this.input = this.input.slice(0, -1);
    } else if (keys === '\x1b' && this.opts.delClears === false) {
      // Два Esc подряд стирают строку (профиль Claude); один закрывает список.
      this.escs = (this.escs ?? 0) + 1;
      if (this.escs >= 2) this.input = '';
    }
  }
  escs?: number;

  sources(over: Partial<CommandsSources> = {}): Partial<CommandsSources> {
    let clock = 0;
    return {
      home,
      capture: async () => {
        this.captures++;
        return { lines: this.lines(), alt: true, cols: 100, rows: 32, pane: PANE, command: '2.1.322' };
      },
      send: async (_s, bytes) => this.press(new TextDecoder().decode(bytes)),
      paste: async () => undefined,
      resolve: async (): Promise<TranscriptResult> => ({
        ok: true,
        agent: 'claude',
        files: [path.join(tmp, 'none.jsonl')],
        complete: true,
        live: true,
      }),
      version: async () => ({ version: '2.1.322' }),
      sleep: async () => {
        clock += 40;
      },
      now: () => (clock += 5),
      cwd: async () => project,
      ...over,
    };
  }
}

/** Список со сверкой — так его просит запрос, прошедший проверку Origin. */
const listVerified = (session: string, sources: Partial<CommandsSources>): ReturnType<typeof sessionCommands> =>
  sessionCommands(session, sources, { verify: true });

const builtinNames = profileOf('claude').builtins.map((b) => b.name);
const cacheFile = (): string => path.join(home, '.termhub', 'commands-claude-2.1.322.json');

describe('sessionCommands — чтение без сверки', () => {
  it('без просьбы о сверке клавиши в панель не идут даже у ожидающего агента; список — с диска и из профиля', async () => {
    write(path.join(home, '.claude/commands/ship.md'), '---\ndescription: Ship the build\n---\nbody');
    const sim = new Sim(['help', 'zeta-from-screen']);
    const res = await sessionCommands('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(sim.sent).toEqual([]);
    expect(res.verified).toBe(false);
    expect(res.commands.map((c) => c.name)).toContain('ship');
    expect(res.commands.map((c) => c.name)).not.toContain('zeta-from-screen');
  });

  it('готовый результат сверки чтение отдаёт из кэша — тоже без клавиш', async () => {
    await listVerified('work', new Sim(['help', 'zeta-from-screen']).sources());
    const sim = new Sim(['help', 'zeta-from-screen']);
    const res = await sessionCommands('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(sim.sent).toEqual([]);
    expect(res.verified).toBe(true);
    expect(res.commands.map((c) => c.name)).toContain('zeta-from-screen');
  });
});

describe('sessionCommands — каталоги на диске', () => {
  it('встроенные, пользовательские и проектные команды и навыки: имя, подсказка, источник', async () => {
    write(path.join(home, '.claude/commands/ship.md'), '---\ndescription: Ship the build\nargument-hint: <env>\n---\nbody');
    write(path.join(home, '.claude/commands/nested/deploy.md'), '---\ndescription: "Deploy: now"\n---\nbody');
    write(path.join(home, '.claude/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: Does alpha things\n---\n# alpha');
    write(path.join(project, '.claude/commands/local.md'), '---\ndescription: Project only\n---\n');
    const sim = new Sim([], { kind: 'working' });
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.commands.slice(0, builtinNames.length).map((c) => c.name)).toEqual(builtinNames);
    const rest = res.commands.slice(builtinNames.length);
    expect(rest).toEqual(
      expect.arrayContaining([
        { name: 'ship', hint: 'Ship the build', source: 'user', args: '<env>' },
        { name: 'nested:deploy', hint: 'Deploy: now', source: 'user' },
        { name: 'alpha', hint: 'Does alpha things', source: 'skill' },
        { name: 'local', hint: 'Project only', source: 'project' },
      ]),
    );
    expect(rest).toHaveLength(4);
    // Агент занят — сверка невозможна: клавиш не было, список честно назван несверенным.
    expect(res.verified).toBe(false);
    expect(sim.sent).toEqual([]);
  });

  it('файл без описания, битый frontmatter, пустой каталог навыка и пустая папка — список собирается без них', async () => {
    write(path.join(home, '.claude/commands/nodesc.md'), 'просто текст без шапки');
    write(path.join(home, '.claude/commands/broken.md'), '---\ndescription: never closed\nbody continues');
    write(path.join(home, '.claude/commands/empty-desc.md'), '---\ndescription:\n---\nbody');
    write(path.join(home, '.claude/commands/not-a-command.txt'), '---\ndescription: wrong extension\n---\n');
    write(path.join(home, '.claude/skills/nothing/README.md'), 'no skill file');
    write(path.join(home, '.claude/skills/noname/SKILL.md'), '---\nname: noname\n---\n');
    write(path.join(home, '.claude/commands/ok.md'), '---\ndescription: fine\n---\n');
    fs.mkdirSync(path.join(home, '.claude/commands/emptydir'), { recursive: true });
    const res = await listVerified('work', new Sim([], { kind: 'working' }).sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.commands.slice(builtinNames.length)).toEqual([{ name: 'ok', hint: 'fine', source: 'user' }]);
  });

  it('каталогов нет вовсе — одни встроенные, запрос не падает', async () => {
    const res = await listVerified('work', new Sim([], { kind: 'working' }).sources({ cwd: async () => undefined }));
    if (!res.ok) throw new Error(res.detail);
    expect(res.commands.map((c) => c.name)).toEqual(builtinNames);
    expect(res.commands.every((c) => c.source === 'builtin')).toBe(true);
  });

  it('команда диска с именем встроенной встроенную не дублирует', async () => {
    write(path.join(home, '.claude/commands/compact.md'), '---\ndescription: my compact\n---\n');
    const res = await listVerified('work', new Sim([], { kind: 'working' }).sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.commands.filter((c) => c.name === 'compact')).toEqual([
      expect.objectContaining({ name: 'compact', source: 'builtin' }),
    ]);
  });

  it('нет агента в панели — отказ той же причиной, что у экрана', async () => {
    const sim = new Sim([]);
    const res = await listVerified(
      'work',
      sim.sources({
        resolve: async () => ({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' }),
        // Команда панели — оболочка: по экрану и номеру версии агента узнают только Claude.
        capture: async () => ({ lines: sim.lines(), alt: false, cols: 100, rows: 32, pane: PANE, command: 'zsh' }),
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'no-agent', detail: 'pane runs zsh' });
    expect(sim.sent).toEqual([]);
  });
});

describe('sessionCommands — сверка с экраном агента', () => {
  const extra = ['plugin:one', 'zeta-skill'];
  const full = (): string[] => [...builtinNames.slice(0, 10), ...extra, ...builtinNames.slice(10)];

  it('листает окно списка до конца, добавляет неизвестные команды пометкой screen, возвращает строку пустой и запоминает на хосте', async () => {
    const sim = new Sim(full());
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(true);
    const added = res.commands.filter((c) => c.source === 'screen');
    expect(added.map((c) => c.name)).toEqual(extra);
    expect(added[0]).toEqual({ name: 'plugin:one', hint: 'hint of plugin:one', source: 'screen' });
    // Встроенные по-прежнему одни, со своими подсказками из профиля.
    expect(res.commands.filter((c) => c.name === 'clear')).toHaveLength(1);
    // Строка агента пуста, список закрыт.
    expect(sim.input).toBe('');
    expect(sim.sent[0]).toBe('/');
    expect(sim.sent.slice(1, -1).every((k) => k === DOWN)).toBe(true);
    // Сохранено по агенту и версии, права 0600.
    expect(JSON.parse(fs.readFileSync(cacheFile(), 'utf8'))).toMatchObject({
      agent: 'claude',
      version: '2.1.322',
      commands: [{ name: 'plugin:one' }, { name: 'zeta-skill' }],
    });
    expect(fs.statSync(cacheFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(cacheFile())).mode & 0o777).toBe(0o700);
  });

  it('второй раз клавиши не шлются: список берётся из сохранённого', async () => {
    const first = new Sim(full());
    const a = await listVerified('work', first.sources());
    const second = new Sim(full());
    const b = await listVerified('work', second.sources());
    expect(second.sent).toEqual([]);
    expect(b).toEqual(a);
  });

  it('сохранённое читается и когда агент занят: версия та же — сверка уже была', async () => {
    await listVerified('work', new Sim(full()).sources());
    const busy = new Sim([], { kind: 'working' });
    const res = await listVerified('work', busy.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(true);
    expect(res.commands.filter((c) => c.source === 'screen').map((c) => c.name)).toEqual(extra);
    expect(busy.sent).toEqual([]);
  });

  it('другая версия агента — новая сверка', async () => {
    await listVerified('work', new Sim(full()).sources());
    const next = new Sim([...full(), 'brand-new']);
    const res = await listVerified('work', next.sources({ version: async () => ({ version: '2.1.400' }) }));
    if (!res.ok) throw new Error(res.detail);
    expect(next.sent.length).toBeGreaterThan(0);
    expect(res.commands.map((c) => c.name)).toContain('brand-new');
    expect(fs.existsSync(path.join(home, '.termhub', 'commands-claude-2.1.400.json'))).toBe(true);
  });

  it('агент работает — сверка невозможна: verified false, клавиши не посланы, ничего не сохранено', async () => {
    const sim = new Sim(full(), { kind: 'working' });
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(false);
    expect(sim.sent).toEqual([]);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('в строке агента уже текст — сверка невозможна, строка не тронута', async () => {
    const sim = new Sim(full(), { kind: 'input' });
    sim.input = 'hello draft text';
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(false);
    expect(sim.sent).toEqual([]);
    expect(sim.input).toBe('hello draft text');
  });

  it('список длиннее предела: verified false, строка возвращена пустой, не сохранено, повторно клавиши не шлются', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `cmd-${i}`);
    const sim = new Sim(many);
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(false);
    expect(sim.input).toBe('');
    expect(sim.sent.filter((k) => k === DOWN).length).toBeLessThanOrEqual(300);
    expect(fs.existsSync(cacheFile())).toBe(false);
    const before = sim.sent.length;
    await listVerified('work', sim.sources());
    expect(sim.sent).toHaveLength(before);
  });

  it('список Codex в 67 строк при 85 мс на нажатие (замер живой проверки: 5,8 с) укладывается в срок', async () => {
    const sim = new Sim(Array.from({ length: 67 }, (_, i) => `cmd-${i}`));
    let clock = 0;
    const res = await listVerified('work', sim.sources({ now: () => (clock += 85) }));
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(true);
    expect(sim.input).toBe('');
  });

  it('срок 12 с: по часам, а не по числу нажатий', async () => {
    const sim = new Sim(Array.from({ length: 250 }, (_, i) => `cmd-${i}`));
    let clock = 0;
    const res = await listVerified(
      'work',
      sim.sources({
        // Каждый вызов часов — 100 мс: за 12 секунд успевает немногим больше сотни нажатий.
        now: () => (clock += 100),
      }),
    );
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(false);
    expect(sim.sent.filter((k) => k === DOWN).length).toBeLessThan(130);
    expect(sim.input).toBe('');
  });

  it('если Backspace не стёр строку, она стирается клавишами профиля — и только тогда, когда в ней текст', async () => {
    const sim = new Sim(full(), { delClears: false });
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(sim.input).toBe('');
    expect(sim.sent.slice(-2)).toEqual(['\x1b', '\x1b']);
    expect(res.verified).toBe(true);
  });

  it('строка не стёрлась ничем — список отдаётся, но verified false и в сохранённое не идёт', async () => {
    const sim = new Sim(full(), { delClears: false });
    sim.press = (keys: string): void => {
      sim.sent.push(keys);
      if (keys === '/') {
        sim.input = '/';
        sim.ptr = 0;
        sim.scroll = 0;
      } else if (keys === DOWN) {
        sim.ptr = Math.min(sim.ptr + 1, sim.names.length - 1);
        if (sim.ptr >= sim.scroll + WINDOW) sim.scroll = sim.ptr - WINDOW + 1;
      }
    };
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(false);
    expect(fs.existsSync(cacheFile())).toBe(false);
  });

  it('испорченный файл сохранённого игнорируется: сверка идёт заново', async () => {
    write(cacheFile(), '{не json');
    const sim = new Sim(full());
    const res = await listVerified('work', sim.sources());
    if (!res.ok) throw new Error(res.detail);
    expect(res.verified).toBe(true);
    expect(sim.sent.length).toBeGreaterThan(0);
  });
  it('действие, пришедшее во время сверки, шлёт первую клавишу только после возврата пустой строки', async () => {
    const sim = new Sim(full());
    // Запрос чата приходит, когда сверка уже сняла свой экран («строка пуста») и вот-вот
    // наберёт «/»: без общей очереди его текст вставился бы следом за «/».
    let act: ReturnType<typeof sessionAct> | undefined;
    let lineAtPaste: string | undefined;
    let keysBeforePaste: string[] = [];
    let captures = 0;
    const base = sim.sources();
    const sources: Partial<CommandsSources> = {
      ...base,
      capture: async (session) => {
        captures++;
        // Третий снимок — первый снимок самой сверки (до него — экран и адрес панели).
        if (captures === 3) act = sessionAct('work', { kind: 'prompt', text: 'hello' }, sources);
        return base.capture!(session);
      },
      send: async (session, bytes, pane) => {
        const keys = new TextDecoder().decode(bytes);
        if (keys === '\r' && lineAtPaste !== undefined) {
          sim.sent.push(keys);
          sim.input = '';
          return;
        }
        return base.send!(session, bytes, pane);
      },
      paste: async (_s, text) => {
        lineAtPaste ??= sim.input;
        keysBeforePaste = sim.sent.slice();
        sim.input += text;
      },
    };
    const res = await listVerified('work', sources);
    if (!res.ok) throw new Error(res.detail);
    expect(act).toBeDefined();
    const acted = await act!;
    // Текст запроса лёг в пустую строку: «/» сверки к этому моменту уже стёрт.
    expect(lineAtPaste).toBe('');
    expect(keysBeforePaste[0]).toBe('/');
    expect(keysBeforePaste.at(-1)).toBe('\x7f');
    expect(acted).toMatchObject({ ok: true });
    expect(res.verified).toBe(true);
    expect(sim.input).toBe('');
  });
});
