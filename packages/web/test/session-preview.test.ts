// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { previewOf, previewText, refreshPreviews } from '../src/session-preview';
import type { Transport } from '../src/transport';

function transportWith(feed: (session: string) => unknown, caps = ['feed']): Transport {
  return {
    mode: 'lan',
    capabilities: async () => caps,
    feed: vi.fn(async (session: string) => feed(session)),
  } as unknown as Transport;
}

const page = (text: string, kind = 'agent'): unknown => ({
  ok: true,
  entries: [
    { id: '1', at: 1, kind: 'human', text: 'вопрос' },
    { id: '2', at: 2, kind, text },
    { id: '3', at: 3, kind: 'tool', text: 'Ran 1 shell command' },
  ],
});

describe('session preview', () => {
  beforeEach(() => forgetCaps());

  it('сжимает реплику в одну строку и обрезает', () => {
    expect(previewText('  a\n\n b  ')).toBe('a b');
    expect(previewText('x'.repeat(400)).length).toBe(241);
  });

  it('берёт последнюю реплику человека или агента, а не инструмент', async () => {
    const t = transportWith(() => page('Готово:\nвсё зелёное'));
    const onUpdate = vi.fn();
    await refreshPreviews(t, [{ name: 'a', activityTs: 1 }], onUpdate);
    expect(previewOf(t, 'a')).toBe('Готово: всё зелёное');
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('не перечитывает сессию, которая не шевелилась, и не частит на работающей', async () => {
    const t = transportWith(() => page('раз'));
    let clock = 0;
    const now = (): number => clock;
    await refreshPreviews(t, [{ name: 'a', activityTs: 1 }], () => {}, now);
    await refreshPreviews(t, [{ name: 'a', activityTs: 1 }], () => {}, now);
    clock = 5_000;
    await refreshPreviews(t, [{ name: 'a', activityTs: 2 }], () => {}, now);
    expect(t.feed).toHaveBeenCalledTimes(1);
    clock = 11_000;
    await refreshPreviews(t, [{ name: 'a', activityTs: 2 }], () => {}, now);
    expect(t.feed).toHaveBeenCalledTimes(2);
  });

  it('отказ ленты не стирает прежнее превью и не спрашивается на каждом опросе', async () => {
    let fail = false;
    const t = transportWith(() => (fail ? { ok: false, reason: 'no-agent', detail: '' } : page('было')));
    await refreshPreviews(t, [{ name: 'a', activityTs: 1 }], () => {}, () => 0);
    fail = true;
    await refreshPreviews(t, [{ name: 'a', activityTs: 2 }], () => {}, () => 20_000);
    await refreshPreviews(t, [{ name: 'a', activityTs: 2 }], () => {}, () => 40_000);
    expect(previewOf(t, 'a')).toBe('было');
    expect(t.feed).toHaveBeenCalledTimes(2);
  });

  it('у агента без ленты превью не запрашивается вовсе', async () => {
    forgetCaps(); // пересечение помнится по последнему обмену — начинаем с чистого
    const t = transportWith(() => page('x'), []);
    await refreshPreviews(t, [{ name: 'a', activityTs: 1 }], () => {});
    expect(t.feed).not.toHaveBeenCalled();
  });
});
