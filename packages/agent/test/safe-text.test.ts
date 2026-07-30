// Обеззараживание строк от недоверенной стороны. Имя устройства выбирает пир при
// пейринге, а печатается оно в `termhub devices` — списке, по которому оператор
// решает, кого отозвать. Управляющие последовательности позволяли стереть или
// подделать строку в этом списке, то есть спрятать чужое устройство от отзыва.

import { describe, it, expect } from 'vitest';
import { stripUnsafe, sanitizeDeviceName, MAX_DEVICE_NAME } from '../src/safe-text.js';

const ESC = String.fromCharCode(0x1b);
const RTL_OVERRIDE = String.fromCharCode(0x202e);

describe('stripUnsafe', () => {
  it('вырезает ESC/CSI, перевод строки и возврат каретки', () => {
    expect(stripUnsafe(`laptop${ESC}[2K${ESC}[1A`)).toBe('laptop[2K[1A');
    expect(stripUnsafe('a\nb\rc\td')).toBe('abcd');
  });

  it('вырезает OSC 52 (запись в буфер обмена оператора)', () => {
    expect(stripUnsafe(`${ESC}]52;c;cm0gLXJmIC8=ok`)).toBe(']52;c;cm0gLXJmIC8=ok');
  });

  it('вырезает bidi-override (переставляет символы при отрисовке, подделывая колонку)', () => {
    expect(stripUnsafe(`gu${RTL_OVERRIDE}tsli`)).toBe('gutsli');
  });

  it('обычный текст не трогает', () => {
    expect(stripUnsafe('Кирилл — iPhone 15')).toBe('Кирилл — iPhone 15');
  });
});

describe('sanitizeDeviceName', () => {
  it('чистит управляющие символы и обрезает по длине', () => {
    const name = sanitizeDeviceName(`${ESC}[1A` + 'x'.repeat(200));
    expect(name.length).toBe(MAX_DEVICE_NAME);
    expect(name.includes(ESC)).toBe(false);
  });

  it('имя из одних управляющих символов не даёт пустой строки', () => {
    expect(sanitizeDeviceName(`${ESC}\n\r `)).toBe('device');
  });

  it('строка с переводом строки не может подделать вторую строку списка', () => {
    const forged = sanitizeDeviceName('laptop\n  evil\tFAKEFINGERPRINT');
    expect(forged.includes('\n')).toBe(false);
    expect(forged.includes('\t')).toBe(false);
  });
});
