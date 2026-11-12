// Экран чата — вкладка ленты сессии с агентом (Claude, Codex). Оболочка: каркас сессии
// (полоса сессий и разделов с переключателем вида), переписка из ленты (`mountFeed` в
// режиме чата — оформление, раскрытие действий, ссылки) и именованные места под то, что
// строят следующие таски: полоса состояния, карточка вопроса, окошко терминала и поле
// ввода. Места пустые и ничего не знают о своём содержимом; их заполняет тот, кто ими
// владеет, через `slots`.
//
// Раскладка сверху вниз: [состояние] [переписка] [терминал] [ряд управления] [вопрос]
// [поле ввода]. Переписка занимает всё свободное место и прокручивается сама; остальное —
// по высоте содержимого, поле ввода всегда у нижнего края, карточка вопроса — сразу над ним.

import { mountComposer, type ComposerHandle } from './chat-composer';
import { createChatImages } from './chat-images';
import { mountLive, type LiveHandle } from './chat-live';
import { mountTyped } from './chat-typed';
import { bindChatView } from './chat-view';
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
  /** Место над перепиской: плашка непроверенной версии агента (`chat-live.ts`). Состояние
   *  агента и «Стоп» стоят не здесь, а в строке шапки переписки. */
  status: HTMLElement;
  /** Карточка вопроса или запроса разрешения и кнопка ожидающего вопроса (`chat-live.ts`) —
   *  сразу над полем ввода; ряд управления встаёт перед этим местом. */
  question: HTMLElement;
  /** Окошко живого терминала для неузнанного экрана (`chat-live.ts`, `chat-term.ts`). */
  terminal: HTMLElement;
  /** Поле ввода (`chat-composer.ts`). */
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
    // Шапка сессии — та же, что в виде «Терминал»: настройки и статус подключения.
    tools: true,
  });
  let hideBar = (): void => {};
  const toolbar = document.createElement('div');
  toolbar.className = 'th-holowrap th-slide th-slide--top';
  toolbar.append(renderHoloBar({ active: 'feed', session, transport, onHide: () => hideBar() }));

  const root = document.createElement('main');
  root.className = 'th-chat';
  // Вид (шрифт, размер, интервал) — из настроек терминала, меняется на месте.
  const unbindView = bindChatView(root);

  const offlineEl = document.createElement('div');
  offlineEl.className = 'th-chat__offline';
  offlineEl.setAttribute('role', 'status');
  offlineEl.textContent = t('chat.offline');
  offlineEl.hidden = true;

  const slots: ChatSlots = { status: slot('status'), question: slot('question'), terminal: slot('terminal'), composer: slot('composer') };
  const thread = document.createElement('div');
  thread.className = 'th-chat__thread';
  thread.setAttribute('aria-label', t('chat.thread'));
  root.append(offlineEl, slots.status, thread, slots.terminal, slots.question, slots.composer);
  host.append(sbar.el, toolbar, root);
  hideBar = wireToolbar({ toolbars: [toolbar], floatMount: root, toggleMount: sbar.toggleSlot }).hide;

  let isOffline = false;
  // Пути картинок в сообщениях — миниатюрами; окно просмотра встаёт в границах области чата.
  const images = createChatImages(root, session, transport);
  const feed = mountFeed(thread, session, transport, {
    linker: createPathLinker(transport, session),
    images,
    onConnection: (ok) => {
      isOffline = !ok;
      offlineEl.hidden = ok;
      sbar.setConn(ok ? 'connected' : 'reconnecting');
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
  // Состояние с экрана (слово состояния, время, токены, «Стоп») стоит в строке шапки
  // переписки; пока оно показано, подпись шапки «Агент работает» не дублируется.
  // Окно терминала закрылось — фокус возвращается в поле ввода. Не перехватывается у
  // поля своего ответа карточки вопроса; на телефоне (грубый указатель) — только при
  // закрытии кнопкой: иначе клавиатура выскакивала бы сама.
  let composer: ComposerHandle | null = null;
  const onTerminalClosed = (byButton: boolean): void => {
    if (!composer) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.th-live-q__free')) return;
    if (!byButton && typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return;
    composer.focus();
  };
  const live = mountLive({ ...slots, head: feed.stateSlot, stop: feed.stopSlot, onTerminalClosed }, session, transport, (state, changed) => {
    feed.setStateShown(state !== null);
    // Пока агент работает, переписка дочитывается раз в секунду.
    feed.setBusy(state?.screen.kind === 'working');
    if (changed) feed.refresh();
  });

  // Поле ввода — тем, у кого есть право ввода; зрителю места под него нет вовсе.
  const readOnly = !!transport.clientScope && !transport.clientScope.write;
  composer = readOnly ? null : mountComposer(slots.composer, session, { transport, live, thread: feed });

  // Текст, набранный в строке агента в терминале, виден над полем (и зрителю — без кнопки).
  // Строка встаёт над рядом управления: тот остаётся вплотную к полю.
  const typed = mountTyped(root.querySelector<HTMLElement>('.th-live__controls') ?? slots.composer, { live, field: composer });

  return {
    ...feed,
    el: root,
    feed,
    slots,
    live,
    composer,
    offline: () => isOffline,
    teardown: () => {
      unbindView();
      typed.teardown();
      composer?.teardown();
      live.teardown();
      images.teardown();
      feed.teardown();
      sbar.teardown();
      host.replaceChildren();
    },
  };
}
