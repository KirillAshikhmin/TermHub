// @vitest-environment happy-dom
// Экран терминала: что видно про способ подключения и про приложение, ушедшее в
// альтернативный экран. Транспорт подделан (term-harness) — проверяется экран, а
// не доставка кадров.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLang, t } from '../src/i18n';
import { mountTerminal } from '../src/term';
import { lastTerminalMode } from '../src/term-mode';
import { openTermSettings } from '../src/term-settings';
import { FakeTerminal, stubResizeObserver, termTransport } from './term-harness';

vi.mock('@xterm/xterm', async () => ({ Terminal: (await import('./term-harness')).FakeTerminal }));

/** Хост терминала: на нём висит признак «экран занят полноэкранным приложением». */
const termHost = (root: HTMLElement): HTMLElement => root.querySelector('.th-term__host') as HTMLElement;
/** Сегмент способа подключения в окне настроек — тот, где есть вариант attach. */
const modeSegment = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('.th-termview .th-segment')].find((seg) =>
    [...seg.querySelectorAll('.th-segment__btn')].some((b) => b.textContent === t('term.modeAttach')),
  )!;

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
    expect(lastTerminalMode()).toBe('control'); // кадр без режима его не стёр
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

  it('чипа режима в шапке больше нет: выбор живёт в настройках', () => {
    const { transport } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(root.querySelector('.th-termbar__mode')).toBeNull();
    handle.teardown();
  });

  it('настройки: выбор не трогает живой терминал и применяется к следующему открытию', () => {
    const { transport, frames, opened } = termTransport();
    const first = mountTerminal(root, 'work', transport);
    opened[0]!.opts.onStatus('connected');
    opened[0]!.opts.onTerminalState!({ mode: 'control' });
    frames.length = 0;

    openTermSettings();
    const mode = modeSegment();
    expect(mode.querySelector('.is-active')!.textContent).toBe(t('term.modeControl'));
    // Рядом названо, чем агент подключил на самом деле.
    expect(document.querySelector('.th-termview')!.textContent).toContain(
      t('termview.modeNow', { mode: t('term.modeControl') }),
    );
    mode.querySelectorAll<HTMLButtonElement>('.th-segment__btn')[1]!.click();

    expect(frames).toEqual([]); // текущему каналу ничего не отправлено
    expect(opened[0]!.closed).toBe(false); // и он не закрыт
    expect(localStorage.getItem('termhub.terminalMode')).toBe('attach'); // переживает перезагрузку
    first.teardown();

    const second = mountTerminal(root, 'work', transport);
    expect(opened[1]!.opts.mode).toBe('attach');
    second.teardown();
  });

  it('настройки называют режим, который вернул агент, а не тот, который попросили', () => {
    const { transport, opened } = termTransport();
    const handle = mountTerminal(root, 'work', transport);
    expect(opened[0]!.opts.mode).toBe('control'); // попросили control — значение по умолчанию
    // Агент вернул attach: control запрещён его настройкой либо не поднялся.
    opened[0]!.opts.onTerminalState!({ mode: 'attach' });

    openTermSettings();
    expect(modeSegment().querySelector('.is-active')!.textContent).toBe(t('term.modeControl')); // просьба прежняя
    expect(document.querySelector('.th-termview')!.textContent).toContain(
      t('termview.modeNow', { mode: t('term.modeAttach') }),
    );
    handle.teardown();
  });
});
