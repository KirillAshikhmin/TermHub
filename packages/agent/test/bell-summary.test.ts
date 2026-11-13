// Сводка для уведомления о звонке: экран и лента подменены, tmux и файлы не нужны.
import { describe, expect, it } from 'vitest';

import type { LiveResult } from '@termhub/protocol/chat';

import { bellSummary } from '../src/bell-summary.js';
import type { FeedResult } from '../src/session-feed.js';

const live = (screen: object): LiveResult =>
  ({ ok: true, agent: 'codex', tested: true, screen, modes: [], models: [] }) as unknown as LiveResult;
const feed = (entries: object[]): FeedResult =>
  ({ ok: true, agent: 'codex', entries, head: 'h', tail: 't', bof: true, eof: true, skipped: 0, complete: true, live: true }) as unknown as FeedResult;

describe('bellSummary', () => {
  it('вопрос на экране: текст и варианты без «своего ответа»', async () => {
    const got = await bellSummary('work', {
      live: async () =>
        live({
          kind: 'question',
          question: { stamp: 's', title: 'Довести **до слияния**?', options: [{ key: '1', label: 'Да' }, { key: '2', label: 'Other', free: true }] },
        }),
      feed: async () => feed([]),
    });
    expect(got).toEqual({ kind: 'question', agent: 'Codex', text: 'Довести до слияния?', options: ['Да'] });
  });

  it('вопрос ждёт в очереди: текст — из последней записи вопроса без ответа', async () => {
    const got = await bellSummary('work', {
      live: async () => live({ kind: 'working', input: '', pending: true }),
      feed: async () =>
        feed([
          { id: 'a', kind: 'tool', text: 'x', questions: [{ text: 'Старый?', answer: ['Да'] }] },
          { id: 'b', kind: 'tool', text: 'y', questions: [{ text: 'Назови город', options: [] }] },
        ]),
    });
    expect(got).toEqual({ kind: 'question', agent: 'Codex', text: 'Назови город' });
  });

  it('агент закончил: последний его ответ одной строкой, длинный обрезан', async () => {
    const long = `Готово.\n\n${'слово '.repeat(120)}`;
    const got = await bellSummary('work', {
      live: async () => live({ kind: 'idle', input: '' }),
      feed: async () => feed([{ id: 'a', kind: 'agent', text: 'раньше' }, { id: 'b', kind: 'agent', text: long }, { id: 'c', kind: 'tool', text: 'exec ls' }]),
    });
    expect(got?.kind).toBe('done');
    expect(got?.text?.startsWith('Готово. слово слово')).toBe(true);
    expect([...got!.text!].length).toBe(300);
    expect(got!.text!.endsWith('…')).toBe(true);
  });

  it('агента в панели нет или чтение сорвалось — сводки нет, исключения нет', async () => {
    expect(await bellSummary('work', { live: async () => ({ ok: false, reason: 'no-agent', detail: '' }), feed: async () => feed([]) })).toBeNull();
    expect(
      await bellSummary('work', {
        live: async () => {
          throw new Error('tmux is gone');
        },
        feed: async () => feed([]),
      }),
    ).toBeNull();
  });
});
