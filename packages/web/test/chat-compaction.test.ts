// @vitest-environment happy-dom
// Веха сжатия Codex: строка с числами сохранённого без сжатия и раскрытие по тапу в список
// сообщений. Транспорт подделан (единственный шов), тексты нейтральные.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import type { DetailResult, FeedEntry, FeedPage, Transport } from '../src/transport';

const KEPT: FeedEntry = {
  id: 'c1',
  at: 1,
  kind: 'note',
  note: 'compacted',
  text: '',
  cursor: '9:100',
  retained: { human: 2, agent: 3 },
};
const PLAIN: FeedEntry = { id: 'c2', at: 2, kind: 'note', note: 'compacted', text: '', cursor: '9:200' };

const page = (entries: FeedEntry[]): FeedPage => ({
  ok: true, agent: 'codex', entries, head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0,
});

let host: HTMLElement;
let detail: ReturnType<typeof vi.fn<(s: string, c: string) => Promise<DetailResult>>>;
const transport = (): Transport =>
  ({
    mode: 'lan',
    clientScope: null,
    capabilities: async () => ['feed'],
    gradle: async () => null,
    list: async () => [],
    feed: async () => page([KEPT, PLAIN]),
    feedDetail: detail,
  }) as unknown as Transport;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const chatOpts = { linker: { ready: Promise.resolve(), link: () => null } as never };

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
  detail = vi.fn(async () => ({
    ok: true as const,
    messages: [
      { role: 'human' as const, text: 'первая просьба' },
      { role: 'agent' as const, text: 'ответ агента' },
    ],
  }));
});

const notes = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.th-feed__entry--note')];

describe('веха сжатия Codex в чате', () => {
  it('строка называет числа; нет сохранённого — прежняя «Беседа сжата»', async () => {
    const feed = mountFeed(host, 'work', transport(), chatOpts);
    await flush();
    const [kept, plain] = notes();
    expect(kept.querySelector('.th-feed__notelabel')!.textContent).toBe(t('feed.note.compactedKept', { human: 2, agent: 3 }));
    expect(kept.textContent).toContain('2');
    expect(plain.querySelector('.th-feed__notelabel')!.textContent).toBe(t('feed.note.compacted'));
    expect(plain.querySelector('.th-tool__head')).toBeNull();
    feed.teardown();
  });

  it('тап раскрывает сообщения: свои и агента различимы, запрос по курсору вехи — один', async () => {
    const feed = mountFeed(host, 'work', transport(), chatOpts);
    await flush();
    const kept = notes()[0]!;
    expect(detail).not.toHaveBeenCalled();
    kept.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(detail).toHaveBeenCalledWith('work', '9:100');
    const items = [...kept.querySelectorAll<HTMLElement>('.th-kept')];
    expect(items.map((i) => [i.classList.contains('th-kept--human'), i.querySelector('.th-kept__text')!.textContent])).toEqual([
      [true, 'первая просьба'],
      [false, 'ответ агента'],
    ]);
    expect(items[0]!.querySelector('.th-kept__who')!.textContent).toBe(t('feed.you'));
    expect(items[1]!.querySelector('.th-kept__who')!.textContent).toBe(t('feed.kind.agent'));
    feed.teardown();
  });
});

describe('веха сжатия Codex в ленте без чата', () => {
  it('числа текстом, раскрытия нет', async () => {
    const feed = mountFeed(host, 'work', transport());
    await flush();
    const kept = notes()[0]!;
    expect(kept.querySelector('.th-feed__notelabel')!.textContent).toBe(t('feed.note.compactedKept', { human: 2, agent: 3 }));
    expect(kept.querySelector('.th-tool__head')).toBeNull();
    feed.teardown();
  });
});
