// @vitest-environment happy-dom
// Живая часть чата: опрос экрана, полоса состояния и «Стоп», карточка вопроса, режим,
// модель, контекст и расход, окошко терминала, плашка версии, обрыв связи.
// Транспорт подделан (единственный шов); экраны — по форме провода из interfaces.md.
import type { ActResult, ChatAction, LiveResult, LiveState, ScreenState } from '@termhub/protocol/chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { healthRows } from '../src/chat-health';
import { mountLive, type LiveHandle, type LiveHost } from '../src/chat-live';
import { setLang, t } from '../src/i18n';
import type { Transport } from '../src/transport';

const mountedTerms: Array<{ opts: unknown; torn: boolean }> = [];
vi.mock('../src/term', () => ({
  mountTerminal: (_root: HTMLElement, _s: string, _t: Transport, opts: unknown) => {
    const rec = { opts, torn: false };
    mountedTerms.push(rec);
    return { focus() {}, teardown: () => { rec.torn = true; } };
  },
}));

const MODES = [
  { id: 'manual', label: 'Ручной' },
  { id: 'plan', label: 'План' },
];
function live(screen: ScreenState, over: Partial<LiveState> = {}): LiveState {
  return { ok: true, agent: 'claude', version: '2.1.322', tested: true, model: 'opus', screen, modes: MODES, models: [{ id: 'opus', label: 'Opus' }], ...over };
}
const IDLE: ScreenState = { kind: 'idle', mode: 'manual' };
const QUESTION: ScreenState = {
  kind: 'question',
  question: {
    stamp: 'S1',
    title: 'Какой файл править?',
    options: [
      { key: '1', label: 'a.ts', selected: true },
      { key: '2', label: 'b.ts' },
    ],
  },
};

interface Fx {
  transport: Transport;
  liveCalls: number;
  acts: ChatAction[];
  next: (r: LiveResult | Error) => void;
  actNext: (r: ActResult | Error) => void;
  usage: { value: unknown };
}
function fixture(first: LiveResult, clientScope: unknown = null): Fx {
  let current: LiveResult | Error = first;
  let actAnswer: ActResult | Error = { ok: true, screen: IDLE };
  const fx: Fx = {
    liveCalls: 0,
    acts: [],
    next: (r) => { current = r; },
    actNext: (r) => { actAnswer = r; },
    usage: { value: { ok: false, reason: 'no-agent', detail: '' } },
    transport: null as unknown as Transport,
  };
  fx.transport = {
    mode: 'lan',
    clientScope,
    live: async () => {
      fx.liveCalls += 1;
      if (current instanceof Error) throw current;
      return current;
    },
    act: async (_s: string, a: ChatAction) => {
      fx.acts.push(a);
      if (actAnswer instanceof Error) throw actAnswer;
      return actAnswer;
    },
    feed: async () => fx.usage.value,
  } as unknown as Transport;
  return fx;
}

const totals = { input: 10, cached: 2000, cacheWrite: 0, output: 500, turns: 3, activeMs: 60_000 };
const USAGE = (context?: { used: number; limit?: number }): unknown => ({
  ok: true, agent: 'claude', total: totals, today: { ...totals, input: 100, cached: 0, output: 900 }, started: 1, last: 2, context,
});

let host: LiveHost;
let wrap: HTMLElement;
let handle: LiveHandle | undefined;
const slot = (): HTMLElement => document.createElement('div');
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setLang('ru');
  mountedTerms.length = 0;
  document.body.replaceChildren();
  wrap = document.createElement('div');
  host = { status: slot(), question: slot(), terminal: slot(), composer: slot() };
  wrap.append(host.status, host.question, host.terminal, host.composer);
  document.body.append(wrap);
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});
afterEach(() => {
  handle?.teardown();
  handle = undefined;
  vi.useRealTimers();
});

const run = async (ms = 0): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
};
async function mount(fx: Fx): Promise<LiveHandle> {
  handle = mountLive(host, 'work', fx.transport);
  await run(0);
  return handle;
}
const q = <T extends HTMLElement = HTMLElement>(sel: string): T | null => document.body.querySelector<T>(sel);
const qa = (sel: string): HTMLElement[] => [...document.body.querySelectorAll<HTMLElement>(sel)];
const toasts = (): string[] => qa('.th-toast').map((n) => n.textContent ?? '');

describe('опрос экрана', () => {
  it('раз в секунду при показанной вкладке и видимой странице; скрыли — стоит', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    expect(fx.liveCalls).toBe(1);
    await run(3000);
    expect(fx.liveCalls).toBe(4);
    // вкладка чата неактивна
    const view = document.createElement('div');
    view.className = 'th-ws-view';
    wrap.replaceWith(view);
    view.append(wrap);
    await run(3000);
    expect(fx.liveCalls).toBe(4);
    view.classList.add('is-active');
    await run(1000);
    expect(fx.liveCalls).toBe(5);
    // страница скрыта
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await run(3000);
    expect(fx.liveCalls).toBe(5);
  });
});

describe('полоса состояния', () => {
  it('называет состояние, время работы и очередь; «Стоп» — только при работе и шлёт interrupt', async () => {
    const fx = fixture(live({ kind: 'idle', mode: 'manual' }));
    await mount(fx);
    expect(q('.th-live__state')!.textContent).toContain(t('chat.live.idle'));
    expect(q('.th-live__stop')!.hidden).toBe(true);

    fx.next(live({ kind: 'working', status: 'Thinking…', elapsed: 65, queued: 2 }));
    await run(1000);
    // Слово состояния — то, что рисует агент; время — как у агента.
    expect(q('.th-live__state')!.textContent).toBe('Thinking… · 1m 5s');
    fx.next(live({ kind: 'working', elapsed: 65 }));
    await run(1000);
    expect(q('.th-live__state')!.textContent).toBe(`${t('chat.live.working')} · 1m 5s`);
    fx.next(live({ kind: 'working', status: 'Thinking…', elapsed: 65, queued: 2 }));
    await run(1000);
    expect(q('.th-live__queued')!.textContent).toBe(t('chat.live.queued', { n: 2 }));
    const stop = q<HTMLButtonElement>('.th-live__stop')!;
    expect(stop.hidden).toBe(false);
    fx.actNext({ ok: true, screen: IDLE });
    stop.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'interrupt' }]);

    fx.next(live({ kind: 'question', question: QUESTION.question }));
    await run(1000);
    expect(q('.th-live__state')!.textContent).toContain(t('chat.live.asking'));
    expect(q('.th-live__queued')!.hidden).toBe(true);
  });

  it('смена состояния сообщает подписчику changed=true, то же состояние — false', async () => {
    const fx = fixture(live(IDLE));
    const calls: boolean[] = [];
    handle = mountLive(host, 'work', fx.transport, (_s, changed) => calls.push(changed));
    await run(0);
    fx.next(live({ kind: 'working' }));
    await run(1000);
    await run(1000);
    expect(calls).toEqual([true, true, false]);
  });
});

describe('карточка вопроса', () => {
  it('текст и кнопка на вариант; нажатие шлёт answer с отпечатком, пришедшим с агента', async () => {
    const fx = fixture(live(QUESTION));
    await mount(fx);
    expect(q('.th-live-q__title')!.textContent).toBe('Какой файл править?');
    const opts = qa('.th-live-q__opt');
    expect(opts.map((o) => o.textContent)).toEqual(['a.ts', 'b.ts']);
    fx.actNext({ ok: true, screen: IDLE });
    opts[1]!.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'answer', stamp: 'S1', option: '2' }]);
    // ответ принят — карточка гаснет по экрану из ответа
    expect(q('.th-live-q')).toBeNull();
  });

  it('запрос разрешения показывает тело (команду) над вариантами', async () => {
    const screen: ScreenState = {
      kind: 'permission',
      question: { stamp: 'P', title: 'Выполнить команду?', body: 'rm -rf build', options: [{ key: '1', label: 'Да' }, { key: '3', label: 'Нет' }] },
    };
    await mount(fixture(live(screen)));
    expect(q('.th-live-q__body')!.textContent).toBe('rm -rf build');
    expect(qa('.th-live-q__opt')).toHaveLength(2);
  });

  it('свободный ответ — только там, где экран его объявил', async () => {
    const withFree: ScreenState = {
      kind: 'question',
      question: {
        stamp: 'F', title: 'Что дальше?', freeText: true,
        options: [{ key: '1', label: 'Да' }, { key: '4', label: 'Type something', free: true }],
      },
    };
    const fx = fixture(live(withFree));
    await mount(fx);
    expect(qa('.th-live-q__opt').map((o) => o.textContent)).toEqual(['Да']); // свободный вариант — не кнопка
    const input = q<HTMLInputElement>('.th-live-q__free input, .th-live-q__free textarea')!;
    input.value = 'свой текст';
    fx.actNext({ ok: true, screen: IDLE });
    q<HTMLButtonElement>('.th-live-q__free button')!.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'answer', stamp: 'F', text: 'свой текст' }]);

    handle!.teardown();
    host.question.replaceChildren();
    const plain = fixture(live(QUESTION));
    await mount(plain);
    expect(q('.th-live-q__free')).toBeNull();
  });

  it('несколько отметок: отмечаю, жму «Ответить» — options полным набором клавиш', async () => {
    const multi: ScreenState = {
      kind: 'question',
      question: {
        stamp: 'M', title: 'Что включить?', multi: true,
        options: [{ key: '1', label: 'A', checked: true }, { key: '2', label: 'B' }, { key: '3', label: 'C' }],
      },
    };
    const fx = fixture(live(multi));
    await mount(fx);
    const opts = qa('.th-live-q__opt');
    expect(opts[0]!.getAttribute('aria-pressed')).toBe('true');
    opts[2]!.click();
    opts[0]!.click(); // снял A
    expect(opts[2]!.getAttribute('aria-pressed')).toBe('true');
    await run(1000); // опрос не сбрасывает отметки человека
    expect(qa('.th-live-q__opt')[2]!.getAttribute('aria-pressed')).toBe('true');
    expect(fx.acts).toEqual([]);
    fx.actNext({ ok: true, screen: IDLE });
    q<HTMLButtonElement>('.th-live-q__submit')!.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'answer', stamp: 'M', options: ['3'] }]);
  });

  it('stale: «вопрос уже не актуален» и немедленное перечитывание экрана', async () => {
    const fx = fixture(live(QUESTION));
    await mount(fx);
    const before = fx.liveCalls;
    fx.actNext({ ok: false, reason: 'stale', detail: 'screen changed' });
    fx.next(live(IDLE));
    qa('.th-live-q__opt')[0]!.click();
    await run(0);
    expect(toasts()).toContain(t('chat.live.stale'));
    expect(fx.liveCalls).toBe(before + 1);
    expect(q('.th-live-q')).toBeNull();
  });

  it('вопрос исчез с экрана (ответили в терминале) — карточка гаснет', async () => {
    const fx = fixture(live(QUESTION));
    await mount(fx);
    expect(q('.th-live-q')).not.toBeNull();
    fx.next(live(IDLE));
    await run(1000);
    expect(q('.th-live-q')).toBeNull();
  });

  it('гость: карточка видна, кнопки неактивны с подписью; Стоп, режима, модели и сжатия нет', async () => {
    const fx = fixture(live(QUESTION), { write: false, files: false });
    await mount(fx);
    expect(qa('.th-live-q__opt').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(q('.th-live-q__readonly')!.textContent).toBe(t('chat.live.viewOnly'));
    fx.next(live({ kind: 'working', mode: 'manual' }));
    await run(1000);
    for (const sel of ['.th-live__stop', '.th-live__mode', '.th-live__model', '.th-live__compact']) {
      const el = q(sel);
      expect(el === null || el.hidden, sel).toBe(true);
    }
  });
});

describe('режим', () => {
  it('показывает режим с экрана; после выбора — фактический из ответа; не совпал — тост и сбой', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    const select = q<HTMLSelectElement>('.th-live__mode')!;
    expect(select.value).toBe('manual');
    fx.actNext({ ok: true, screen: { kind: 'idle', mode: 'manual' } }); // агент остался в прежнем
    select.value = 'plan';
    select.dispatchEvent(new Event('change'));
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'mode', to: 'plan' }]);
    expect(toasts().some((x) => x.includes('Ручной'))).toBe(true);
    expect(q<HTMLSelectElement>('.th-live__mode')!.value).toBe('manual');
    expect(healthRows()[0]).toMatchObject({ session: 'work', counts: { mode: 1 } });

    fx.actNext({ ok: true, screen: { kind: 'idle', mode: 'plan' } });
    q<HTMLSelectElement>('.th-live__mode')!.value = 'plan';
    q('.th-live__mode')!.dispatchEvent(new Event('change'));
    await run(0);
    expect(q<HTMLSelectElement>('.th-live__mode')!.value).toBe('plan');
    expect(healthRows()[0]!.counts.mode).toBe(1);
  });
});

describe('модель', () => {
  it('названа; смена шлёт model с пустым to, меню агента открывается окошком терминала без сбоя', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    expect(q('.th-live__model')!.textContent).toContain('Opus');
    fx.actNext({ ok: true, screen: { kind: 'menu', menu: 'model' } });
    q<HTMLButtonElement>('.th-live__model')!.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'model', to: '' }]);
    await run(0);
    expect(mountedTerms).toHaveLength(1);
    expect(mountedTerms[0]!.opts).toMatchObject({ embedded: true, passive: true });
    expect(healthRows()).toEqual([]);
    // выбрали в меню — состояние свежее: модель названа новая, окошко свернулось
    fx.next(live({ kind: 'idle', mode: 'manual' }, { model: 'sonnet', models: [{ id: 'sonnet', label: 'Sonnet' }] }));
    await run(2000); // узнан два опроса подряд
    expect(q('.th-live__model')!.textContent).toContain('Sonnet');
    expect(mountedTerms[0]!.torn).toBe(true);
  });

  it('меню не появилось — тост и запись сбоя', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    fx.actNext({ ok: true, screen: IDLE });
    q<HTMLButtonElement>('.th-live__model')!.click();
    await run(0);
    expect(toasts()).toContain(t('chat.live.modelNoMenu'));
    expect(healthRows()[0]).toMatchObject({ counts: { model: 1 } });
  });

  it('у Codex модель называет экран', async () => {
    await mount(fixture(live({ kind: 'idle', model: 'gpt-5-codex' }, { agent: 'codex', model: undefined, models: [] })));
    expect(q('.th-live__model')!.textContent).toContain('gpt-5-codex');
  });
});

describe('контекст и расход', () => {
  it('доля занятого и расход за сегодня; в подсказке — занято из предела и расход беседы', async () => {
    const fx = fixture(live(IDLE));
    fx.usage.value = USAGE({ used: 84_000, limit: 200_000 });
    await mount(fx);
    const ctx = q('.th-live__ctx')!;
    expect(ctx.textContent).toContain('42%');
    expect(ctx.textContent).toContain('1.0k'); // сегодня: 100 + 900
    expect(ctx.title).toContain('84.0k');
    expect(ctx.title).toContain('200.0k');
    expect(ctx.title).toContain('2.5k'); // вся беседа: 10 + 2000 + 500
  });

  it('предел неизвестен — число занятых токенов; нет данных — прочерк', async () => {
    const fx = fixture(live(IDLE));
    fx.usage.value = USAGE({ used: 84_000 });
    await mount(fx);
    expect(q('.th-live__ctx')!.textContent).toContain('84.0k');
    expect(q('.th-live__ctx')!.textContent).not.toContain('%');
    handle!.teardown();
    fx.usage.value = USAGE(undefined);
    await mount(fx);
    expect(q('.th-live__ctx')!.textContent).toContain('—');
  });

  it('сжатие шлёт compact и неактивно, пока агент работает', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    const btn = q<HTMLButtonElement>('.th-live__compact')!;
    expect(btn.disabled).toBe(false);
    fx.actNext({ ok: true, screen: { kind: 'working' } });
    btn.click();
    await run(0);
    expect(fx.acts).toEqual([{ kind: 'compact' }]);
    expect(q<HTMLButtonElement>('.th-live__compact')!.disabled).toBe(true);
  });
});

describe('окошко терминала', () => {
  it('unknown: ни карточки, ни переключателей; сбой пишется один раз; окошко открыто', async () => {
    const fx = fixture(live({ kind: 'unknown' }));
    await mount(fx);
    await run(3000);
    expect(q('.th-live-q')).toBeNull();
    for (const sel of ['.th-live__mode', '.th-live__model', '.th-live__compact', '.th-live__stop']) {
      const el = q(sel);
      expect(el === null || el.hidden, sel).toBe(true);
    }
    expect(mountedTerms).toHaveLength(1);
    expect(healthRows()[0]).toMatchObject({ agent: 'claude', version: '2.1.322', counts: { unknown: 1 } });
  });

  it('menu открывает окошко без записи сбоя; экран узнан — окошко сворачивается', async () => {
    const fx = fixture(live({ kind: 'menu', menu: 'resume' }));
    await mount(fx);
    await run(1000);
    expect(mountedTerms).toHaveLength(1);
    expect(healthRows()).toEqual([]);
    fx.next(live(IDLE));
    await run(2000);
    expect(mountedTerms[0]!.torn).toBe(true);
  });

  it('«Показать терминал» открывает в любой момент и держит, пока не скрыли', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    const btn = q<HTMLButtonElement>('.th-live__term-btn')!;
    expect(btn.textContent).toBe(t('chat.live.showTerm'));
    btn.click();
    await run(0);
    expect(mountedTerms).toHaveLength(1);
    await run(2000); // экран знаком, но окошко открыл человек
    expect(mountedTerms[0]!.torn).toBe(false);
    expect(q('.th-live__term-btn')!.textContent).toBe(t('chat.live.hideTerm'));
    q<HTMLButtonElement>('.th-live__term-btn')!.click();
    await run(0);
    expect(mountedTerms[0]!.torn).toBe(true);
  });
  it('закрытое кнопкой окно само не возвращается, пока экран не стал знакомым и снова неузнанным', async () => {
    const fx = fixture(live({ kind: 'unknown' }));
    await mount(fx);
    await run(1000);
    expect(mountedTerms).toHaveLength(1);
    q<HTMLButtonElement>('.th-chat-term__close')!.click();
    expect(mountedTerms[0]!.torn).toBe(true);
    expect(q('.th-live__term-btn')!.textContent).toBe(t('chat.live.showTerm'));
    await run(3000); // экран всё ещё не узнан
    expect(mountedTerms).toHaveLength(1);
    fx.next(live(IDLE));
    await run(2000);
    fx.next(live({ kind: 'unknown' }));
    await run(2000);
    expect(mountedTerms).toHaveLength(2);
    expect(mountedTerms[1]!.torn).toBe(false);
  });

  it('открытое вручную окно закрывается своей кнопкой и не держится дальше', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    q<HTMLButtonElement>('.th-live__term-btn')!.click();
    await run(0);
    q<HTMLButtonElement>('.th-chat-term__close')!.click();
    await run(2000);
    expect(mountedTerms).toHaveLength(1);
    expect(mountedTerms[0]!.torn).toBe(true);
  });

  it('шапка окна называет причину: текст распознавания, название меню, «открыто вручную», а без причины — «не узнан»', async () => {
    const why = (): string => q('.th-chat-term__why')!.textContent ?? '';
    const fx = fixture(live({ kind: 'unknown', why: 'no input box under the footer' }));
    await mount(fx);
    await run(1000);
    expect(why()).toBe(`${t('chat.term.why')} no input box under the footer`);
    expect(healthRows()[0]).toMatchObject({ session: 'work', why: 'no input box under the footer' });
    expect(healthRows()[0]!.whyAt).toBeGreaterThan(0);
    fx.next(live({ kind: 'unknown' }));
    await run(1000);
    expect(why()).toBe(t('chat.term.whyUnknown'));
    fx.next(live({ kind: 'menu', menu: 'resume' }));
    await run(1000);
    expect(why()).toBe(t('chat.term.whyMenu', { menu: 'resume' }));
    fx.next(live(IDLE));
    await run(2000);
    q<HTMLButtonElement>('.th-live__term-btn')!.click();
    await run(0);
    expect(why()).toBe(t('chat.term.whyManual'));
  });
});

describe('вид не скачет', () => {
  const UNKNOWN: ScreenState = { kind: 'unknown', why: 'footer not found' };
  const termShown = (): boolean => !q('.th-chat-term')!.hidden;

  it('одиночный неузнанный кадр между узнанными окно не открывает и состояние на экране не трогает', async () => {
    const fx = fixture(live(IDLE));
    const h = await mount(fx);
    const seen: string[] = [];
    h.subscribe((s, changed) => seen.push(`${s?.screen.kind ?? 'null'}:${changed}`));
    fx.next(live(UNKNOWN));
    await run(1000);
    expect(termShown()).toBe(false);
    expect(mountedTerms).toHaveLength(0);
    expect(h.state()!.screen.kind).toBe('idle');
    expect(q('.th-live__state')!.textContent).toBe(t('chat.live.idle'));
    expect(q('.th-live__mode')!.hidden).toBe(false);
    fx.next(live(IDLE));
    await run(3000);
    expect(mountedTerms).toHaveLength(0);
    expect(healthRows()).toEqual([]);
    expect(seen.filter((x) => x.endsWith(':true'))).toEqual([]);
  });

  it('два неузнанных опроса подряд открывают окно; один узнанный его не сворачивает, два подряд — сворачивают', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    fx.next(live(UNKNOWN));
    await run(1000);
    expect(termShown()).toBe(false);
    await run(1000);
    expect(termShown()).toBe(true);
    expect(mountedTerms).toHaveLength(1);
    // Мигнул узнанный кадр (список фоновых агентов пропал и вернулся) — окно на месте.
    fx.next(live(IDLE));
    await run(1000);
    fx.next(live(UNKNOWN));
    await run(1000);
    expect(termShown()).toBe(true);
    expect(mountedTerms).toHaveLength(1);
    expect(mountedTerms[0]!.torn).toBe(false);
    expect(q('.th-chat-term__why')!.textContent).toBe(`${t('chat.term.why')} footer not found`);
    fx.next(live(IDLE));
    await run(1000);
    expect(termShown()).toBe(true);
    await run(1000);
    expect(termShown()).toBe(false);
    expect(mountedTerms[0]!.torn).toBe(true);
  });

  it('меню два опроса подряд открывает окно так же', async () => {
    const fx = fixture(live(IDLE));
    await mount(fx);
    fx.next(live({ kind: 'menu', menu: 'resume' }));
    await run(1000);
    expect(termShown()).toBe(false);
    await run(1000);
    expect(termShown()).toBe(true);
  });

  it('сбой «экран не узнан» пишется один раз на эпизод: ни на каждый опрос, ни на мигание внутри него', async () => {
    const fx = fixture(live(UNKNOWN));
    await mount(fx);
    await run(4000);
    fx.next(live(IDLE));
    await run(1000);
    fx.next(live(UNKNOWN));
    await run(3000);
    fx.next(live({ kind: 'menu', menu: 'resume' }));
    await run(1000);
    fx.next(live(UNKNOWN));
    await run(2000);
    expect(healthRows()[0]!.counts.unknown).toBe(1);
    // Эпизод кончился и начался новый — второй сбой.
    fx.next(live(IDLE));
    await run(2000);
    fx.next(live(UNKNOWN));
    await run(2000);
    expect(healthRows()[0]!.counts.unknown).toBe(2);
  });

  it('закрытое кнопкой окно не возвращается на том же эпизоде, даже если мигнул узнанный кадр', async () => {
    const fx = fixture(live(UNKNOWN));
    await mount(fx);
    await run(1000);
    expect(mountedTerms).toHaveLength(1);
    q<HTMLButtonElement>('.th-chat-term__close')!.click();
    fx.next(live(IDLE));
    await run(1000);
    fx.next(live(UNKNOWN));
    await run(5000);
    expect(mountedTerms).toHaveLength(1);
    expect(termShown()).toBe(false);
  });
});

describe('версия агента', () => {
  it('непроверенная версия — плашка один раз на версию; работа не блокируется', async () => {
    const fx = fixture(live(IDLE, { tested: false, version: '9.9.9' }));
    await mount(fx);
    const notice = q('.th-live__notice')!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('9.9.9');
    expect(q<HTMLButtonElement>('.th-live__compact')!.disabled).toBe(false);
    handle!.teardown();
    host.status.replaceChildren();
    await mount(fx); // вторая вкладка на той же версии
    expect(q('.th-live__notice')).toBeNull();
  });

  it('проверенная версия плашки не даёт', async () => {
    await mount(fixture(live(IDLE)));
    expect(q('.th-live__notice')).toBeNull();
  });
});

describe('связь', () => {
  it('нет связи — полоса так и говорит, кнопки неактивны; вернулась — обновилось само', async () => {
    const fx = fixture(live(QUESTION));
    await mount(fx);
    fx.next(new Error('network'));
    await run(1000);
    expect(q('.th-live__state')!.textContent).toContain(t('chat.live.offline'));
    expect(qa('.th-live-q__opt').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    fx.next(live(IDLE));
    await run(1000);
    expect(q('.th-live__state')!.textContent).toContain(t('chat.live.idle'));
    expect(q('.th-live-q')).toBeNull();
  });

  it('сессия без агента (отказ) — ни полосы, ни карточки', async () => {
    await mount(fixture({ ok: false, reason: 'no-agent', detail: '' }));
    expect(q('.th-live__state')?.textContent ?? '').toBe('');
    expect(q('.th-live-q')).toBeNull();
  });
});

describe('для поля ввода', () => {
  it('state() называет последнее состояние, act() шлёт действие и применяет экран из ответа', async () => {
    const fx = fixture(live(IDLE));
    const h = await mount(fx);
    expect(h.state()!.screen.kind).toBe('idle');
    fx.actNext({ ok: true, screen: { kind: 'working' } });
    const res = await h.act({ kind: 'prompt', text: 'привет' });
    expect(res.ok).toBe(true);
    expect(h.state()!.screen.kind).toBe('working');
    const seen: string[] = [];
    h.subscribe((s) => seen.push(s?.screen.kind ?? 'null'));
    fx.next(live(IDLE));
    await run(1000);
    expect(seen).toEqual(['idle']);
  });
});

describe('фоновые агенты и команды', () => {
  const AGENTS = [
    { type: 'general-purpose', task: 'Run the tests', elapsed: 122, tokens: 94_300 },
    { type: 'Explore', task: 'Check the build' },
  ];
  const BG: ScreenState = { ...IDLE, shells: 1, agents: AGENTS };
  const sheet = (): HTMLElement => q('.th-live__sheet')!;
  const rows = (): string[] => qa('.th-live__sheet-row').map((n) => n.textContent ?? '');

  it('после контекста стоят «агенты: N» и «команды: N»; экран без них — пунктов нет', async () => {
    const fx = fixture(live(BG));
    await mount(fx);
    const agents = q('.th-live__bg--agents')!;
    const shells = q('.th-live__bg--shells')!;
    expect(agents.hidden).toBe(false);
    expect(agents.textContent).toBe(t('chat.live.bgAgents', { n: 2 }));
    expect(shells.hidden).toBe(false);
    expect(shells.textContent).toBe(t('chat.live.bgShells', { n: 1 }));
    const order = [...q('.th-live__controls')!.children];
    expect(order.indexOf(agents)).toBeGreaterThan(order.indexOf(q('.th-live__ctx')!));
    expect(order.indexOf(shells)).toBeGreaterThan(order.indexOf(agents));
    expect(q('.th-live__bg-compact')!.hidden).toBe(false);

    fx.next(live(IDLE));
    await run(1000);
    expect(agents.hidden).toBe(true);
    expect(shells.hidden).toBe(true);
    expect(q('.th-live__bg-compact')!.hidden).toBe(true);
  });

  it('по отдельности: только команды — метки агентов нет; только число агентов из подвала — без списка', async () => {
    const fx = fixture(live({ ...IDLE, shells: 3 }));
    await mount(fx);
    expect(q('.th-live__bg--agents')!.hidden).toBe(true);
    expect(q('.th-live__bg--shells')!.textContent).toBe(t('chat.live.bgShells', { n: 3 }));

    fx.next(live({ ...IDLE, agentCount: 2 }));
    await run(1000);
    expect(q('.th-live__bg--shells')!.hidden).toBe(true);
    expect(q('.th-live__bg--agents')!.textContent).toBe(t('chat.live.bgAgents', { n: 2 }));
    q('.th-live__bg--agents')!.click();
    expect(sheet().hidden).toBe(false);
    expect(rows()).toEqual([]);
    expect(sheet().textContent).toContain(t('chat.live.bgNoList'));
  });

  it('нажатие на «агенты» открывает список: тип, задача, время и токены — что есть', async () => {
    const fx = fixture(live(BG));
    await mount(fx);
    expect(sheet().hidden).toBe(true);
    q('.th-live__bg--agents')!.click();
    expect(sheet().hidden).toBe(false);
    expect(q('.th-live__bg--agents')!.getAttribute('aria-expanded')).toBe('true');
    const list = rows();
    expect(list).toHaveLength(2);
    expect(list[0]).toContain('general-purpose');
    expect(list[0]).toContain('Run the tests');
    expect(list[0]).toContain('2m 2s');
    expect(list[0]).toContain(t('chat.live.tokens', { n: '94.3k' }));
    expect(list[1]).toContain('Explore');
    expect(list[1]).toContain('Check the build');
    expect(qa('.th-live__sheet-row')[1]!.querySelector('.th-live__sheet-meta')).toBeNull();
    expect(sheet().textContent).toContain(t('chat.live.bgShells', { n: 1 }));
  });

  it('список обновляется с опросом экрана и закрывается, когда агентов не осталось', async () => {
    const fx = fixture(live(BG));
    await mount(fx);
    q('.th-live__bg--agents')!.click();
    fx.next(live({ ...IDLE, shells: 1, agents: [{ type: 'Explore', task: 'Check the build', elapsed: 61 }] }));
    await run(1000);
    expect(sheet().hidden).toBe(false);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('1m 1s');
    expect(q('.th-live__bg--agents')!.textContent).toBe(t('chat.live.bgAgents', { n: 1 }));

    fx.next(live({ ...IDLE, shells: 1 }));
    await run(1000);
    expect(sheet().hidden).toBe(true);
  });

  it('компактная метка несёт оба числа и открывает тот же лист; закрытие кнопкой и Esc', async () => {
    const fx = fixture(live(BG));
    await mount(fx);
    const compact = q<HTMLButtonElement>('.th-live__bg-compact')!;
    expect(compact.textContent).toContain('2');
    expect(compact.textContent).toContain('1');
    expect(compact.getAttribute('aria-label')).toBe(
      `${t('chat.live.bgAgents', { n: 2 })}, ${t('chat.live.bgShells', { n: 1 })}`,
    );
    compact.click();
    expect(sheet().hidden).toBe(false);
    q('.th-live__sheet-close')!.click();
    expect(sheet().hidden).toBe(true);

    compact.click();
    expect(sheet().hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(sheet().hidden).toBe(true);
    // Лист закрыт — Esc больше не слушается и опрос его сам не открывает.
    await run(1000);
    expect(sheet().hidden).toBe(true);
  });

  it('компактная метка при одних командах открывает лист с их числом, и он не закрывается сам', async () => {
    const fx = fixture(live({ ...IDLE, shells: 2 }));
    await mount(fx);
    q('.th-live__bg-compact')!.click();
    expect(sheet().hidden).toBe(false);
    expect(sheet().textContent).toContain(t('chat.live.bgShells', { n: 2 }));
    await run(1000);
    expect(sheet().hidden).toBe(false);
    fx.next(live(IDLE));
    await run(1000);
    expect(sheet().hidden).toBe(true);
  });

  it('лист живёт в области чата, а не на странице; гость видит числа и список наравне с владельцем', async () => {
    const chat = document.createElement('div');
    chat.className = 'th-chat';
    document.body.append(chat);
    chat.append(host.status, host.question, host.terminal, host.composer);
    const fx = fixture(live(BG), { write: false, files: false });
    await mount(fx);
    expect(sheet().parentElement).toBe(chat);
    // Слот поля ввода остаётся последним в оболочке.
    expect(chat.lastElementChild).toBe(host.composer);
    expect(q('.th-live__bg--agents')!.hidden).toBe(false);
    expect(q('.th-live__bg--shells')!.hidden).toBe(false);
    q('.th-live__bg--agents')!.click();
    expect(rows()).toHaveLength(2);
  });

  it('teardown убирает лист и перестаёт слушать Esc', async () => {
    const fx = fixture(live(BG));
    const h = await mount(fx);
    q('.th-live__bg--agents')!.click();
    h.teardown();
    handle = undefined;
    expect(q('.th-live__sheet')).toBeNull();
    expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
  });
});
