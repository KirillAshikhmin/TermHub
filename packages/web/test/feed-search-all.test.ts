// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import { searchSession, setFeedJump, takeFeedJump } from '../src/feed-search-all';
import type { Transport } from '../src/transport';

const entry = (id: string, text: string, cursor?: string): unknown => ({ id, at: 1, kind: 'agent', text, cursor });

describe('поиск по всем лентам', () => {
  it('идёт с хвоста назад до начала беседы, свежие находки первыми, без курсора — не находка', async () => {
    const pages: Record<string, unknown> = {
      tail: { ok: true, entries: [entry('3', 'про relay'), entry('4', 'снова Relay', '1:40')], head: '1:30', bof: false },
      '1:30': { ok: true, entries: [], head: '1:20', bof: false }, // шаг через большую строку — не край
      '1:20': { ok: true, entries: [entry('1', 'relay в начале', '1:10'), entry('2', 'мимо', '1:15')], head: '1:10', bof: true },
    };
    const feed = vi.fn(async (_s: string, opts: { before?: string } = {}) => pages[opts.before ?? 'tail']);
    const res = await searchSession({ feed } as unknown as Transport, 'a', 'relay');
    expect(res.hits.map((h) => h.cursor)).toEqual(['1:40', '1:10']);
    expect(res.complete).toBe(true);
    expect(res.scanned).toBe(4);
    expect(feed).toHaveBeenCalledTimes(3);
  });

  it('останавливается на отказе ленты и на курсоре, который перестал двигаться', async () => {
    const fail = vi.fn(async () => ({ ok: false, reason: 'no-agent', detail: '' }));
    expect((await searchSession({ feed: fail } as unknown as Transport, 'a', 'x')).hits).toEqual([]);
    const stuck = vi.fn(async () => ({ ok: true, entries: [], head: '1:5', bof: false }));
    const res = await searchSession({ feed: stuck } as unknown as Transport, 'a', 'x');
    expect(res.complete).toBe(false);
    expect(stuck).toHaveBeenCalledTimes(2);
  });

  it('просьба о прыжке достаётся только своей сессии и ровно один раз', () => {
    setFeedJump('a', '1:40');
    expect(takeFeedJump('b')).toBeNull();
    expect(takeFeedJump('a')).toBe('1:40');
    expect(takeFeedJump('a')).toBeNull();
  });
});
