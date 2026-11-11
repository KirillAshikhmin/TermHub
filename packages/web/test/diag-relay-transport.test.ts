// @vitest-environment happy-dom
// Диагностика называет способ связи с relay: агента — из /api/diag, а этой вкладки —
// из того, каким сокетом она открыла соединение (через relay сведений агента нет вовсе).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDiag } from '../src/diag';
import { setLang, t } from '../src/i18n';
import { setRelayTransportInUse } from '../src/relay-transport-state';

const diag = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../src/api', () => ({ api: { diag: diag.fn } }));

let root: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  setRelayTransportInUse(null);
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

function row(label: string): string | undefined {
  for (const el of root.querySelectorAll('.th-diag__row')) {
    if (el.querySelector('.th-diag__k')?.textContent === label) return el.querySelector('.th-diag__v')?.textContent ?? '';
  }
  return undefined;
}

const AGENT = {
  version: '1.0.0',
  host: 'mac.local',
  uptimeMs: 60_000,
  port: 7710,
  tls: true,
  roots: ['/Users/me'],
  sessions: 2,
};

describe('способ связи с relay в диагностике', () => {
  it('LAN: строка «Связь агента с relay» показывает способ из ответа агента', async () => {
    diag.fn.mockResolvedValue({
      ...AGENT,
      relay: { configured: true, url: 'wss://relay.example.com/relay', connected: true, agentId: 'A1', clients: 1, dial: 'websocket, via 127.0.0.1:19443' },
    });
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(row(t('diag.relayDial'))).toBe('websocket, via 127.0.0.1:19443'));
    expect(row(t('diag.browserTransport'))).toBeUndefined();
    stop();
  });

  it('старый агент способа не называет — строки нет', async () => {
    diag.fn.mockResolvedValue({
      ...AGENT,
      relay: { configured: true, url: 'wss://relay.example.com/relay', connected: true, agentId: 'A1', clients: 1 },
    });
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(row(t('diag.clients'))).toBe('1'));
    expect(row(t('diag.relayDial'))).toBeUndefined();
    stop();
  });

  it.each([
    ['rtc', 'diag.transportRtc'],
    ['poll', 'diag.transportPoll'],
    ['ws', 'diag.transportWs'],
  ] as const)('через relay: вкладка называет свой способ (%s) рядом с пояснением', async (via, key) => {
    diag.fn.mockRejectedValue(new Error('404'));
    setRelayTransportInUse(via);
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(row(t('diag.browserTransport'))).toBe(t(key)));
    expect(root.querySelector('.th-diag__note')?.textContent).toBe(t('diag.unavailable'));
    stop();
  });

  it('LAN без relay и сбой диагностики: строки о способе нет', async () => {
    diag.fn.mockRejectedValue(new Error('network'));
    const stop = mountDiag(root);
    await vi.waitFor(() => expect(root.querySelector('.th-diag__note')).not.toBeNull());
    expect(row(t('diag.browserTransport'))).toBeUndefined();
    stop();
  });
});
