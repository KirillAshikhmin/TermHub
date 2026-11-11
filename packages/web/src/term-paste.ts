// Вставка из буфера обмена в терминал: текст — как обычная вставка, картинка — файлом на
// хост. Агент в панели читает буфер хоста, а картинка лежит в буфере этого устройства,
// поэтому она загружается на хост (`Transport.pasteImage`), и в терминал вставляется путь
// файла: Claude Code и Codex превращают вставленный путь картинки во вложение.

/** Типы картинок, которые принимает агент (paste-image.ts на его стороне). */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type ClipboardContent =
  | { kind: 'image'; blob: Blob }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  /** Буфер недоступен: страница не в защищённом контексте или браузер не умеет. */
  | { kind: 'unavailable' }
  /** Человек или браузер не разрешил чтение. */
  | { kind: 'denied' };

/** Что лежит в буфере. Картинка старше текста: скопированная из браузера картинка несёт
 *  ещё и текст (адрес или разметку), а вставить хотят её. */
export async function readClipboard(): Promise<ClipboardContent> {
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (!clipboard) return { kind: 'unavailable' };
  try {
    if (typeof clipboard.read === 'function') {
      const items = await clipboard.read();
      for (const item of items) {
        const type = IMAGE_TYPES.find((t) => item.types.includes(t));
        if (type) return { kind: 'image', blob: await item.getType(type) };
      }
      for (const item of items) {
        if (!item.types.includes('text/plain')) continue;
        const text = await (await item.getType('text/plain')).text();
        if (text) return { kind: 'text', text };
      }
      return { kind: 'empty' };
    }
    if (typeof clipboard.readText !== 'function') return { kind: 'unavailable' };
    const text = await clipboard.readText();
    return text ? { kind: 'text', text } : { kind: 'empty' };
  } catch {
    return { kind: 'denied' };
  }
}

/** Картинка из события вставки (Cmd+V, меню браузера). Есть в событии текст — вставка
 *  обычная, и картинку не трогаем. */
export function imageFromPaste(data: DataTransfer | null): File | null {
  if (!data || data.getData('text/plain')) return null;
  for (const file of Array.from(data.files)) {
    if (IMAGE_TYPES.includes(file.type)) return file;
  }
  return null;
}

/** Путь в том виде, в каком его вставил бы терминал при перетаскивании файла: пробелы и
 *  прочие знаки оболочки закрыты обратной чертой. */
export function pathForPaste(file: string): string {
  return file.replace(/[^A-Za-z0-9_\-./:@%+,=~]/g, (ch) => `\\${ch}`);
}
