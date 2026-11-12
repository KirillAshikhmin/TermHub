// @vitest-environment happy-dom
// Строка «в терминале набрано»: текст из строки агента виден над полем чата, пока поле
// пусто; «Забрать в поле» шлёт take-input и кладёт текст в поле. Шов — подделанные живое
// состояние и поле.
import type { ActResult, ChatAction, LiveState, ScreenState } from '@termhub/protocol/chat';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LiveHandle } from '../src/chat-live';
import { mountTyped, type TypedField } from '../src/chat-typed';
import { setLang, t } from '../src/i18n';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Fx {
  anchor: HTMLElement;
  screen(next: ScreenState | null): void;
  acts: ChatAction[];
  answer: { value: ActResult | Error };
  field: TypedField & { value: string; focused: number; type(text: string): void };
  live: LiveHandle;
}
function fixture(first: ScreenState | null): Fx {
  let state: LiveState | null = null;
  const of = (s: ScreenState | null): LiveState | null =>
    s ? ({ ok: true, agent: 'claude', tested: true, screen: s, modes: [], models: [] } as LiveState) : null;
  state = of(first);
  const subs = new Set<(s: LiveState | null, changed: boolean) => void>();
  const acts: ChatAction[] = [];
  const answer: Fx['answer'] = { value: { ok: true, screen: { kind: 'idle' }, taken: 'из терминала' } };
  const live = {
    state: () => state,
    act: async (a: ChatAction) => {
      acts.push(a);
      if (answer.value instanceof Error) throw answer.value;
      if (answer.value.ok) {
        state = of(answer.value.screen);
        for (const fn of subs) fn(state, true);
      }
      return answer.value;
    },
    subscribe: (fn: (s: LiveState | null, changed: boolean) => void) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  } as unknown as LiveHandle;
  const textSubs = new Set<() => void>();
  const field: Fx['field'] = {
    value: '',
    focused: 0,
    text: () => field.value,
    setText: (text) => {
      field.value = text;
      for (const fn of textSubs) fn();
    },
    focus: () => {
      field.focused += 1;
    },
    onText: (fn) => {
      textSubs.add(fn);
      return () => textSubs.delete(fn);
    },
    type: (text) => field.setText(text),
  };
  const anchor = document.createElement('div');
  document.body.append(anchor);
  return {
    anchor,
    acts,
    answer,
    field,
    live,
    screen: (next) => {
      state = of(next);
      for (const fn of subs) fn(state, true);
    },
  };
}
const line = (): HTMLElement | null => document.body.querySelector<HTMLElement>('.th-typed');
const shown = (): boolean => !!line() && !line()!.hidden;

beforeEach(() => {
  setLang('ru');
  document.body.replaceChildren();
});

describe('в терминале набрано', () => {
  it('текст в строке агента при пустом поле — строка над полем с текстом и кнопкой', () => {
    const fx = fixture({ kind: 'idle', input: 'почини тесты' });
    mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    expect(shown()).toBe(true);
    expect(line()!.nextElementSibling).toBe(fx.anchor);
    expect(line()!.querySelector('.th-typed__label')!.textContent).toBe(t('chat.typed.label'));
    expect(line()!.querySelector('.th-typed__text')!.textContent).toBe('почини тесты');
    expect(line()!.querySelector('button.th-typed__take')!.textContent).toBe(t('chat.composer.take'));
  });

  it('текст изменился — строка обновилась; исчез или состояния нет — пропала', () => {
    const fx = fixture({ kind: 'idle' });
    mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    expect(shown()).toBe(false);
    fx.screen({ kind: 'idle', input: 'раз' });
    expect(line()!.querySelector('.th-typed__text')!.textContent).toBe('раз');
    fx.screen({ kind: 'idle', input: 'раз два' });
    expect(line()!.querySelector('.th-typed__text')!.textContent).toBe('раз два');
    fx.screen({ kind: 'idle', input: '' });
    expect(shown()).toBe(false);
    fx.screen({ kind: 'idle', input: 'три' });
    expect(shown()).toBe(true);
    fx.screen(null);
    expect(shown()).toBe(false);
  });

  it('в поле чата что-то набрано — строки нет; поле опустело — вернулась', () => {
    const fx = fixture({ kind: 'idle', input: 'черновик агента' });
    mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    fx.field.type('моё');
    expect(shown()).toBe(false);
    fx.field.type('');
    expect(shown()).toBe(true);
  });

  it('«Забрать в поле» шлёт take-input, кладёт текст в поле и ставит фокус; строка пропадает', async () => {
    const fx = fixture({ kind: 'idle', input: 'из терминала' });
    mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    line()!.querySelector<HTMLButtonElement>('.th-typed__take')!.click();
    await flush();
    expect(fx.acts).toEqual([{ kind: 'take-input' }]);
    expect(fx.field.value).toBe('из терминала');
    expect(fx.field.focused).toBe(1);
    expect(shown()).toBe(false);
  });

  it('отказ и обрыв связи говорят тостом, поле не трогают, строка остаётся', async () => {
    const fx = fixture({ kind: 'working', input: 'текст' });
    mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    fx.answer.value = { ok: false, reason: 'busy', detail: 'agent is working' };
    line()!.querySelector<HTMLButtonElement>('.th-typed__take')!.click();
    await flush();
    fx.answer.value = new Error('offline');
    line()!.querySelector<HTMLButtonElement>('.th-typed__take')!.click();
    await flush();
    const toasts = [...document.body.querySelectorAll('.th-toast')].map((n) => n.textContent);
    expect(toasts).toEqual([t('chat.composer.busy'), t('chat.composer.noConnection')]);
    expect(fx.field.value).toBe('');
    expect(shown()).toBe(true);
    expect(line()!.querySelector<HTMLButtonElement>('.th-typed__take')!.disabled).toBe(false);
  });

  it('гость без права ввода: строка видна, кнопки нет', () => {
    const fx = fixture({ kind: 'idle', input: 'чужой текст' });
    mountTyped(fx.anchor, { live: fx.live, field: null });
    expect(shown()).toBe(true);
    expect(line()!.querySelector('.th-typed__text')!.textContent).toBe('чужой текст');
    expect(line()!.querySelector('button')).toBeNull();
  });

  it('teardown убирает строку и отписывается', () => {
    const fx = fixture({ kind: 'idle', input: 'x' });
    const h = mountTyped(fx.anchor, { live: fx.live, field: fx.field });
    h.teardown();
    expect(line()).toBeNull();
    fx.screen({ kind: 'idle', input: 'y' });
    expect(line()).toBeNull();
  });
});
