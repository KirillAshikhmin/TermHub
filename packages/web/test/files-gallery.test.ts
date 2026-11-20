// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { galleryOf, mountFiles } from '../src/files';
import { setLang } from '../src/i18n';
import type { FileEntry, Transport } from '../src/transport';

vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return {
    ...actual,
    renderHeader: () => ({ el: document.createElement('header'), teardown: () => {} }),
    renderTabs: () => document.createElement('nav'),
    openModal: (builder: (close: () => void) => HTMLElement) => {
      const el = builder(() => {});
      document.body.append(el);
      return () => el.remove();
    },
    toast: vi.fn(),
  };
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const file = (name: string): FileEntry => ({ name, kind: 'file', size: 5, mtime: 1, hidden: false }) as FileEntry;
const ENTRIES: FileEntry[] = [
  { name: 'pics', kind: 'dir', size: 0, mtime: 1, hidden: false } as FileEntry,
  file('a.png'),
  file('notes.txt'),
  file('b.JPG'),
  file('c.webp'),
];

function fakeTransport(): { transport: Transport; reads: string[] } {
  const reads: string[] = [];
  const transport = {
    mode: 'lan',
    clientScope: null,
    caffeinate: () => Promise.resolve({ active: false, supported: false }),
    dirs: () => Promise.resolve([{ root: '/projects', dirs: [] }]),
    filesList: () => Promise.resolve(ENTRIES),
    fileStat: (_root: string, path: string) =>
      Promise.resolve(path.endsWith('.txt') ? { size: 5, mime: 'text/plain', kind: 'text' } : { size: 5, mime: 'image/png', kind: 'image' }),
    fileRead: (_root: string, path: string) => {
      reads.push(path);
      return Promise.resolve(
        path.endsWith('.txt')
          ? { kind: 'text', mime: 'text/plain', data: 'hello', size: 5, truncated: false }
          : { kind: 'image', mime: 'image/png', data: btoa(path), size: 5, truncated: false },
      );
    },
    downloadUrl: () => '/download',
    fileOp: () => Promise.resolve(),
  } as unknown as Transport;
  return { transport, reads };
}

async function open(transport: Transport, name: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  document.body.append(root);
  location.hash = '#/files/%2Fprojects';
  mountFiles(root, transport);
  await flush();
  const row = [...root.querySelectorAll<HTMLElement>('.th-files__row')].find((r) => r.textContent?.includes(name))!;
  row.click();
  await flush();
  await flush();
  return document.querySelector<HTMLElement>('.th-fileview')!;
}

const state = (view: HTMLElement): { title: string; count: string; src: string } => ({
  title: view.querySelector('h2')!.textContent ?? '',
  count: view.querySelector('.th-fileview__count')!.textContent ?? '',
  src: atob((view.querySelector<HTMLImageElement>('.th-fileview__img')?.src ?? '').split(',')[1] ?? ''),
});

describe('галерея в просмотре файлов', () => {
  beforeEach(() => setLang('ru'));
  afterEach(() => {
    document.body.replaceChildren();
    location.hash = '';
  });

  it('соседи — картинки папки в порядке списка; одна картинка или не картинка — листать нечего', () => {
    expect(galleryOf(ENTRIES, 'b.JPG')).toEqual(['a.png', 'b.JPG', 'c.webp']);
    expect(galleryOf(ENTRIES, 'notes.txt')).toEqual([]);
    expect(galleryOf([file('a.png'), file('x.txt')], 'a.png')).toEqual([]);
  });

  it('стрелки, клавиши и жест листают картинки по кругу в том же окне', async () => {
    const { transport, reads } = fakeTransport();
    const view = await open(transport, 'b.JPG');
    expect(state(view)).toEqual({ title: 'b.JPG', count: '2 / 3', src: 'b.JPG' });
    const [prev, next] = [...view.querySelectorAll<HTMLButtonElement>('.th-fileview__nav button')];
    next!.click();
    await flush();
    expect(state(view)).toEqual({ title: 'c.webp', count: '3 / 3', src: 'c.webp' });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flush();
    expect(state(view)).toEqual({ title: 'a.png', count: '1 / 3', src: 'a.png' });
    prev!.click();
    await flush();
    expect(state(view).title).toBe('c.webp');
    // Уже показанное в сеть второй раз не ходит.
    expect(reads).toEqual(['b.JPG', 'c.webp', 'a.png']);
    // Скачивание и прочие действия относятся к показанному файлу, окно одно.
    expect(document.querySelectorAll('.th-fileview')).toHaveLength(1);
    // Закрытое окно клавиши больше не слушает.
    view.remove();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    await flush();
    expect(reads).toHaveLength(3);
  });

  it('у текстового файла стрелок галереи нет', async () => {
    const { transport } = fakeTransport();
    const view = await open(transport, 'notes.txt');
    expect(view.querySelector<HTMLElement>('.th-fileview__nav')!.hidden).toBe(true);
    expect(view.querySelector('.th-fileview__text')!.textContent).toBe('hello');
  });
});
