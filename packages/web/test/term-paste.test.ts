// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { imageFromPaste, pathForPaste, readClipboard } from '../src/term-paste';

const item = (parts: Record<string, string>): unknown => ({
  types: Object.keys(parts),
  getType: async (type: string) => new Blob([parts[type]!], { type }),
});

function stubClipboard(clipboard: unknown, secure = true): void {
  vi.stubGlobal('isSecureContext', secure);
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

afterEach(() => vi.unstubAllGlobals());

describe('чтение буфера обмена', () => {
  it('картинка старше текста: скопированная из браузера картинка несёт ещё и адрес', async () => {
    stubClipboard({ read: async () => [item({ 'text/plain': 'https://x/a.png', 'image/png': 'PNG' })] });
    const content = await readClipboard();
    expect(content.kind).toBe('image');
    expect(content.kind === 'image' && content.blob.type).toBe('image/png');
  });

  it('текст, пустой буфер, отказ в доступе и отсутствие буфера различаются', async () => {
    stubClipboard({ read: async () => [item({ 'text/html': '<b>x</b>', 'text/plain': 'привет' })] });
    expect(await readClipboard()).toEqual({ kind: 'text', text: 'привет' });
    stubClipboard({ read: async () => [] });
    expect(await readClipboard()).toEqual({ kind: 'empty' });
    stubClipboard({
      read: async () => {
        throw new DOMException('denied', 'NotAllowedError');
      },
    });
    expect(await readClipboard()).toEqual({ kind: 'denied' });
    // Браузер без read() — остаётся текст.
    stubClipboard({ readText: async () => 'abc' });
    expect(await readClipboard()).toEqual({ kind: 'text', text: 'abc' });
    stubClipboard(undefined);
    expect(await readClipboard()).toEqual({ kind: 'unavailable' });
    // Страница по HTTP с адреса в сети: буфера нет, даже если объект на месте.
    stubClipboard({ read: async () => [] }, false);
    expect(await readClipboard()).toEqual({ kind: 'unavailable' });
  });
});

describe('событие вставки и путь', () => {
  const transfer = (text: string, files: File[]): DataTransfer =>
    ({ getData: () => text, files }) as unknown as DataTransfer;

  it('картинка без текста — наша; с текстом вставка обычная', () => {
    const png = new File(['x'], 'shot.png', { type: 'image/png' });
    expect(imageFromPaste(transfer('', [png]))).toBe(png);
    expect(imageFromPaste(transfer('текст', [png]))).toBeNull();
    expect(imageFromPaste(transfer('', [new File(['x'], 'a.pdf', { type: 'application/pdf' })]))).toBeNull();
    expect(imageFromPaste(null)).toBeNull();
  });

  it('путь закрыт обратной чертой, как при перетаскивании файла в терминал', () => {
    expect(pathForPaste('/Users/me/.termhub/paste/paste-20261112T093005-ab12cd.png')).toBe(
      '/Users/me/.termhub/paste/paste-20261112T093005-ab12cd.png',
    );
    expect(pathForPaste("/Users/My Name/it's (1).png")).toBe("/Users/My\\ Name/it\\'s\\ \\(1\\).png");
  });
});
