// @vitest-environment happy-dom
// Параметры вида TermHub на чате: переменные области чата считаются из настроек терминала
// и меняются на месте при смене настройки.
import { beforeEach, describe, expect, it } from 'vitest';

import { bindChatView, chatViewVars } from '../src/chat-view';
import { setTermPrefs } from '../src/term-prefs';

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
});

describe('chatViewVars', () => {
  it('размер, интервал и выбранное семейство — на текст и код', () => {
    expect(chatViewVars({ fontSize: 18, lineHeight: 1.3, font: 'menlo' }, false)).toEqual({
      '--chat-fs': '18px',
      '--chat-input-fs': '18px',
      '--chat-lh': '1.3',
      '--chat-font': 'Menlo, var(--font-ui)',
      '--chat-mono': 'Menlo, var(--font-mono)',
    });
  });

  it('системный шрифт: текст — шрифтом приложения, код — моноширинным стеком темы', () => {
    const vars = chatViewVars({ fontSize: 12, lineHeight: 1, font: 'system' }, false);
    expect(vars['--chat-font']).toBe('var(--font-ui)');
    expect(vars['--chat-mono']).toBe('var(--font-mono)');
  });

  it('на тач-экране поле ввода не мельче 16 px, остальное — по настройке', () => {
    const small = chatViewVars({ fontSize: 12, lineHeight: 1, font: 'system' }, true);
    expect(small['--chat-fs']).toBe('12px');
    expect(small['--chat-input-fs']).toBe('16px');
    expect(chatViewVars({ fontSize: 20, lineHeight: 1, font: 'system' }, true)['--chat-input-fs']).toBe('20px');
  });
});

describe('bindChatView', () => {
  it('ставит переменные сразу и меняет их при смене настройки; после отписки — нет', () => {
    setTermPrefs({ fontSize: 13, lineHeight: 1.15, font: 'fira' });
    const area = document.createElement('main');
    document.body.append(area);
    const off = bindChatView(area);
    expect(area.style.getPropertyValue('--chat-fs')).toBe('13px');
    expect(area.style.getPropertyValue('--chat-lh')).toBe('1.15');
    expect(area.style.getPropertyValue('--chat-mono')).toBe("'Fira Code', var(--font-mono)");
    setTermPrefs({ fontSize: 20 });
    expect(area.style.getPropertyValue('--chat-fs')).toBe('20px');
    off();
    setTermPrefs({ fontSize: 11 });
    expect(area.style.getPropertyValue('--chat-fs')).toBe('20px');
  });
});
