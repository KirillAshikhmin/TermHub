// @vitest-environment happy-dom
// Сведения о подключении: сбои чата по сессиям — агент, версия, число по видам, время
// последнего; кнопка сброса очищает. Работает и без /api/diag (relay): счётчик на устройстве.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { noteFailure, noteUnknown } from '../src/chat-health';
import { mountDiag } from '../src/diag';
import { setLang, t } from '../src/i18n';

let diagFails = false;
vi.mock('../src/api', () => ({
  api: {
    diag: () =>
      diagFails
        ? Promise.reject(new Error('relay'))
        : Promise.resolve({ version: '1.0.0', host: 'h', uptimeMs: 1000, port: 7710, tls: false, roots: [], sessions: 1, relay: { configured: false } }),
  },
}));

let root: HTMLElement;
beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  diagFails = false;
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('диагностика — сбои чата', () => {
  it('по сессиям: агент и версия, число по видам, время последнего; сброс очищает', async () => {
    noteUnknown('work', 'claude', '2.1.322');
    noteUnknown('work', 'claude', '2.1.322');
    noteFailure('work', 'mode', 'claude', '2.1.322');
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(root.querySelector('.th-diag__chat')).not.toBeNull());
    const row = root.querySelector('.th-diag__chat-row')!;
    const text = row.textContent!;
    expect(text).toContain('work');
    expect(text).toContain('claude 2.1.322');
    expect(text).toContain(`${t('diag.chatKind.unknown')} ×2`);
    expect(text).toContain(`${t('diag.chatKind.mode')} ×1`);
    expect(text).toContain(t('time.justNow'));
    root.querySelector<HTMLButtonElement>('.th-diag__chat-reset')!.click();
    expect(root.querySelector('.th-diag__chat-row')).toBeNull();
    expect(root.querySelector('.th-diag__chat')!.textContent).toContain(t('diag.chatNone'));
    stop();
  });

  it('через relay (диагностики агента нет) счётчик всё равно виден', async () => {
    diagFails = true;
    noteUnknown('w', 'codex');
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(root.querySelector('.th-diag__chat-row')).not.toBeNull());
    expect(root.querySelector('.th-diag__chat-row')!.textContent).toContain('codex');
    stop();
  });

  it('у сессии видны последняя причина неузнанного экрана и её время', async () => {
    noteUnknown('work', 'claude', '2.1.322', 'no footer line');
    noteUnknown('work', 'claude', '2.1.322', 'no input box');
    noteFailure('work', 'mode', 'claude', '2.1.322');
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(root.querySelector('.th-diag__chat-row')).not.toBeNull());
    const why = root.querySelector('.th-diag__chat-why')!;
    expect(why.textContent).toBe(`${t('chat.term.why')} no input box · ${t('time.justNow')}`);
    stop();
  });

  it('причины не было (агент старше) — строки причины нет', async () => {
    noteUnknown('w', 'codex');
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(root.querySelector('.th-diag__chat-row')).not.toBeNull());
    expect(root.querySelector('.th-diag__chat-why')).toBeNull();
    stop();
  });
});
