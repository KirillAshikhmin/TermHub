// Экран чата — вкладка ленты сессии с агентом (Claude, Codex). Оболочка: каркас сессии
// (полоса сессий и разделов с переключателем вида), переписка из ленты (`mountFeed` в
// режиме чата — оформление, раскрытие действий, ссылки) и именованные места под то, что
// строят следующие таски: полоса состояния, карточка вопроса, окошко терминала и поле
// ввода. Места пустые и ничего не знают о своём содержимом; их заполняет тот, кто ими
// владеет, через `slots`.
//
// Раскладка сверху вниз: [состояние] [переписка] [вопрос] [терминал] [поле ввода].
// Переписка занимает всё свободное место и прокручивается сама; остальное — по высоте
// содержимого, поле ввода всегда у нижнего края.

import { mountComposer, type ComposerHandle } from './chat-composer';
import { mountLive, type LiveHandle } from './chat-live';
import { mountFeed, type FeedHandle } from './feed';
import { createPathLinker } from './chat-render';
import { openCreateModal } from './dashboard';
import { t } from './i18n';
import { termHash } from './routes';
import { mountSessionBar } from './tabs';
import type { Transport } from './transport';
import { renderHoloBar, wireToolbar } from './ui';
import { setSessionViewPref } from './view-pref';

/** Места оболочки. Имя места — и ключ здесь, и `data-slot` в разметке. */
export interface ChatSlots {
  /** Полоса состояния агента: что делает, очередь, «Стоп» (`chat-live.ts`). */
  status: HTMLElement;
  /** Карточка вопроса или запроса разрешения (`chat-live.ts`). */
  question: HTMLElement;
  /** Окошко живого терминала для неузнанного экрана (`chat-live.ts`, `chat-term.ts`). */
  terminal: HTMLElement;
  /** Поле ввода (`chat-composer.ts`). Ряд управления (режим, модель, контекст) встаёт перед ним. */
  composer: HTMLElement;
}

/** Ручка чата: всё, что умела лента (поиск, прыжок, подкачка), плюс места оболочки. */
export interface ChatHandle extends FeedHandle {
  /** Переписка (прежняя лента) — для тех, кому нужен именно её экран. */
  feed: FeedHandle;
  slots: ChatSlots;
  /** Состояние агента с экрана панели: `state()`, `act(action)`, `subscribe(fn)`. Поле
   *  ввода узнаёт по нему, что агент делает, и шлёт действия через него же. */
  live: LiveHandle;
  /** Поле ввода; null — у зрителя без права `write` его нет. */
  composer: ComposerHandle | null;
  /** Связь с агентом сейчас потеряна (переписка на экране остаётся). */
  offline(): boolean;
}

function slot(name: keyof ChatSlots): HTMLElement {
  const el = document.createElement('div');
  el.className = `th-chat__slot th-chat__slot--${name}`;
  el.dataset.slot = name;
  el.setAttribute('aria-label', t(`chat.slot.${name}`));
  return el;
}

/** Монтирует чат сессии в host. */
export function mountChat(host: HTMLElement, session: string, transport: Transport): ChatHandle {
  host.replaceChildren();

  const sbar = mountSessionBar({
    transport,
    current: session,
    // Новая сессия открывается так, как её открывают с главной: вид решает вход в сессию.
    onSwitch: (name) => (location.hash = termHash(name)),
    onCreate: () => openCreateModal(transport),
  });
  let hideBar = (): void => {};
  const toolbar = document.createElement('div');
  toolbar.className = 'th-holowrap th-slide th-slide--top';
  toolbar.append(renderHoloBar({ active: 'feed', session, transport, onHide: () => hideBar() }));

  const root = document.createElement('main');
  root.className = 'th-chat';

  const offlineEl = document.createElement('div');
  offlineEl.className = 'th-chat__offline';
  offlineEl.setAttribute('role', 'status');
  offlineEl.textContent = t('chat.offline');
  offlineEl.hidden = true;

  const slots: ChatSlots = { status: slot('status'), question: slot('question'), terminal: slot('terminal'), composer: slot('composer') };
  const thread = document.createElement('div');
  thread.className = 'th-chat__thread';
  thread.setAttribute('aria-label', t('chat.thread'));
  root.append(offlineEl, slots.status, thread, slots.question, slots.terminal, slots.composer);
  host.append(sbar.el, toolbar, root);
  hideBar = wireToolbar({ toolbars: [toolbar], floatMount: root, toggleMount: sbar.toggleSlot }).hide;

  let isOffline = false;
  const feed = mountFeed(thread, session, transport, {
    linker: createPathLinker(transport, session),
    onConnection: (ok) => {
      isOffline = !ok;
      offlineEl.hidden = ok;
    },
    emptyState: (reason) => {
      const box = document.createElement('div');
      box.className = 'th-chat__empty';
      const text = document.createElement('p');
      text.className = 'th-chat__empty-text';
      if (reason === 'no-transcript') {
        text.textContent = t('chat.empty');
        box.append(text);
        return box;
      }
      text.textContent = t('chat.noAgent');
      const hint = document.createElement('p');
      hint.className = 'th-chat__empty-hint';
      hint.textContent = t('chat.noAgentHint');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'th-btn th-chat__to-term';
      btn.textContent = t('chat.toTerminal');
      btn.addEventListener('click', () => {
        setSessionViewPref(session, 'term');
        location.hash = termHash(session);
      });
      box.append(text, hint, btn);
      return box;
    },
  });

  // Живая часть: смена состояния агента сразу тянет приращение переписки. Агента нет
  // (opencode, оболочка) — запрос живого экрана отвечает отказом, и полосы не видно.
  const live = mountLive(slots, session, transport, (_state, changed) => {
    if (changed) feed.refresh();
  });

  // Поле ввода — тем, у кого есть право ввода; зрителю места под него нет вовсе.
  const readOnly = !!transport.clientScope && !transport.clientScope.write;
  const composer: ComposerHandle | null = readOnly ? null : mountComposer(slots.composer, session, { transport, live, thread: feed });

  return {
    ...feed,
    el: root,
    feed,
    slots,
    live,
    composer,
    offline: () => isOffline,
    teardown: () => {
      composer?.teardown();
      live.teardown();
      feed.teardown();
      sbar.teardown();
      host.replaceChildren();
    },
  };
}
