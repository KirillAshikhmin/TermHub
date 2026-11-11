// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { feedQuery } from '../src/api';
import { setLang } from '../src/i18n';
import type { Transport } from '../src/transport';
import { allTokens, formatDuration, formatMemory, formatTokens, openUsage, sessionUsage } from '../src/usage';

const totals = (output: number, activeMs = 0): Record<string, number> => ({
  input: 1,
  cached: 2,
  cacheWrite: 3,
  output,
  turns: 1,
  activeMs,
});

describe('расход по сессиям', () => {
  beforeEach(() => {
    setLang('ru');
    document.body.replaceChildren();
  });

  it('флаг usage едет общим перечнем параметров ленты — значит, обоими транспортами', () => {
    expect(feedQuery('work', { usage: true })).toEqual({ session: 'work', usage: 1 });
    expect(feedQuery('work', {})).toEqual({ session: 'work' });
  });

  it('запрос идёт через Transport.feed с флагом usage', async () => {
    const feed = vi.fn(async () => ({ ok: false, reason: 'no-agent', detail: '' }));
    await sessionUsage({ feed } as unknown as Transport, 'work');
    expect(feed).toHaveBeenCalledWith('work', { usage: true });
  });

  it('числа и время сжимаются до порядка', () => {
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(3_400_000)).toBe('3.4M');
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(20_000)).toBe('< 1 мин');
    expect(formatDuration(135 * 60_000)).toBe('2 ч 15 мин');
    expect(allTokens({ input: 1, cached: 2, cacheWrite: 3, output: 4, turns: 0, activeMs: 0 })).toBe(10);
  });

  it('окно: память у каждой сессии; сессия без агента — строкой с прочерками; внизу итог', async () => {
    const GB = 1024 * 1024 * 1024;
    const transport = {
      list: async () => [
        { name: 'a', title: '✳ Scenarios' },
        { name: 'shell', title: '' },
        { name: 'b', title: '' },
        { name: 'ghost', title: '' },
      ],
      feed: async (session: string) => {
        if (session === 'shell') return { ok: false, reason: 'no-agent', detail: '', memory: 100 * 1024 * 1024 };
        if (session === 'ghost') return { ok: false, reason: 'lookup-failed', detail: '' }; // ни токенов, ни памяти
        return { ok: true, agent: 'claude', total: totals(2000, 3_600_000), today: totals(500), started: 1, last: 2, memory: GB };
      },
    } as unknown as Transport;
    openUsage(transport);
    await vi.waitFor(() => expect(document.querySelector('.th-usage__sum')).not.toBeNull());
    const rows = [...document.querySelectorAll('.th-usage__table tbody tr')].map((tr) =>
      [...tr.children].map((c) => c.textContent),
    );
    expect(rows.map((r) => r[0])).toEqual(['Scenarios · a', 'shell', 'b', 'Итого']);
    expect(rows[0]![1]).toBe('1.0 ГБ');
    expect(rows[1]).toEqual(['shell', '100 МБ', '—', '—', '—', '—', '—', '—']);
    expect(rows[3]).toEqual(['Итого', '2.1 ГБ', '—', '1.0k', '1.0k', '2 ч 0 мин', '4.0k', '4.0k']);
  });

  it('старый агент память не называет — в колонке прочерк, расход на месте', async () => {
    const transport = {
      list: async () => [{ name: 'a', title: '' }],
      feed: async () => ({ ok: true, agent: 'claude', total: totals(10), today: totals(1), started: 1, last: 2 }),
    } as unknown as Transport;
    openUsage(transport);
    await vi.waitFor(() => expect(document.querySelector('.th-usage__sum')).not.toBeNull());
    const cellsOf = (i: number): Array<string | null> =>
      [...document.querySelectorAll('.th-usage__table tbody tr')[i]!.children].map((c) => c.textContent);
    expect(cellsOf(0)[1]).toBe('—');
    expect(cellsOf(1)[1]).toBe('—');
    expect(formatMemory(undefined)).toBe('—');
  });
});
