// @vitest-environment happy-dom
// Экран терминала: что видно про способ подключения и про приложение, ушедшее в
// альтернативный экран. Транспорт подделан (term-harness) — проверяется экран, а
// не доставка кадров.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { mountTerminal } from '../src/term';
import { terminalModeLetter } from '../src/term-mode';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

/** Хост терминала: на нём висит признак «экран занят полноэкранным приложением». */
const termHost = (root: HTMLElement): HTMLElement => root.querySelector('.th-term__host') as HTMLElement;
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

describe('признак альтернативного экрана', () => {
  it('видимой пометки у него нет: историю беседы показывает лента, а не шапка', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);

    opened[0]!.opts.onTerminalState!({ altScreen: true });

    expect(root.querySelector('.th-termbar__alt')).toBeNull();
    handle.teardown();
  });

  it('прячет ползунок прокрутки, пока экран занят таким приложением', () => {
    // Листать в альтернативном экране нечего: истории у него нет. Ползунок библиотеки над
    // ним обещал бы прокрутку, которой не существует, — поэтому признак altScreen из кадра
    // состояния гасит его сам, ничего видимого в шапке для этого не требуя.
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(termHost(root).classList.contains('is-alt')).toBe(false);

    opened[0]!.opts.onTerminalState!({ altScreen: true });
    expect(termHost(root).classList.contains('is-alt')).toBe(true);

    opened[0]!.opts.onTerminalState!({ altScreen: false });
    expect(termHost(root).classList.contains('is-alt')).toBe(false);
    handle.teardown();
  });

  it('новое подключение начинает без признака: его знает только агент', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onTerminalState!({ altScreen: true });
    expect(termHost(root).classList.contains('is-alt')).toBe(true);

    opened[0]!.opts.onStatus!('connected');

    expect(termHost(root).classList.contains('is-alt')).toBe(false);
    expect(termHost(root).classList.contains('is-alt')).toBe(false);
    handle.teardown();
  });

  it('поля кадра независимы: пришедшее одно не стирает уже известное другое', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onTerminalState!({ mode: 'control' }); // режим агент назвал сразу, про экран ещё ничего
    expect(termHost(root).classList.contains('is-alt')).toBe(false);

    opened[0]!.opts.onTerminalState!({ altScreen: true }); // приложение ушло в альтернативный экран

    expect(termHost(root).classList.contains('is-alt')).toBe(true);
    expect(modeBtn(root).textContent).toBe(terminalModeLetter('control')); // кадр без режима его не стёр
    handle.teardown();
  });

  it('гаснет на каждом подключении канала: пережить его она не вправе', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus('connected');
    opened[0]!.opts.onTerminalState!({ altScreen: true });
    expect(termHost(root).classList.contains('is-alt')).toBe(true);

    // Связь оборвалась и поднялась заново — за ней у агента новый терминал, и что в нём
    // на экране, известно только из нового кадра.
    opened[0]!.opts.onStatus('reconnecting');
    opened[0]!.opts.onStatus('connected');

    expect(termHost(root).classList.contains('is-alt')).toBe(false); // прошлое «включён» с подключением не переехало
    opened[0]!.opts.onTerminalState!({ mode: 'control' }); // кадр без altScreen её не зажигает
    expect(termHost(root).classList.contains('is-alt')).toBe(false);

    opened[0]!.opts.onTerminalState!({ altScreen: true }); // зажечь вправе только новый кадр
    expect(termHost(root).classList.contains('is-alt')).toBe(true);
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

    expect(modeBtn(root).textContent).toBe(terminalModeLetter('attach'));
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
    expect(modeBtn(root).textContent).toBe(terminalModeLetter('control')); // работает по-прежнему control
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

  it('переподключение стирает показанный режим: он тоже приходит кадром', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus('connected');
    opened[0]!.opts.onTerminalState!({ mode: 'attach' });
    expect(modeBtn(root).textContent).toBe(terminalModeLetter('attach'));
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(true);

    opened[0]!.opts.onStatus('reconnecting');
    opened[0]!.opts.onStatus('connected'); // просьба уехала заново, ответа на неё ещё нет

    expect(modeBtn(root).textContent).toBe('—'); // для этого подключения агент режим не называл
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(false); // расхождение — из прошлого

    opened[0]!.opts.onTerminalState!({ mode: 'attach' }); // назвал — тогда и показываем
    expect(modeBtn(root).textContent).toBe(terminalModeLetter('attach'));
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(true);
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

describe('чип режима — одной буквой', () => {
  it('C для control mode, A для attach — а слово целиком остаётся в подсказке', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);

    opened[0]!.opts.onTerminalState!({ mode: 'control' });
    expect(modeBtn(root).textContent).toBe('C');
    expect(modeBtn(root).title).toContain(t('term.modeControl'));
    expect(modeBtn(root).getAttribute('aria-label')).toContain(t('term.modeSwitch'));

    opened[0]!.opts.onTerminalState!({ mode: 'attach' });
    expect(modeBtn(root).textContent).toBe('A');
    expect(modeBtn(root).title).toContain(t('term.modeAttach'));
    handle.teardown();
  });

  it('расхождение просьбы с действительностью видно и на одной букве — своим видом', () => {
    // Слова «просили другое» на чипе больше нет, поэтому признак обязан оставаться
    // видом кнопки: иначе на букве расхождение исчезло бы совсем.
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);

    opened[0]!.opts.onTerminalState!({ mode: 'attach' }); // просили control, агент дал attach

    expect(modeBtn(root).textContent).toBe('A');
    expect(modeBtn(root).classList.contains('is-overridden')).toBe(true);
    handle.teardown();
  });
});
