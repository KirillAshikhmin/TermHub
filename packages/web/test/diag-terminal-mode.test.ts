// @vitest-environment happy-dom
// Страница диагностики называет способ подключения терминала: агент его в /api/diag
// не отдаёт, поэтому строка берётся из последнего кадра состояния (term-mode.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDiag } from '../src/diag';
import { setLang, t } from '../src/i18n';
import { noteTerminalMode, setTerminalModeRequest } from '../src/term-mode';

vi.mock('../src/api', () => ({
  api: {
    diag: () =>
      Promise.resolve({
        version: '1.0.0',
        host: 'mac.local',
        uptimeMs: 60_000,
        port: 7710,
        tls: false,
        roots: ['/Users/me'],
        sessions: 2,
        relay: { configured: false },
      }),
  },
}));

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

/** Значение строки карточки по её подписи. */
function row(label: string): string | undefined {
  for (const el of root.querySelectorAll('.th-diag__row')) {
    if (el.querySelector('.th-diag__k')?.textContent === label) return el.querySelector('.th-diag__v')?.textContent ?? '';
  }
  return undefined;
}

describe('диагностика — способ подключения терминала', () => {
  it('называет режим из последнего кадра состояния и просьбу клиента', async () => {
    noteTerminalMode('attach');
    setTerminalModeRequest('control');

    const teardown = mountDiag(root);
    await vi.waitFor(() => expect(row(t('diag.terminalMode'))).toBeDefined());

    expect(row(t('diag.terminalMode'))).toBe(t('term.modeAttach'));
    expect(row(t('diag.terminalModeRequest'))).toBe(t('term.modeControl'));
    teardown();
  });

  it('терминал ещё не открывали — режим не выдумывается', async () => {
    const teardown = mountDiag(root);
    await vi.waitFor(() => expect(row(t('diag.terminalMode'))).toBeDefined());

    expect(row(t('diag.terminalMode'))).toBe('—');
    teardown();
  });
});
