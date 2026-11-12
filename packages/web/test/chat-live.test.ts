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
    const text = q('.th-live__state')!.textContent!;
    expect(text).toContain(t('chat.live.working'));
    expect(text).toContain('1:05');
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
    await run(1000);
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
    expect(mountedTerms).toHaveLength(1);
    expect(healthRows()).toEqual([]);
    fx.next(live(IDLE));
    await run(1000);
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
