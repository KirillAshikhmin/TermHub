// Диагностическая страница: версия/аптайм агента, статус связи с relay, число
// клиентов и сессий, корни. Отдаётся агентом (LAN-режим); в relay-режиме /api/diag
// недоступен — показываем подсказку открыть на LAN-адресе. Обновляется поллингом.
// Способ подключения терминала приходит не отсюда, а кадром состояния от агента —
// страница называет последний известный (term-mode.ts) и текущую просьбу клиента.

import { api } from './api';
import type { DiagInfo } from './api';
import { t } from './i18n';
import { lastTerminalMode, terminalModeName, terminalModeRequest } from './term-mode';
import { relayTransportInUse } from './relay-transport-state';
import { iconButton, openModal, renderHeader, spinner } from './ui';
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

/** Сведения о подключении всплывающим окном: поверх текущего экрана, а не вместо него —
 *  раньше пункт меню уводил на отдельную страницу, с которой назад была только главная. */
export function openDiag(): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-diag-modal';
    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('diag.title');
    head.append(title, iconButton('close', t('common.close'), close));
    const body = document.createElement('div');
    body.className = 'th-diag th-diag--modal';
    box.append(head, body);
    const stop = fillDiag(body);
    // У окна нет своего события закрытия: опрос гаснет сам, когда тело ушло со страницы.
    const watch = setInterval(() => {
      if (box.isConnected) return;
      clearInterval(watch);
      stop();
    }, 1000);
    return box;
  });
}

/** Страница диагностики по прямой ссылке `#/diag` (из меню открывается окно). */
export function mountDiag(root: HTMLElement, transport?: Transport): () => void {
  root.replaceChildren();
  const header = renderHeader(true, transport);
  const main = document.createElement('main');
  main.className = 'th-diag';
  root.append(header.el, main);
  const stop = fillDiag(main);
  return () => {
    stop();
    header.teardown();
  };
}

function diagRow(key: string, value: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'th-diag__row';
  const kk = document.createElement('span');
  kk.className = 'th-diag__k';
  kk.textContent = key;
  const vv = document.createElement('span');
  vv.className = 'th-diag__v';
  vv.textContent = value;
  row.append(kk, vv);
  return row;
}

function browserTransportName(via: 'ws' | 'poll' | 'rtc'): string {
  if (via === 'rtc') return t('diag.transportRtc');
  if (via === 'poll') return t('diag.transportPoll');
  return t('diag.transportWs');
}

/** Наполняет main сведениями агента и обновляет их опросом; возвращает остановку. */
function fillDiag(main: HTMLElement): () => void {
  main.append(spinner());

  let stopped = false;

  const render = (d: DiagInfo): void => {
    main.replaceChildren();
    const lastMode = lastTerminalMode();
    const card = document.createElement('div');
    card.className = 'th-diag__card';

    // Внешнего relay нет, но есть свой — плашка говорит о нём.
    const anyRelay = d.relay.configured || d.localRelay !== undefined;
    const relayOk = d.relay.configured ? d.relay.connected : d.localRelay?.connected === true;
    const badge = document.createElement('div');
    badge.className = `th-diag__status ${!anyRelay ? 'is-off' : relayOk ? 'is-ok' : 'is-bad'}`;
    badge.textContent = !anyRelay
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
      [t('diag.terminalMode'), lastMode ? terminalModeName(lastMode) : '—'],
      [t('diag.terminalModeRequest'), terminalModeName(terminalModeRequest())],
    ];
    if (d.relay.configured) {
      rows.push(
        [t('diag.relayUrl'), d.relay.url],
        [t('diag.agentId'), d.relay.agentId || '—'],
        [t('diag.clients'), String(d.relay.clients)],
      );
      if (d.relay.dial) rows.push([t('diag.relayDial'), d.relay.dial]);
    }
    if (d.localRelay) {
      const lr = d.localRelay;
      const state = !lr.running ? t('diag.localRelayDown') : lr.connected ? t('diag.relayOk') : t('diag.relayBad');
      rows.push([
        t('diag.localRelay'),
        `:${lr.port}${lr.tls ? ' · TLS' : ''} · ${state} · ${t('diag.clients')}: ${lr.clients}`,
      ]);
    }
    rows.push([t('diag.roots'), d.roots.join('\n')]);

    for (const [k, v] of rows) card.append(diagRow(k, v));
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
        // Через relay сведений агента нет, но способ, которым сама эта вкладка дошла
        // до relay, известен здесь — его и показываем.
        const via = relayTransportInUse();
        if (via) {
          const card = document.createElement('div');
          card.className = 'th-diag__card';
          card.append(diagRow(t('diag.browserTransport'), browserTransportName(via)));
          main.append(card);
        }
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
  };
}
