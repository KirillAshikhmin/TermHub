// Экран выбора сервера: список известных агентов со статусом и адреса прямого
// доступа к каждому.
//
// Модуль намеренно НЕ импортирует keys.ts: тот тянет libsodium, а список серверов
// открывается в том числе с экрана терминала, который живёт в LAN-бандле. Данные
// приходят параметром — здесь только отрисовка.
//
// Про прямые адреса: это ПЕРЕХОД браузера, а не смена транспорта внутри страницы.
// Облачная страница загружена по https и не может открыть соединение к локальному
// адресу (mixed content, а сертификат агента выписан не на IP), зато переход
// верхнего уровня разрешён — и предупреждение о сертификате там можно принять.

import { t } from './i18n';
import { openModal, svgIcon } from './ui';

/** Состояние сервера в списке. */
export type ServerState = 'current' | 'known';

export interface ServerEntry {
  id: string;
  name: string;
  state: ServerState;
  /** Адреса прямого доступа, которые сообщил сам агент. */
  localUrls: string[];
}

export interface ServersModalOpts {
  entries: ServerEntry[];
  /** Переключиться на агента (смена транспорта внутри страницы). */
  onSelect(id: string): void;
  /** Открыть экран добавления агента по коду сопряжения. */
  onAdd?: () => void;
}

/** Строка одного сервера со статусом и списком прямых адресов. */
function serverRow(entry: ServerEntry, opts: ServersModalOpts, close: () => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'th-server';
  if (entry.state === 'current') row.classList.add('is-current');

  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'th-server__pick';
  pick.append(svgIcon('globe'));

  const label = document.createElement('span');
  label.className = 'th-server__label';
  const name = document.createElement('span');
  name.className = 'th-server__name';
  name.textContent = entry.name;
  const sub = document.createElement('span');
  sub.className = 'th-server__id';
  sub.textContent = entry.id;
  label.append(name, sub);
  pick.append(label);

  const badge = document.createElement('span');
  badge.className = `th-server__state is-${entry.state}`;
  badge.textContent = entry.state === 'current' ? t('servers.current') : t('servers.known');
  pick.append(badge);

  pick.addEventListener('click', () => {
    close();
    opts.onSelect(entry.id);
  });
  row.append(pick);

  if (entry.localUrls.length > 0) {
    const direct = document.createElement('div');
    direct.className = 'th-server__direct';
    const caption = document.createElement('span');
    caption.className = 'th-server__caption';
    caption.textContent = t('servers.direct');
    direct.append(caption);
    for (const url of entry.localUrls) {
      // Именно ссылка, а не кнопка: это уход на другой origin, и пользователь должен
      // видеть адрес и уметь открыть его в новой вкладке.
      const link = document.createElement('a');
      link.className = 'th-server__url';
      link.href = url;
      link.textContent = url;
      link.rel = 'noreferrer';
      direct.append(link);
    }
    row.append(direct);
  }

  return row;
}

/** Открывает модалку выбора сервера. Возвращает функцию закрытия. */
export function openServersModal(opts: ServersModalOpts): () => void {
  return openModal((close) => {
    const form = document.createElement('div');
    form.className = 'th-modal__form';

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('servers.title');
    head.append(title);

    const body = document.createElement('div');
    body.className = 'th-modal__body';

    if (opts.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'th-modal__hint';
      empty.textContent = t('servers.empty');
      body.append(empty);
    } else {
      for (const entry of opts.entries) body.append(serverRow(entry, opts, close));
    }

    // Прямой адрес уводит из установленного приложения в браузер — говорим об этом
    // заранее, иначе уход выглядит как сбой.
    const hint = document.createElement('p');
    hint.className = 'th-modal__hint';
    hint.textContent = t('servers.directHint');
    body.append(hint);

    const foot = document.createElement('div');
    foot.className = 'th-modal__foot';
    if (opts.onAdd) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'th-btn';
      add.textContent = t('remote.addByCode');
      add.addEventListener('click', () => {
        close();
        opts.onAdd?.();
      });
      foot.append(add);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'th-btn th-btn--ghost';
    cancel.textContent = t('common.close');
    cancel.addEventListener('click', close);
    foot.append(cancel);

    form.append(head, body, foot);
    return form;
  });
}
