// Оркестратор remote-режима (relay): выбор известного агента, пейринг по коду и
// маршрутизация экранов поверх RelayTransport. Грузится ЛЕНИВО (динамический
// import из main.ts) — вся крипто (libsodium) и relay-код живут в отдельном
// чанке, LAN-бандл их не тянет.

import { initCrypto } from '@termhub/protocol';
import type { Identity } from '@termhub/protocol';

import { mountDashboard } from './dashboard';
import { mountFiles } from './files';
import { mountRepo } from './repo';
import { t } from './i18n';
import { addAgent, listAgents, loadClientName, loadIdentity, removeAgent } from './keys';
import type { KnownAgent } from './keys';
import { mountPairing } from './pairing';
import { RelayTransport } from './relay-transport';
import type { LinkStatus } from './relay-transport';
import type { Transport } from './transport';
import { openTerminal } from './term';
import { iconButton, renderHeader, svgIcon, toast } from './ui';

/** Роут, распознанный роутером main.ts. */
export type RemoteRoute =
  | { name: 'login' }
  | { name: 'dashboard' }
  | { name: 'term'; session: string }
  | { name: 'files' }
  | { name: 'repo' }
  | { name: 'sfiles'; session: string }
  | { name: 'srepo'; session: string }
  | { name: 'diag' }
  | { name: 'pair' };

/** Контроллер remote-режима: рендер экрана по роуту + удержание relay-транспорта. */
export interface RemoteController {
  render(root: HTMLElement, route: RemoteRoute): () => void;
  /** Активный транспорт (или null, если ещё не подключён) — для рабочего пространства. */
  activeTransport(): Transport | null;
}

function relayWsUrl(): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
}

/** Инициализирует крипто/ключи и возвращает контроллер remote-режима. */
export async function createRemote(opts: { rerender: () => void }): Promise<RemoteController> {
  await initCrypto();
  const identity: Identity = await loadIdentity();
  const clientName = await loadClientName();
  const wsUrl = relayWsUrl();

  let agents: KnownAgent[] = await listAgents();
  let transport: RelayTransport | null = null;
  let activeAgentId: string | null = null;
  // Первый выход текущего транспорта в online уже случился — влияет на онлайн-хук
  // (см. onLink): пересобираем экран только на ПЕРВЫЙ online, реконнекты не трогаем.
  let firstOnlineDone = false;

  const dropTransport = (): void => {
    transport?.close();
    transport = null;
    activeAgentId = null;
    firstOnlineDone = false;
  };

  const onLink = (status: LinkStatus): void => {
    // Агент отверг устройство (пейринг отозван) — назад к выбору с пояснением.
    if (status === 'unauthorized') {
      toast(t('remote.unauthorized'), 'error');
      dropTransport();
      opts.rerender();
      return;
    }
    // Поток впервые установлен: пересобираем экран, чтобы дашборд, показавший
    // «Подключение к агенту…», сразу загрузил список, не дожидаясь 3с-полла.
    // Повторные online — это реконнект уже загруженного дашборда: там свой
    // поллинг восстанавливает данные, перерисовка только мигнула бы скелетоном.
    if (status === 'online' && !firstOnlineDone) {
      firstOnlineDone = true;
      opts.rerender();
    }
  };

  const LAST_AGENT_KEY = 'termhub.lastAgent';
  const readLastAgent = (): string | null => {
    try {
      return localStorage.getItem(LAST_AGENT_KEY);
    } catch {
      return null;
    }
  };

  // Подключение к агенту без перерисовки (для автовыбора на старте — до первого render).
  const connect = (agent: KnownAgent): void => {
    dropTransport();
    transport = new RelayTransport({
      url: wsUrl,
      identity,
      agent: { agentId: agent.agentId, edPub: agent.edPub },
      clientName,
      onLink,
    });
    activeAgentId = agent.agentId;
  };

  const selectAgent = (agent: KnownAgent): void => {
    if (activeAgentId === agent.agentId && transport) return;
    connect(agent);
    try {
      localStorage.setItem(LAST_AGENT_KEY, agent.agentId); // запоминаем последний
    } catch {
      // localStorage недоступен — просто не запоминаем.
    }
    opts.rerender();
  };

  // «Выбор агента» из меню дашборда: отключаемся и показываем экран выбора.
  const showPicker = (): void => {
    dropTransport();
    location.hash = '#/';
    opts.rerender();
  };

  // Автовыбор последнего агента — при обновлении страницы не спрашиваем заново.
  const lastId = readLastAgent();
  const lastAgent = lastId ? agents.find((a) => a.agentId === lastId) : undefined;
  if (lastAgent) connect(lastAgent);

  /** Строка агента: выбор по клику + удаление. */
  const agentRow = (agent: KnownAgent): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'th-agent';

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'th-agent__pick';
    const name = document.createElement('span');
    name.className = 'th-agent__name';
    name.textContent = agent.name;
    const id = document.createElement('span');
    id.className = 'th-agent__id';
    id.textContent = agent.agentId;
    pick.append(svgIcon('devices'), name, id);
    pick.addEventListener('click', () => selectAgent(agent));

    const del = iconButton('trash', t('remote.removeAgent'), () => {
      void removeAgent(agent.agentId)
        .then(() => listAgents())
        .then((next) => {
          agents = next;
          if (activeAgentId === agent.agentId) dropTransport();
          opts.rerender();
        });
    });

    row.append(pick, del);
    return row;
  };

  /** Экран выбора агента: список известных + «добавить по коду». */
  const mountAgentPicker = (root: HTMLElement): (() => void) => {
    root.replaceChildren();
    const header = renderHeader(false);
    root.append(header.el);

    const main = document.createElement('main');
    main.className = 'th-login';

    const card = document.createElement('div');
    card.className = 'th-login__card';

    const title = document.createElement('h1');
    title.className = 'th-login__title';
    title.textContent = t('remote.pickTitle');

    const subtitle = document.createElement('p');
    subtitle.className = 'th-login__subtitle';
    subtitle.textContent = agents.length ? t('remote.pickSubtitle') : t('remote.pickEmpty');
    card.append(title, subtitle);

    if (agents.length) {
      const list = document.createElement('div');
      list.className = 'th-agents';
      for (const agent of agents) list.append(agentRow(agent));
      card.append(list);
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'th-btn th-btn--primary th-login__submit';
    add.textContent = t('remote.addByCode');
    add.addEventListener('click', () => {
      location.hash = '#/pair';
    });
    card.append(add);

    main.append(card);
    root.append(main);

    return () => {
      header.teardown();
      root.replaceChildren();
    };
  };

  const mountPair = (root: HTMLElement): (() => void) =>
    mountPairing(root, {
      wsUrl,
      identity,
      clientName,
      onPaired: (agent) => {
        void addAgent(agent)
          .then(() => listAgents())
          .then((next) => {
            agents = next;
            location.hash = '#/';
            selectAgent(agent);
          });
      },
      onCancel: () => {
        location.hash = '#/';
      },
    });

  return {
    render(root: HTMLElement, route: RemoteRoute): () => void {
      if (route.name === 'pair') return mountPair(root);
      if (route.name === 'term') {
        if (transport) return openTerminal(root, route.session, transport);
        location.hash = '#/';
        return mountAgentPicker(root);
      }
      if (route.name === 'files') {
        if (transport) return mountFiles(root, transport);
        location.hash = '#/';
        return mountAgentPicker(root);
      }
      if (route.name === 'repo') {
        if (transport) return mountRepo(root, transport);
        location.hash = '#/';
        return mountAgentPicker(root);
      }
      if (route.name === 'sfiles') {
        if (transport) return mountFiles(root, transport, route.session);
        location.hash = '#/';
        return mountAgentPicker(root);
      }
      if (route.name === 'srepo') {
        if (transport) return mountRepo(root, transport, route.session);
        location.hash = '#/';
        return mountAgentPicker(root);
      }
      // login/dashboard → дашборд активного агента или экран выбора.
      if (transport) return mountDashboard(root, transport, { onPickAgent: showPicker });
      return mountAgentPicker(root);
    },
    activeTransport: () => transport,
  };
}
