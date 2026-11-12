// @vitest-environment happy-dom
// Поле ввода чата: отправка и очередь, отказы, черновик, вложения, подсказки «/» и «@».
// Шов один — подделанные транспорт, живое состояние и переписка (вставка локальных записей).
import type { ActResult, ChatAction, ChatCommand, CommandsResult, LiveState, ScreenState } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountComposer, type ComposerHandle } from '../src/chat-composer';
import type { LiveHandle } from '../src/chat-live';
import { setLang, t } from '../src/i18n';
import { setTermPrefs } from '../src/term-prefs';
import type { LocalAction, LocalMessage, LocalState } from '../src/feed';
import type { FeedEntry, FeedResult, Transport } from '../src/transport';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const IDLE: ScreenState = { kind: 'idle' };
const COMMANDS: ChatCommand[] = [
  { name: 'compact', hint: 'Сжать контекст', source: 'builtin' },
  { name: 'commit', hint: 'Закоммитить', source: 'project' },
  { name: 'review', source: 'skill' },
];

interface LocalRec {
  text: string;
  state: LocalState;
  note?: string;
  actions: LocalAction[];
  removed: boolean;
  delivered: boolean;
}

interface Fx {
  host: HTMLElement;
  composer: ComposerHandle;
  field: HTMLTextAreaElement;
  send: HTMLButtonElement;
  /** Действия без ключа попытки — ключи идут рядом, в том же порядке. */
  acts: ChatAction[];
  keys: Array<string | undefined>;
  locals: LocalRec[];
  refreshes: { n: number };
  nextAct: { value: ActResult | Error | Promise<ActResult> };
  screen: { value: ScreenState };
  /** Что уже показано в переписке и что отдаст хвост ленты. */
  shown: { value: FeedEntry[] };
  feedTail: { value: FeedResult | Error };
  live: { refresh: ReturnType<typeof vi.fn> };
  transport: Record<string, ReturnType<typeof vi.fn>>;
  /** Сообщить подписчикам живого состояния, что экран сменился. */
  emit(): void;
}

const human = (id: string, text: string): FeedEntry => ({ id, at: 0, kind: 'human', text });
function page(entries: FeedEntry[]): FeedResult {
  return { ok: true, agent: 'claude', entries, head: '1:0', tail: '1:9', bof: true, eof: true, skipped: 0 } as FeedResult;
}

function mount(
  opts: {
    scope?: unknown;
    commands?: CommandsResult | Error;
    /** Ответы на запросы списка команд по порядку (последний повторяется). */
    commandsSeq?: CommandsResult[];
    session?: string;
    spaced?: boolean;
  } = {},
): Fx {
  const acts: ChatAction[] = [];
  const keys: Array<string | undefined> = [];
  const locals: LocalRec[] = [];
  const refreshes = { n: 0 };
  const nextAct: Fx['nextAct'] = { value: { ok: true, screen: IDLE } };
  const screen = { value: IDLE };
  const shown: Fx['shown'] = { value: [] };
  const feedTail: Fx['feedTail'] = { value: page([]) };
  const subs: Array<() => void> = [];
  const commandsByCall = opts.commandsSeq;
  const live = {
    state: () => ({ ok: true, agent: 'claude', tested: true, screen: screen.value, modes: [], models: [] }) as LiveState,
    act: vi.fn(async (a: ChatAction) => {
      const { key: attempt, ...bare } = a as ChatAction & { key?: string };
      acts.push(bare as ChatAction);
      keys.push(attempt);
      const v = nextAct.value;
      if (v instanceof Error) throw v;
      return v;
    }),
    refresh: vi.fn(async () => {}),
    subscribe: (fn: () => void) => {
      subs.push(fn);
      return () => {};
    },
    teardown() {},
  } as unknown as LiveHandle;
  const thread = {
    entries: () => shown.value,
    refresh: () => {
      refreshes.n += 1;
    },
    addLocal: (text: string, state: LocalState = 'sending'): LocalMessage => {
      const rec: LocalRec = { text, state, actions: [], removed: false, delivered: false };
      locals.push(rec);
      return {
        set: (next, o = {}) => {
          rec.state = next;
          rec.note = o.note;
          rec.actions = o.actions ?? [];
          if (o.delivered !== undefined) rec.delivered = o.delivered;
        },
        remove: () => {
          rec.removed = true;
        },
      };
    },
  };
  const transport = {
    clientScope: opts.scope ?? null,
    feed: vi.fn(async () => {
      const v = feedTail.value;
      if (v instanceof Error) throw v;
      return v;
    }),
    commands: vi.fn(async () => {
      if (commandsByCall) return commandsByCall.length > 1 ? commandsByCall.shift()! : commandsByCall[0]!;
      const c = opts.commands ?? ({ ok: true, commands: COMMANDS, verified: true } as CommandsResult);
      if (c instanceof Error) throw c;
      return c;
    }),
    pasteFile: vi.fn(async (_b: Blob, name: string) => `/host/paste/${name}`),
    pasteImage: vi.fn(async () => '/host/paste/shot 1.png'),
    list: vi.fn(async () => [{ name: 'work', path: '/root/a/proj', command: 'claude', title: '' }]),
    dirs: vi.fn(async () => [{ root: '/root/a', dirs: [] }]),
    filesList: vi.fn(async (_root: string, sub: string) =>
      sub === 'proj'
        ? [
            { name: 'src', kind: 'dir', size: 0, mtime: 0, hidden: false },
            { name: 'README.md', kind: 'file', size: 1, mtime: 0, hidden: false },
            { name: '.env', kind: 'file', size: 1, mtime: 0, hidden: true },
            ...(opts.spaced
              ? [
                  { name: 'my notes.md', kind: 'file', size: 1, mtime: 0, hidden: false },
                  { name: 'old docs', kind: 'dir', size: 0, mtime: 0, hidden: false },
                ]
              : []),
          ]
        : sub === 'proj/src'
          ? [{ name: 'main.ts', kind: 'file', size: 1, mtime: 0, hidden: false }]
          : sub === 'proj/old docs'
            ? [{ name: 'plan v2.md', kind: 'file', size: 1, mtime: 0, hidden: false }]
            : [],
    ),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const composer = mountComposer(host, opts.session ?? 'work', {
    transport: transport as unknown as Transport,
    live,
    thread,
  });
  return {
    host,
    composer,
    field: host.querySelector<HTMLTextAreaElement>('textarea')!,
    send: host.querySelector<HTMLButtonElement>('.th-composer__send')!,
    acts,
    keys,
    locals,
    refreshes,
    nextAct,
    screen,
    shown,
    feedTail,
    live: live as unknown as Fx['live'],
    transport: transport as unknown as Fx['transport'],
    emit: () => {
      for (const fn of subs) fn();
    },
  };
}

function type(fx: Fx, text: string, caret = text.length): void {
  fx.field.value = text;
  fx.field.setSelectionRange(caret, caret);
  fx.field.dispatchEvent(new Event('input', { bubbles: true }));
}
function key(fx: Fx, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  fx.field.dispatchEvent(ev);
  return ev;
}
const options = (fx: Fx): string[] => [...fx.host.querySelectorAll('.th-composer__opt')].map((o) => o.textContent ?? '');

let fx: Fx;
beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  setTermPrefs({ enterSends: true });
  document.body.replaceChildren();
});
afterEach(() => {
  fx?.composer.teardown();
  document.body.replaceChildren();
});

describe('отправка', () => {
  it('Enter отправляет запрос, сообщение встаёт в переписку «отправляется», поле пустеет, приращение запрошено', async () => {
    fx = mount();
    type(fx, 'сделай тесты');
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: 'сделай тесты' }]);
    expect(fx.locals).toHaveLength(1);
    // «Отправляется» живёт только до ответа на act: агент принял — «отправлено».
    expect(fx.locals[0]).toMatchObject({ text: 'сделай тесты', state: 'sent', delivered: true });
    expect(fx.field.value).toBe('');
    expect(fx.refreshes.n).toBeGreaterThan(0);
  });

  it('пока act не ответил — «отправляется»; у работающего агента после ответа — «в очереди»', async () => {
    fx = mount();
    let release!: (r: ActResult) => void;
    fx.nextAct.value = new Promise<ActResult>((res) => (release = res));
    type(fx, 'первое');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals[0]).toMatchObject({ state: 'sending', delivered: false });
    release({ ok: true, screen: IDLE });
    await flush();
    expect(fx.locals[0]).toMatchObject({ state: 'sent', delivered: true });
    fx.nextAct.value = { ok: true, screen: IDLE };
    fx.screen.value = { ...IDLE, kind: 'working' };
    type(fx, 'второе');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals[1]).toMatchObject({ text: 'второе', state: 'queued', delivered: true });
  });

  it('слэш-команда после успеха — строка «команда отправлена», а путь с ведущим слэшем — обычное сообщение', async () => {
    fx = mount();
    await flush();
    type(fx, '/usage');
    key(fx, 'Enter');
    await flush();
    type(fx, '/usage');
    key(fx, 'Enter');
    await flush();
    type(fx, '/root/a/file.ts посмотри');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals.map((l) => [l.text, l.state, l.delivered])).toEqual([
      ['/usage', 'command', true],
      ['/usage', 'command', true],
      ['/root/a/file.ts посмотри', 'sent', true],
    ]);
  });

  it('Shift+Enter переноса не отправляет; пустое поле не отправляется, кнопка неактивна', async () => {
    fx = mount();
    expect(fx.send.disabled).toBe(true);
    key(fx, 'Enter');
    type(fx, '   ');
    expect(fx.send.disabled).toBe(true);
    type(fx, 'строка');
    expect(fx.send.disabled).toBe(false);
    const ev = key(fx, 'Enter', { shiftKey: true });
    expect(ev.defaultPrevented).toBe(false);
    await flush();
    expect(fx.acts).toEqual([]);
  });

  it('по настройке «Enter переносит» клавиша не шлёт, кнопка шлёт', async () => {
    setTermPrefs({ enterSends: false });
    fx = mount();
    type(fx, 'один');
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([]);
    fx.send.click();
    await flush();
    expect(fx.acts).toHaveLength(1);
  });

  it('пока отправка идёт, вторая не начинается', async () => {
    fx = mount();
    let release!: (r: ActResult) => void;
    fx.nextAct.value = new Promise<ActResult>((res) => (release = res));
    type(fx, 'раз');
    key(fx, 'Enter');
    type(fx, 'два');
    expect(fx.send.disabled).toBe(true);
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toHaveLength(1);
    release({ ok: true, screen: IDLE });
    await flush();
    expect(fx.send.disabled).toBe(false);
  });

  it('агент работает — сообщение помечено «в очереди»', async () => {
    fx = mount();
    fx.screen.value = { kind: 'working' };
    type(fx, 'потом');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals[0]!.state).toBe('queued');
  });

  it('многострочный запрос уходит одним действием', async () => {
    fx = mount();
    type(fx, 'a\nb\n\nc');
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: 'a\nb\n\nc' }]);
  });
});

describe('отказы', () => {
  it('отказ агента: ошибка с причиной; «Повторить» шлёт заново', async () => {
    fx = mount();
    fx.nextAct.value = { ok: false, reason: 'no-agent', detail: 'агента нет' };
    type(fx, 'не дойдёт');
    key(fx, 'Enter');
    await flush();
    const rec = fx.locals[0]!;
    expect(rec.state).toBe('failed');
    expect(rec.note).toContain('агента нет');
    expect(rec.actions.map((a) => a.label)).toEqual([t('chat.composer.retry'), t('chat.composer.toField')]);

    // повтор снова не прошёл — кнопки на месте, текст жив
    rec.actions[0]!.run();
    await flush();
    expect(fx.acts).toHaveLength(2);
    expect(rec.state).toBe('failed');
    expect(rec.actions).toHaveLength(2);

    fx.nextAct.value = { ok: true, screen: IDLE };
    rec.actions[0]!.run();
    await flush();
    expect(fx.acts).toHaveLength(3);
    expect(fx.acts[2]).toEqual({ kind: 'prompt', text: 'не дойдёт' });
    expect(rec.state).toBe('sent');
  });

  it('«Вернуть в поле» возвращает текст и снимает запись; набранное за это время идёт следом', async () => {
    fx = mount();
    fx.nextAct.value = { ok: false, reason: 'no-agent', detail: '' };
    type(fx, 'не дойдёт');
    key(fx, 'Enter');
    await flush();
    type(fx, 'новое');
    fx.locals[0]!.actions[1]!.run();
    expect(fx.locals[0]!.removed).toBe(true);
    expect(fx.field.value).toBe('не дойдёт\nновое');
  });

  it('обрыв связи — тоже ошибка, а не потеря', async () => {
    fx = mount();
    fx.nextAct.value = new Error('network');
    type(fx, 'текст');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals[0]!.state).toBe('failed');
    expect(fx.locals[0]!.note).toBe(t('chat.composer.noConnection'));
    expect(fx.send.disabled).toBe(true); // поле пусто, текст жив в записи
  });

  it('ответа не дождались, а запрос дошёл: «Повторить» сначала перечитывает экран и ленту и второй раз не шлёт', async () => {
    fx = mount();
    fx.shown.value = [human('old', 'раньше')];
    fx.nextAct.value = new Error('act timeout');
    type(fx, 'сделай  это\nи то');
    key(fx, 'Enter');
    await flush();
    const rec = fx.locals[0]!;
    expect(rec.state).toBe('failed');
    expect(fx.acts).toHaveLength(1);

    // Агент тем временем донажимал: запрос уже в беседе.
    fx.feedTail.value = page([human('old', 'раньше'), human('new', 'сделай это\nи то')]);
    fx.nextAct.value = { ok: true, screen: IDLE };
    rec.actions[0]!.run();
    await flush();
    expect(fx.live.refresh).toHaveBeenCalledTimes(1);
    expect(fx.transport.feed).toHaveBeenCalledTimes(1);
    expect(fx.acts).toHaveLength(1);
    expect(rec.state).toBe('sent');
    expect(rec.delivered).toBe(true);
    expect(rec.actions).toHaveLength(0);
    expect(fx.refreshes.n).toBeGreaterThan(0);
  });

  it('ответа не дождались, в беседе запроса нет: «Повторить» шлёт заново; такой же давний запрос доставкой не считается', async () => {
    fx = mount();
    fx.shown.value = [human('old', 'повтори')];
    fx.nextAct.value = new Error('act timeout');
    type(fx, 'повтори');
    key(fx, 'Enter');
    await flush();
    fx.feedTail.value = page([human('old', 'повтори')]);
    fx.nextAct.value = { ok: true, screen: IDLE };
    fx.locals[0]!.actions[0]!.run();
    await flush();
    expect(fx.transport.feed).toHaveBeenCalledTimes(1);
    expect(fx.acts).toHaveLength(2);
    expect(fx.locals[0]!.delivered).toBe(true);
  });

  it('ключ попытки: первая отправка несёт key, «Повторить» после потерянного ответа шлёт тот же', async () => {
    fx = mount();
    fx.nextAct.value = new Error('act timeout');
    type(fx, 'раз');
    key(fx, 'Enter');
    await flush();
    const first = fx.keys[0];
    expect(typeof first).toBe('string');
    expect(first!.length).toBeGreaterThanOrEqual(8);
    // В беседе запроса нет — повтор уходит, и с тем же ключом: агент узнает ту же попытку.
    fx.nextAct.value = { ok: true, screen: IDLE };
    fx.locals[0]!.actions[0]!.run();
    await flush();
    expect(fx.acts).toHaveLength(2);
    expect(fx.keys[1]).toBe(first);
    // Следующее сообщение — другая попытка, ключ другой.
    type(fx, 'два');
    key(fx, 'Enter');
    await flush();
    expect(typeof fx.keys[2]).toBe('string');
    expect(fx.keys[2]).not.toBe(first);
  });

  it('ответа не дождались, и ленту перечитать не удалось: «Повторить» не шлёт вслепую', async () => {
    fx = mount();
    fx.nextAct.value = new Error('act timeout');
    type(fx, 'текст');
    key(fx, 'Enter');
    await flush();
    fx.feedTail.value = new Error('network');
    fx.nextAct.value = { ok: true, screen: IDLE };
    const rec = fx.locals[0]!;
    rec.actions[0]!.run();
    await flush();
    expect(fx.acts).toHaveLength(1);
    expect(rec.state).toBe('failed');
    expect(rec.note).toBe(t('chat.composer.noConnection'));
    expect(rec.actions.map((a) => a.label)).toEqual([t('chat.composer.retry'), t('chat.composer.toField')]);

    // Лента ответила отказом — тоже не доказательство, что запроса нет.
    fx.feedTail.value = { ok: false, reason: 'lookup-failed', detail: '' } as FeedResult;
    rec.actions[0]!.run();
    await flush();
    expect(fx.acts).toHaveLength(1);
    expect(rec.state).toBe('failed');
  });

  it('текст в строке агента: выбор «забрать» или «поверх»', async () => {
    fx = mount();
    fx.screen.value = { kind: 'idle', input: 'чужой черновик' };
    fx.nextAct.value = { ok: false, reason: 'stale', detail: '' };
    type(fx, 'мой запрос');
    key(fx, 'Enter');
    await flush();
    const rec = fx.locals[0]!;
    expect(rec.state).toBe('failed');
    expect(rec.note).toBe(t('chat.composer.agentHasText'));
    expect(rec.actions.map((a) => a.label)).toEqual([
      t('chat.composer.take'),
      t('chat.composer.over'),
      t('chat.composer.toField'),
    ]);

    // поверх
    fx.nextAct.value = { ok: true, screen: IDLE };
    rec.actions[1]!.run();
    await flush();
    expect(fx.acts.at(-1)).toEqual({ kind: 'prompt', text: 'мой запрос', over: true });
    expect(rec.state).toBe('sent');
  });

  it('«забрать»: текст агента приходит в поле перед моим, запись снимается', async () => {
    fx = mount();
    fx.screen.value = { kind: 'idle', input: 'чужой черновик' };
    fx.nextAct.value = { ok: false, reason: 'stale', detail: '' };
    type(fx, 'мой запрос');
    key(fx, 'Enter');
    await flush();
    fx.nextAct.value = { ok: true, screen: IDLE, taken: 'чужой черновик' };
    fx.locals[0]!.actions[0]!.run();
    await flush();
    expect(fx.acts.at(-1)).toEqual({ kind: 'take-input' });
    expect(fx.field.value).toBe('чужой черновик\nмой запрос');
    expect(fx.locals[0]!.removed).toBe(true);
  });

  it('агент работает, а просили «поверх» — так и говорим', async () => {
    fx = mount();
    fx.screen.value = { kind: 'idle', input: 'x' };
    fx.nextAct.value = { ok: false, reason: 'stale', detail: '' };
    type(fx, 'q');
    key(fx, 'Enter');
    await flush();
    fx.nextAct.value = { ok: false, reason: 'busy', detail: '' };
    fx.locals[0]!.actions[1]!.run();
    await flush();
    expect(fx.locals[0]!.state).toBe('failed');
    expect(fx.locals[0]!.note).toBe(t('chat.composer.busy'));
  });

  it('stale при пустой строке агента — обычный отказ без выбора', async () => {
    fx = mount();
    fx.nextAct.value = { ok: false, reason: 'stale', detail: 'экран другой' };
    type(fx, 'q');
    key(fx, 'Enter');
    await flush();
    expect(fx.locals[0]!.actions.map((a) => a.label)).toEqual([t('chat.composer.retry'), t('chat.composer.toField')]);
  });
});

describe('черновик', () => {
  it('текст переживает перемонтирование; у сессии свой', async () => {
    fx = mount({ session: 'a' });
    type(fx, 'недописанное');
    fx.composer.teardown();
    document.body.replaceChildren();
    fx = mount({ session: 'a' });
    expect(fx.field.value).toBe('недописанное');
    fx.composer.teardown();
    document.body.replaceChildren();
    fx = mount({ session: 'b' });
    expect(fx.field.value).toBe('');
  });

  it('после отправки черновик стёрт', async () => {
    fx = mount({ session: 'a' });
    type(fx, 'уйдёт');
    key(fx, 'Enter');
    await flush();
    fx.composer.teardown();
    document.body.replaceChildren();
    fx = mount({ session: 'a' });
    expect(fx.field.value).toBe('');
  });
});

const file = (name: string, type: string, size = 10): File => {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};
const pick = async (fx: Fx, ...files: File[]): Promise<void> => {
  const input = fx.host.querySelector<HTMLInputElement>('input[type=file]:not([capture])')!;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
  await flush();
};

describe('вложения', () => {
  it('файл: загрузка pasteFile, путь в тексте, миниатюра с именем; убрал — путь исчез', async () => {
    fx = mount();
    type(fx, 'посмотри');
    await pick(fx, file('report.pdf', 'application/pdf'));
    expect(fx.transport.pasteFile).toHaveBeenCalledTimes(1);
    expect(fx.transport.pasteImage).not.toHaveBeenCalled();
    expect(fx.field.value).toBe('посмотри /host/paste/report.pdf');
    const att = fx.host.querySelector('.th-att')!;
    expect(att.textContent).toContain('report.pdf');
    att.querySelector<HTMLButtonElement>('.th-att__remove')!.click();
    expect(fx.field.value).toBe('посмотри');
    expect(fx.host.querySelector('.th-att')).toBeNull();
  });

  it('картинка идёт через pasteImage, путь с пробелом закрыт обратной чертой', async () => {
    fx = mount();
    await pick(fx, file('shot.png', 'image/png'));
    expect(fx.transport.pasteImage).toHaveBeenCalledTimes(1);
    expect(fx.field.value).toBe('/host/paste/shot\\ 1.png');
  });

  it('пока вложение грузится, отправка ждёт; индикатор виден', async () => {
    fx = mount();
    let done!: (p: string) => void;
    fx.transport.pasteFile!.mockImplementationOnce(() => new Promise<string>((r) => (done = r)));
    type(fx, 'текст');
    await pick(fx, file('a.zip', 'application/zip'));
    expect(fx.host.querySelector('.th-att__progress')).not.toBeNull();
    expect(fx.send.disabled).toBe(true);
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([]);
    done('/host/paste/a.zip');
    await flush();
    expect(fx.host.querySelector('.th-att__progress')).toBeNull();
    expect(fx.send.disabled).toBe(false);
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: 'текст /host/paste/a.zip' }]);
    expect(fx.host.querySelector('.th-att')).toBeNull();
  });

  it('больше 50 МиБ — тост до загрузки, загрузки нет', async () => {
    fx = mount();
    await pick(fx, file('big.bin', 'application/octet-stream', 50 * 1024 * 1024 + 1));
    expect(fx.transport.pasteFile).not.toHaveBeenCalled();
    expect(document.querySelector('.th-toast')!.textContent).toBe(t('chat.composer.tooBig', { name: 'big.bin' }));
    expect(fx.host.querySelector('.th-att')).toBeNull();
  });

  it('отказ загрузки — тост с причиной, вложения и пути нет', async () => {
    fx = mount();
    fx.transport.pasteFile!.mockRejectedValueOnce(new Error('File is too large'));
    await pick(fx, file('a.bin', 'application/octet-stream'));
    expect(document.querySelector('.th-toast')!.textContent).toBe(
      t('chat.composer.uploadFailed', { name: 'a.bin', reason: 'File is too large' }),
    );
    expect(fx.field.value).toBe('');
    expect(fx.host.querySelector('.th-att')).toBeNull();
  });

  it('вставка из буфера и перетаскивание прикладывают файлы', async () => {
    fx = mount();
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [file('image.png', 'image/png')], getData: () => '' };
    fx.field.dispatchEvent(paste);
    await flush();
    expect(fx.transport.pasteImage).toHaveBeenCalledTimes(1);
    expect(paste.defaultPrevented).toBe(true);

    const drop = new Event('drop', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
    drop.dataTransfer = { files: [file('n.txt', 'text/plain')], types: ['Files'] };
    fx.host.querySelector('.th-composer')!.dispatchEvent(drop);
    await flush();
    expect(fx.transport.pasteFile).toHaveBeenCalledTimes(1);
    expect(fx.field.value).toContain('/host/paste/n.txt');
  });

  it('вставка текста вложением не считается', async () => {
    fx = mount();
    const paste = new Event('paste', { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
    paste.clipboardData = { files: [file('image.png', 'image/png')], getData: () => 'просто текст' };
    fx.field.dispatchEvent(paste);
    await flush();
    expect(fx.transport.pasteImage).not.toHaveBeenCalled();
    expect(paste.defaultPrevented).toBe(false);
  });

  it('пути вложений переживают перезагрузку вместе с миниатюрой-именем', async () => {
    fx = mount({ session: 'p' });
    await pick(fx, file('doc.pdf', 'application/pdf'));
    fx.composer.teardown();
    document.body.replaceChildren();
    fx = mount({ session: 'p' });
    expect(fx.field.value).toBe('/host/paste/doc.pdf');
    expect(fx.host.querySelector('.th-att')!.textContent).toContain('doc.pdf');
  });
});

describe('подсказки «/»', () => {
  it('список команд запрошен один раз на открытие; «/» показывает имена, подсказки и источник', async () => {
    fx = mount();
    await flush();
    type(fx, '/');
    await flush();
    expect(fx.transport.commands).toHaveBeenCalledTimes(1);
    const rows = options(fx);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('/compact');
    expect(rows[0]).toContain('Сжать контекст');
    expect(rows[0]).toContain(t('chat.composer.source.builtin'));
    expect(rows[1]).toContain(t('chat.composer.source.project'));
  });

  it('набор сужает; нет совпадений — рамки нет', async () => {
    fx = mount();
    await flush();
    type(fx, '/com');
    await flush();
    expect([...fx.host.querySelectorAll('.th-composer__opt-name')].map((o) => o.textContent)).toEqual(['/compact', '/commit']);
    type(fx, '/zzz');
    await flush();
    expect(fx.host.querySelector('.th-composer__suggest')!.hasAttribute('hidden')).toBe(true);
  });

  it('стрелки двигают выбор, Tab подставляет; Enter при открытом списке не отправляет', async () => {
    fx = mount();
    await flush();
    type(fx, '/co');
    await flush();
    key(fx, 'ArrowDown');
    const ev = key(fx, 'Tab');
    expect(ev.defaultPrevented).toBe(true);
    expect(fx.field.value).toBe('/commit ');
    type(fx, '/co');
    await flush();
    key(fx, 'Enter');
    expect(fx.field.value).toBe('/compact ');
    await flush();
    expect(fx.acts).toEqual([]);
  });

  it('тап по строке подставляет команду', async () => {
    fx = mount();
    await flush();
    type(fx, '/');
    await flush();
    fx.host.querySelectorAll<HTMLElement>('.th-composer__opt')[2]!.click();
    expect(fx.field.value).toBe('/review ');
  });

  it('Esc закрывает список и никуда не уходит', async () => {
    fx = mount();
    await flush();
    type(fx, '/');
    await flush();
    const ev = key(fx, 'Escape');
    expect(ev.defaultPrevented).toBe(true);
    expect(fx.host.querySelector('.th-composer__suggest')!.hasAttribute('hidden')).toBe(true);
    expect(fx.acts).toEqual([]);
  });

  it('команда не из списка отправляется как набрана', async () => {
    fx = mount();
    await flush();
    type(fx, '/что-угодно аргумент');
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: '/что-угодно аргумент' }]);
  });

  it('полностью набранная команда из списка Enter отправляет, а не подставляет', async () => {
    fx = mount();
    await flush();
    type(fx, '/review');
    await flush();
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: '/review' }]);
  });

  it('отказ списка: подсказок нет, поле работает; по первому «/» список просят ещё раз', async () => {
    fx = mount({ commands: { ok: false, reason: 'forbidden', detail: '' } });
    await flush();
    type(fx, '/');
    await flush();
    expect(fx.transport.commands).toHaveBeenCalledTimes(2);
    expect(fx.host.querySelector('.th-composer__suggest')!.hasAttribute('hidden')).toBe(true);
    type(fx, '/c');
    await flush();
    expect(fx.transport.commands).toHaveBeenCalledTimes(2); // повторная просьба одна
    key(fx, 'Enter');
    await flush();
    expect(fx.acts).toEqual([{ kind: 'prompt', text: '/c' }]);
  });

  it('обрыв при запросе списка поле не ломает', async () => {
    fx = mount({ commands: new Error('net') });
    await flush();
    type(fx, '/');
    await flush();
    expect(options(fx)).toEqual([]);
  });
});

describe('подсказки «@»', () => {
  it('файлы каталога сессии, скрытые не показываются, выбор вставляет путь', async () => {
    fx = mount();
    await flush();
    type(fx, 'глянь @');
    await flush();
    expect(fx.transport.filesList).toHaveBeenCalledWith('/root/a', 'proj');
    expect(options(fx).map((o) => o.trim())).toEqual(['src/', 'README.md']);
    type(fx, 'глянь @re');
    await flush();
    fx.host.querySelector<HTMLElement>('.th-composer__opt')!.click();
    expect(fx.field.value).toBe('глянь @README.md ');
  });

  it('каталог: выбор углубляет, подсказка остаётся на его содержимом', async () => {
    fx = mount();
    await flush();
    type(fx, '@s');
    await flush();
    fx.host.querySelector<HTMLElement>('.th-composer__opt')!.click();
    expect(fx.field.value).toBe('@src/');
    await flush();
    expect(fx.transport.filesList).toHaveBeenLastCalledWith('/root/a', 'proj/src');
    expect(options(fx).map((o) => o.trim())).toEqual(['main.ts']);
  });

  it('файл с пробелом в имени находится и вставляется в кавычках', async () => {
    fx = mount({ spaced: true });
    await flush();
    type(fx, 'глянь @my');
    await flush();
    expect(options(fx).map((o) => o.trim())).toEqual(['my notes.md']);
    fx.host.querySelector<HTMLElement>('.th-composer__opt')!.click();
    expect(fx.field.value).toBe('глянь @"my notes.md" ');
    await flush();
    expect(options(fx)).toEqual([]);
  });

  it('каталог с пробелом: кавычка остаётся открытой, набор внутри неё сужает, выбор закрывает', async () => {
    fx = mount({ spaced: true });
    await flush();
    type(fx, '@old');
    await flush();
    fx.host.querySelector<HTMLElement>('.th-composer__opt')!.click();
    expect(fx.field.value).toBe('@"old docs/');
    await flush();
    expect(fx.transport.filesList).toHaveBeenLastCalledWith('/root/a', 'proj/old docs');
    expect(options(fx).map((o) => o.trim())).toEqual(['plan v2.md']);
    type(fx, '@"old docs/plan v');
    await flush();
    expect(options(fx).map((o) => o.trim())).toEqual(['plan v2.md']);
    fx.host.querySelector<HTMLElement>('.th-composer__opt')!.click();
    expect(fx.field.value).toBe('@"old docs/plan v2.md" ');
  });

  it('гость без права files: «@» ничего не предлагает и каталог не читается', async () => {
    fx = mount({ scope: { session: 'work', write: true, files: false } });
    await flush();
    type(fx, '@');
    await flush();
    expect(fx.transport.filesList).not.toHaveBeenCalled();
    expect(options(fx)).toEqual([]);
  });

  it('выход за каталог сессии («..») не листается', async () => {
    fx = mount();
    await flush();
    type(fx, '@../');
    await flush();
    expect(fx.transport.filesList).not.toHaveBeenCalled();
  });
});

describe('кнопка камеры (история 28а)', () => {
  const original = window.matchMedia;
  const coarse = (on: boolean): void => {
    window.matchMedia = ((query: string) => ({ matches: on && query.includes('coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  };
  afterEach(() => {
    window.matchMedia = original;
  });

  it('на десктопе (точный указатель) кнопки камеры нет, «прикрепить» есть', () => {
    coarse(false);
    fx = mount();
    expect(fx.host.querySelector('.th-composer__camera')).toBeNull();
    expect(fx.host.querySelector('.th-composer__attach')).not.toBeNull();
  });

  it('на телефоне (грубый указатель) кнопка есть и открывает камеру', () => {
    coarse(true);
    fx = mount();
    const btn = fx.host.querySelector<HTMLButtonElement>('.th-composer__camera')!;
    expect(btn).not.toBeNull();
    const input = fx.host.querySelector<HTMLInputElement>('input[capture]')!;
    expect(input.accept).toBe('image/*');
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    btn.click();
    expect(click).toHaveBeenCalledTimes(1);
  });
});

describe('гость', () => {
  it('поле строится только для того, у кого есть право write (решает хозяин компонента)', () => {
    fx = mount({ scope: { session: 'work', write: true, files: true } });
    expect(fx.field).not.toBeNull();
  });
});

describe('сверка списка команд по первому «/»', () => {
  it('список при открытии — обычным чтением; несверенный список по первому «/» просят со сверкой, один раз, и подсказки обновляются', async () => {
    const extra: ChatCommand = { name: 'zeta-from-screen', source: 'screen' };
    fx = mount({
      commandsSeq: [
        { ok: true, commands: COMMANDS, verified: false },
        { ok: true, commands: [...COMMANDS, extra], verified: true },
      ],
    });
    await flush();
    expect(fx.transport.commands.mock.calls).toEqual([['work']]);
    type(fx, '/');
    await flush();
    expect(fx.transport.commands.mock.calls).toEqual([['work'], ['work', { verify: true }]]);
    expect(options(fx).some((row) => row.includes('/zeta-from-screen'))).toBe(true);
    type(fx, '/z');
    await flush();
    expect(fx.transport.commands).toHaveBeenCalledTimes(2);
  });

  it('сверенный список по «/» заново не просят; текст без «/» сверку не запускает', async () => {
    fx = mount();
    await flush();
    type(fx, 'привет');
    type(fx, '/');
    await flush();
    expect(fx.transport.commands.mock.calls).toEqual([['work']]);
  });
});

describe('сообщение в очереди агента: «Изменить» и «Отменить»', () => {
  const working = (over: Partial<ScreenState> = {}): ScreenState => ({ kind: 'working', input: '', ...over });
  const labels = (rec: LocalRec): string[] => rec.actions.map((a) => a.label);
  const queueUp = async (texts: string[]): Promise<void> => {
    for (const text of texts) {
      type(fx, text);
      key(fx, 'Enter');
      await flush();
    }
  };

  it('Codex: кнопки только у последнего сообщения очереди; «Отменить» убирает его и поле не трогает', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['первое', 'второе']);
    expect(fx.locals.map((l) => l.state)).toEqual(['queued', 'queued']);
    fx.screen.value = working({ queued: 2, queue: [{ text: 'первое' }, { text: 'второе' }], queueEdit: 'last' });
    fx.emit();
    expect(labels(fx.locals[0]!)).toEqual([]);
    expect(labels(fx.locals[1]!)).toEqual([t('chat.composer.queueEdit'), t('chat.composer.queueCancel')]);

    fx.nextAct.value = { ok: true, screen: working({ queued: 1, queue: [{ text: 'первое' }], queueEdit: 'last' }), taken: 'второе' };
    fx.locals[1]!.actions[1]!.run();
    await flush();
    expect(fx.acts.at(-1)).toEqual({ kind: 'unqueue', queued: 2 });
    expect(fx.locals[1]!.removed).toBe(true);
    expect(fx.locals[0]!.removed).toBe(false);
    expect(fx.field.value).toBe('');
    // Теперь последнее в очереди — первое сообщение: кнопки переехали к нему.
    fx.screen.value = working({ queued: 1, queue: [{ text: 'первое' }], queueEdit: 'last' });
    fx.emit();
    expect(labels(fx.locals[0]!)).toHaveLength(2);
  });

  it('«Изменить» возвращает текст сообщения в поле ввода чата', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['поправь\nвторую строку']);
    fx.screen.value = working({ queued: 1, queue: [{ text: 'поправь\nвторую строку' }], queueEdit: 'last' });
    fx.emit();
    fx.nextAct.value = { ok: true, screen: working(), taken: 'поправь\nвторую строку' };
    fx.locals[0]!.actions[0]!.run();
    await flush();
    expect(fx.acts.at(-1)).toEqual({ kind: 'unqueue', queued: 1 });
    expect(fx.locals[0]!.removed).toBe(true);
    expect(fx.field.value).toBe('поправь\nвторую строку');
  });

  it('Claude возвращает всю очередь разом: кнопки у последнего сообщения называют «все», действие снимает все', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['первое', 'второе']);
    fx.screen.value = working({ queued: 2, queue: [{ text: 'первое' }, { text: 'второе' }], queueEdit: 'all' });
    fx.emit();
    expect(labels(fx.locals[0]!)).toEqual([]);
    expect(labels(fx.locals[1]!)).toEqual([t('chat.composer.queueEditAll'), t('chat.composer.queueCancelAll')]);
    fx.nextAct.value = { ok: true, screen: working(), taken: 'первое\nвторое' };
    fx.locals[1]!.actions[0]!.run();
    await flush();
    expect(fx.locals.map((l) => l.removed)).toEqual([true, true]);
    expect(fx.field.value).toBe('первое\nвторое');
  });

  it('кнопок нет, пока экран агента возврат не называет, и когда в очереди агента не наше сообщение', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['моё']);
    fx.screen.value = working({ queued: 1, queue: [{ text: 'моё' }] });
    fx.emit();
    expect(labels(fx.locals[0]!)).toEqual([]);
    fx.screen.value = working({ queued: 2, queue: [{ text: 'моё' }, { text: 'набрано в терминале' }], queueEdit: 'last' });
    fx.emit();
    expect(labels(fx.locals[0]!)).toEqual([]);
    // Обрезанное агентом сообщение сверяется по началу.
    fx.screen.value = working({ queued: 1, queue: [{ text: 'мо', cut: true }], queueEdit: 'last' });
    fx.emit();
    expect(labels(fx.locals[0]!)).toHaveLength(2);
  });

  it('очередь на экране агента опустела — пометка «в очереди» снята, даже если записи в беседе не будет', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['первое', 'второе']);
    // Экран ещё не показал очередь — пометка держится.
    fx.emit();
    expect(fx.locals.map((l) => l.state)).toEqual(['queued', 'queued']);
    fx.screen.value = working({ queued: 2, queue: [{ text: 'первое' }, { text: 'второе' }] });
    fx.emit();
    // Агент забрал первое сообщение посреди хода.
    fx.screen.value = working({ queued: 1, queue: [{ text: 'второе' }] });
    fx.emit();
    expect(fx.locals.map((l) => l.state)).toEqual(['sent', 'queued']);
    expect(fx.locals[0]).toMatchObject({ delivered: true, removed: false });
    // Экран не у строки ввода (вопрос) об очереди ничего не говорит.
    fx.screen.value = { kind: 'question' };
    fx.emit();
    expect(fx.locals[1]!.state).toBe('queued');
    // Ход закончился, очереди нет.
    fx.screen.value = { kind: 'idle', input: '' };
    fx.emit();
    expect(fx.locals.map((l) => l.state)).toEqual(['sent', 'sent']);
  });

  it('отказ агента: сообщение остаётся «в очереди», поле не тронуто, причина показана', async () => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp(['моё']);
    fx.screen.value = working({ queued: 1, queue: [{ text: 'моё' }], queueEdit: 'last' });
    fx.emit();
    fx.nextAct.value = { ok: false, reason: 'stale', detail: 'the agent queue has changed' };
    fx.locals[0]!.actions[1]!.run();
    await flush();
    expect(fx.locals[0]).toMatchObject({ removed: false, state: 'queued' });
    expect(fx.locals[0]!.note).toContain('the agent queue has changed');
    expect(fx.field.value).toBe('');
  });

  // Слепая приёмка: «808ms CLICK edit → 1022ms live q=null → 1286ms act:unqueue» — опрос
  // экрана внутри действия показывает пустую очередь (сообщение уже вытащено клавишей).
  const pendingAct = (): { resolve(res: ActResult): void } => {
    let resolve!: (res: ActResult) => void;
    fx.nextAct.value = new Promise<ActResult>((r) => (resolve = r));
    return { resolve };
  };
  const queuedOne = async (text: string): Promise<void> => {
    fx = mount();
    fx.screen.value = working();
    fx.nextAct.value = { ok: true, screen: working() };
    await queueUp([text]);
    fx.screen.value = working({ queued: 1, queue: [{ text }], queueEdit: 'last' });
    fx.emit();
  };

  it('«Отменить»: опрос экрана посреди действия видит пустую очередь — запись не помечается «отправлено» и убирается', async () => {
    await queuedOne('лишнее');
    const act = pendingAct();
    fx.locals[0]!.actions[1]!.run();
    await flush();
    fx.screen.value = working();
    fx.emit();
    expect(fx.locals[0]).toMatchObject({ state: 'queued', removed: false });
    act.resolve({ ok: true, screen: working(), taken: 'лишнее' });
    await flush();
    expect(fx.locals[0]).toMatchObject({ state: 'queued', removed: true });
    expect(fx.field.value).toBe('');
  });

  it('«Изменить»: тот же опрос посреди действия — запись убрана, её текст в поле ввода', async () => {
    await queuedOne('поправлю');
    const act = pendingAct();
    fx.locals[0]!.actions[0]!.run();
    await flush();
    fx.screen.value = { kind: 'idle', input: '' };
    fx.emit();
    expect(fx.locals[0]!.state).toBe('queued');
    act.resolve({ ok: true, screen: working(), taken: 'поправлю' });
    await flush();
    expect(fx.locals[0]).toMatchObject({ state: 'queued', removed: true });
    expect(fx.field.value).toBe('поправлю');
  });

  it('отказ посреди действия возвращает запись под обычную сверку: пустая очередь экрана снимает пометку', async () => {
    await queuedOne('останется');
    const act = pendingAct();
    fx.locals[0]!.actions[1]!.run();
    await flush();
    fx.screen.value = working();
    fx.emit();
    expect(fx.locals[0]!.state).toBe('queued');
    act.resolve({ ok: false, reason: 'stale', detail: 'the agent queue has changed' });
    await flush();
    expect(fx.locals[0]).toMatchObject({ state: 'sent', removed: false, delivered: true });
  });
});
