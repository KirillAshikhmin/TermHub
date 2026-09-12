// @vitest-environment happy-dom
// Экран терминала: что видно про способ подключения и про приложение, ушедшее в
// альтернативный экран. Транспорт подделан (term-harness) — проверяется экран, а
// не доставка кадров.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { mountTerminal } from '../src/term';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

/** Пометка приложения в альтернативном экране. */
const altBadge = (root: HTMLElement): HTMLElement => root.querySelector('.th-termbar__alt') as HTMLElement;
/** Переключатель способа подключения (он же показывает работающий режим). */
const modeBtn = (root: HTMLElement): HTMLButtonElement => root.querySelector('.th-termbar__mode') as HTMLButtonElement;

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  FakeTerminal.instances.length = 0;
  stubResizeObserver();
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('пометка альтернативного экрана', () => {
  it('появляется по кадру состояния и исчезает, когда приложение из него вышло', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(altBadge(root).hidden).toBe(true);

    opened[0]!.opts.onTerminalState!({ altScreen: true });
    expect(altBadge(root).hidden).toBe(false);

    opened[0]!.opts.onTerminalState!({ altScreen: false });
    expect(altBadge(root).hidden).toBe(true);
    handle.teardown();
  });

  it('объясняет причину человеку: по нажатию показывает, что истории у такого приложения нет', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onTerminalState!({ altScreen: true });

    altBadge(root).click();

    const toastText = document.querySelector('.th-toast')?.textContent;
    expect(toastText).toBe(t('term.altScreenHint'));
    expect(altBadge(root).title).toBe(t('term.altScreenHint'));
    handle.teardown();
  });

  it('поля кадра независимы: пришедшее одно не стирает уже известное другое', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onTerminalState!({ mode: 'control' }); // режим агент назвал сразу, про экран ещё ничего
    expect(altBadge(root).hidden).toBe(true);

    opened[0]!.opts.onTerminalState!({ altScreen: true }); // приложение ушло в альтернативный экран

    expect(altBadge(root).hidden).toBe(false);
    expect(modeBtn(root).textContent).toBe(t('term.modeControl')); // кадр без режима его не стёр
    handle.teardown();
  });
});

describe('переключатель способа подключения', () => {
  it('просьба клиента уходит в кадре открытия терминала; по умолчанию — control', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);

    expect(opened[0]!.opts.mode).toBe('control');
    handle.teardown();
  });

  it('показывает режим, который вернул агент, а не тот, который попросили', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(opened[0]!.opts.mode).toBe('control'); // попросили control — значение по умолчанию
    expect(modeBtn(root).textContent).toBe('—'); // агент ещё не ответил

    // Агент вернул attach: либо control запрещён его настройкой (`terminalMode: "attach"`),
    // либо control mode не поднялся и агент откатился на прежний способ. Обратного не бывает:
    // просьбу attach агент исполняет всегда, запретить он может только control.
    opened[0]!.opts.onTerminalState!({ mode: 'attach' });

    expect(modeBtn(root).textContent).toBe(t('term.modeAttach'));
    // Просьба уехала и закрыта — ждать нечего; расхождение с ответом видно отдельным признаком.
    expect(modeBtn(root).classList.contains('is-pending')).toBe(false);
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(true);
    handle.teardown();
  });

  it('переключение не трогает живой терминал и применяется к следующему открытию', () => {
    const { transport, frames, opened } = termTransport();
    const first = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus('connected');
    opened[0]!.opts.onTerminalState!({ mode: 'control' });
    frames.length = 0;

    expect(modeBtn(root).classList.contains('is-pending')).toBe(false); // ждать нечего

    modeBtn(root).click();

    expect(frames).toEqual([]); // текущему каналу ничего не отправлено
    expect(opened[0]!.closed).toBe(false); // и он не закрыт
    expect(modeBtn(root).textContent).toBe(t('term.modeControl')); // работает по-прежнему control
    expect(modeBtn(root).classList.contains('is-pending')).toBe(true); // просьба ждёт открытия
    first.teardown();

    const second = mountTerminal(root, 'work', transport);
    expect(opened[1]!.opts.mode).toBe('attach');
    // Просьба уехала в это открытие — признак ожидания снят.
    expect(modeBtn(root).classList.contains('is-pending')).toBe(false);
    second.teardown();
  });

  it('новая просьба совпала с работающим режимом — ожидания нет: обещать нечего', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    // Просили control (умолчание), агент подключил attach — просьба перебита.
    opened[0]!.opts.onTerminalState!({ mode: 'attach' });

    modeBtn(root).click(); // переключаем просьбу на attach, который и так работает

    expect(modeBtn(root).classList.contains('is-pending')).toBe(false);
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(true); // расхождение никуда не делось
    handle.teardown();
  });

  it('запомненная просьба переживает перезагрузку страницы', () => {
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    modeBtn(root).click();
    handle.teardown();

    expect(localStorage.getItem('termhub.terminalMode')).toBe('attach');
  });
});
