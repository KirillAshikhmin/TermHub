// Диагностическая страница: версия/аптайм агента, статус связи с relay, число
// клиентов и сессий, корни. Отдаётся агентом (LAN-режим); в relay-режиме /api/diag
// недоступен — показываем подсказку открыть на LAN-адресе. Обновляется поллингом.

import { api } from './api';
import type { DiagInfo } from './api';
import { t } from './i18n';
import { renderHeader, spinner } from './ui';
import type { Transport } from './transport';

function fmtUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}д ${h}ч ${m}м`;
  if (h) return `${h}ч ${m}м`;
  return `${m}м ${s % 60}с`;
}

export function mountDiag(root: HTMLElement, transport?: Transport): () => void {
  root.replaceChildren();
  const header = renderHeader(true, transport);
  const main = document.createElement('main');
  main.className = 'th-diag';
  root.append(header.el, main);
  main.append(spinner());

  let stopped = false;

  const render = (d: DiagInfo): void => {
    main.replaceChildren();
    const card = document.createElement('div');
    card.className = 'th-diag__card';

    const relayOk = d.relay.configured && d.relay.connected;
    const badge = document.createElement('div');
    badge.className = `th-diag__status ${!d.relay.configured ? 'is-off' : relayOk ? 'is-ok' : 'is-bad'}`;
    badge.textContent = !d.relay.configured
      ? t('diag.relayOff')
      : relayOk
        ? t('diag.relayOk')
        : t('diag.relayBad');
    card.append(badge);

    const rows: Array<[string, string]> = [
      [t('diag.version'), d.version],
      [t('diag.host'), `${d.host}:${d.port}${d.tls ? ' · TLS' : ''}`],
      [t('diag.uptime'), fmtUptime(d.uptimeMs)],
      [t('diag.sessions'), String(d.sessions)],
    ];
    if (d.relay.configured) {
      rows.push(
        [t('diag.relayUrl'), d.relay.url],
        [t('diag.agentId'), d.relay.agentId || '—'],
        [t('diag.clients'), String(d.relay.clients)],
      );
    }
    rows.push([t('diag.roots'), d.roots.join('\n')]);

    for (const [k, v] of rows) {
      const row = document.createElement('div');
      row.className = 'th-diag__row';
      const kk = document.createElement('span');
      kk.className = 'th-diag__k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'th-diag__v';
      vv.textContent = v;
      row.append(kk, vv);
      card.append(row);
    }
    main.append(card);
  };

  const load = (): void => {
    api.diag().then(
      (d) => {
        if (!stopped) render(d);
      },
      () => {
        if (stopped) return;
        main.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-diag__note';
        p.textContent = t('diag.unavailable');
        main.append(p);
      },
    );
  };

  load();
  const timer = setInterval(load, 3000);
  return () => {
    stopped = true;
    clearInterval(timer);
    header.teardown();
  };
}
