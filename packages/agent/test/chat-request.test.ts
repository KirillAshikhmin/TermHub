// Шов: разбор действия чата из чужого JSON — один на LAN и relay.

import { describe, expect, it } from 'vitest';

import { actPage, parseAction } from '../src/chat-request.js';

describe('parseAction — «показать вопрос»', () => {
  it('действие без полей разбирается, лишние поля отброшены', () => {
    expect(parseAction({ kind: 'show-question' })).toEqual({ kind: 'show-question' });
    expect(parseAction({ kind: 'show-question', key: '\x1f', stamp: 'x' })).toEqual({ kind: 'show-question' });
  });

  it('доходит до исполнителя тем же путём, что прочие действия', async () => {
    const seen: unknown[] = [];
    const result = await actPage(
      async (session, action) => {
        seen.push([session, action]);
        return { ok: true, screen: { kind: 'question' } };
      },
      { session: 'work', action: { kind: 'show-question' } },
    );
    expect(result).toEqual({ ok: true, screen: { kind: 'question' } });
    expect(seen).toEqual([['work', { kind: 'show-question' }]]);
  });

  it('незнакомое действие до исполнителя не доходит', async () => {
    expect(parseAction({ kind: 'show-questions' })).toBeNull();
    const result = await actPage(async () => ({ ok: true, screen: { kind: 'idle' } }), {
      session: 'work',
      action: { kind: 'open-question' },
    });
    expect(result).toEqual({ ok: false, reason: 'unsupported', detail: 'not a chat action' });
  });

  it('переход к шагу серии: отпечаток строкой и целый номер шага, иначе — не действие', () => {
    expect(parseAction({ kind: 'step', stamp: 'abc', to: 2, extra: 1 })).toEqual({ kind: 'step', stamp: 'abc', to: 2 });
    expect(parseAction({ kind: 'step', stamp: 'abc', to: '2' })).toBeNull();
    expect(parseAction({ kind: 'step', stamp: 'abc', to: 1.5 })).toBeNull();
    expect(parseAction({ kind: 'step', to: 2 })).toBeNull();
  });
});

describe('parseAction — ключ идемпотентности', () => {
  it('ключ едет только с запросом: строка до 128 знаков; иное значение отбрасывается, запрос остаётся', () => {
    expect(parseAction({ kind: 'prompt', text: 'привет', key: 'k-1' })).toEqual({ kind: 'prompt', text: 'привет', key: 'k-1' });
    expect(parseAction({ kind: 'prompt', text: 'привет', over: true, key: 'k-1' })).toEqual({
      kind: 'prompt',
      text: 'привет',
      over: true,
      key: 'k-1',
    });
    for (const key of ['', 7, null, 'x'.repeat(129)]) {
      expect(parseAction({ kind: 'prompt', text: 'привет', key })).toEqual({ kind: 'prompt', text: 'привет' });
    }
    expect(parseAction({ kind: 'interrupt', key: 'k-1' })).toEqual({ kind: 'interrupt' });
    expect(parseAction({ kind: 'mode', to: 'plan', key: 'k-1' })).toEqual({ kind: 'mode', to: 'plan' });
  });
});

describe('parseAction — «вернуть из очереди»', () => {
  it('действие разбирается: число сообщений — целое неотрицательное, лишние поля отброшены', () => {
    expect(parseAction({ kind: 'unqueue' })).toEqual({ kind: 'unqueue' });
    expect(parseAction({ kind: 'unqueue', queued: 2, key: '\x1b[A' })).toEqual({ kind: 'unqueue', queued: 2 });
    expect(parseAction({ kind: 'unqueue', queued: '2' })).toBeNull();
    expect(parseAction({ kind: 'unqueue', queued: -1 })).toBeNull();
    expect(parseAction({ kind: 'unqueue', queued: 1.5 })).toBeNull();
  });
});
