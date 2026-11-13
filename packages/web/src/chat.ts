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

import { onOverlayClosed } from './overlay-events';
import { updateAppBadge } from './app-badge';
import { markBellSeen, unseenBellCount } from './bell-seen';
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
import type { ChatAction, ScreenState } from '@termhub/protocol/chat';
import { renderHoloBar, toast, wireToolbar } from './ui';
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
  /** Чат показан (переключение вида, вкладка сессии, возврат из другого раздела): фокус в
   *  поле ввода — если его не у кого отбирать (см. `claimFocus`). */
  focusInput(): void;
}

function slot(name: keyof ChatSlots): HTMLElement {
  const el = document.createElement('div');
  el.className = `th-chat__slot th-chat__slot--${name}`;
  el.dataset.slot = name;
  el.setAttribute('aria-label', t(`chat.slot.${name}`));
  return el;
}

/** Окна, открытые поверх чата: пока есть хоть одно, фокус у него не отбирают. Окно, которое
 *  уже гаснет (`data-closing`), открытым не считается. */
const OPEN_LAYERS =
  '.th-overlay:not([data-closing]), .th-palette, .th-spanel.is-open, .th-imgview, .th-menu.is-open, .th-live__sheet:not([hidden])';

/** Монтирует чат сессии в host. */
export function mountChat(host: HTMLElement, session: string, transport: Transport): ChatHandle {
  host.replaceChildren();

  const sbar = mountSessionBar({
    transport,
    current: session,
    // Новая сессия открывается так, как её открывают с главной: вид решает вход в сессию.
    onSwitch: (name) => (location.hash = termHash(name)),
    // Нажатие на вкладку уже открытой сессии вид не меняет — возвращает фокус в поле.
    onCurrent: () => claimFocus('shown'),
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

  // Агент вышел при открытом чате (опрос состояния отвечает `no-agent`): переписка остаётся,
  // писать некому — строка под перепиской и переход в терминал.
  const toTerminal = (): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'th-btn th-chat__to-term';
    btn.textContent = t('chat.toTerminal');
    btn.addEventListener('click', () => {
      setSessionViewPref(session, 'term');
      location.hash = termHash(session);
    });
    return btn;
  };
  const goneEl = document.createElement('div');
  goneEl.className = 'th-chat__gone';
  goneEl.setAttribute('role', 'status');
  const goneText = document.createElement('span');
  goneText.className = 'th-chat__gone-text';
  goneText.textContent = t('chat.noAgent');
  goneEl.append(goneText, toTerminal());
  goneEl.hidden = true;

  const slots: ChatSlots = { status: slot('status'), question: slot('question'), terminal: slot('terminal'), composer: slot('composer') };
  const thread = document.createElement('div');
  thread.className = 'th-chat__thread';
  thread.setAttribute('aria-label', t('chat.thread'));
  // Состояние агента («Работает… · время · токены») — между перепиской и нижней панелью,
  // как строка работы в терминале; название агента остаётся в шапке переписки.
  const stateRow = document.createElement('div');
  stateRow.className = 'th-chat__state';
  root.append(offlineEl, slots.status, thread, stateRow, goneEl, slots.terminal, slots.question, slots.composer);
  // Открытый чат и любое действие в нём — просмотр сессии: её звонок прочитан (как ввод
  // в терминале).
  const seen = (): void => {
    markBellSeen(session);
    updateAppBadge(unseenBellCount());
  };
  seen();
  for (const type of ['pointerdown', 'keydown', 'focusin'] as const) root.addEventListener(type, seen, true);
  host.append(sbar.el, toolbar, root);
  hideBar = wireToolbar({ toolbars: [toolbar], floatMount: root, toggleMount: sbar.toggleSlot }).hide;

  let isOffline = false;
  // Пути картинок в сообщениях — миниатюрами; окно просмотра встаёт в границах области чата.
  const images = createChatImages(root, session, transport);
  const feed = mountFeed(thread, session, transport, {
    linker: createPathLinker(transport, session),
    images,
    // Ответ из записи вопроса: вопрос обязан ждать на экране агента — показанным либо в
    // очереди (тогда он сначала открывается), и нести вариант с той же подписью.
    onAnswer: async (_question, pick) => {
      const handle = liveHandle;
      if (!handle || (!!transport.clientScope && !transport.clientScope.write)) return false;
      const same = (a: string, b: string): boolean => a.replace(/\s+/gu, ' ').trim() === b.replace(/\s+/gu, ' ').trim();
      type Answer = Extract<ChatAction, { kind: 'answer' }>;
      const shown = (screen: ScreenState | undefined): Answer | undefined => {
        const q = screen?.kind === 'question' ? screen.question : undefined;
        if (!q || q.multi) return undefined;
        // Свой текст — только вопросу без вариантов, с одним полем ответа.
        if ('text' in pick) return q.field === undefined ? undefined : { kind: 'answer', stamp: q.stamp, text: pick.text };
        const option = q.options.find((o) => !o.free && same(o.label, pick.label));
        return option ? { kind: 'answer', stamp: q.stamp, option: option.key } : undefined;
      };
      try {
        let screen = handle.state()?.screen;
        let found = shown(screen);
        if (!found && screen?.pending === true) {
          const opened = await handle.act({ kind: 'show-question' });
          if (opened.ok) found = shown((screen = opened.screen));
        }
        if (!found) {
          toast(t('chat.question.gone'), 'error');
          return false;
        }
        const res = await handle.act(found);
        if (!res.ok) toast(t('chat.question.failed'), 'error');
        else feed.refresh();
        return res.ok;
      } catch {
        toast(t('chat.live.actFailed'), 'error');
        return false;
      }
    },
    onConnection: (ok) => {
      // Связь есть — миниатюры, не дошедшие из-за сбоя, спрашиваются заново (сбой мог
      // прийтись между опросами, и переписка его не заметила).
      if (ok) images.retry();
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
      box.append(text, hint, toTerminal());
      // Пустое состояние уже говорит «агент не запущен»: строка под перепиской его не повторяет.
      queueMicrotask(() => syncGone());
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
  // Все правила фокуса поля ввода — здесь, чтобы показ чата, нажатие на текущую вкладку и
  // закрытие окна терминала не спорили. Не перехватывается никогда: у поля своего ответа
  // карточки вопроса. Не перехватывается без нажатия кнопки: у открытого окна (настройки,
  // сведения, окно сессий), палитры и поля поиска по беседе.
  const claimFocus = (why: 'shown' | 'returned' | 'term-auto' | 'term-button'): void => {
    if (!composer) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.th-live-q__free')) return;
    if (why === 'term-button') {
      composer.focus();
      return;
    }
    if (document.querySelector(OPEN_LAYERS)) return;
    if (why === 'returned') {
      // Окно поверх чата закрылось либо человек вернулся на вкладку браузера: чат на экране —
      // фокус в поле ввода, откуда бы он ни вернулся (окно отдаёт его кнопке, что его открыла).
      const view = root.closest('.th-ws-view');
      if (!root.isConnected || (view && !view.classList.contains('is-active'))) return;
      if (document.visibilityState === 'hidden') return;
      composer.focus({ quiet: true });
      return;
    }
    if (active instanceof Element && active.closest('.th-feed__search')) return;
    if (why === 'shown') {
      // На телефоне — без самопоявления клавиатуры (ADR 0010): она выходит по касанию поля.
      composer.focus({ quiet: true });
      return;
    }
    // Окно свернулось само. На телефоне фокус не трогаем вовсе; иначе берём, только если
    // он был нигде или в самом окне терминала.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) return;
    const free = !active || active === document.body || active === document.documentElement;
    if (free || (active instanceof Element && active.closest('.th-chat-term'))) composer.focus();
  };
  const onTerminalClosed = (byButton: boolean): void => claimFocus(byButton ? 'term-button' : 'term-auto');
  // Закрытие любого окна поверх чата и возврат на вкладку — один путь. Фокус берётся
  // после того, как окно вернуло его своей кнопке и если поверх не осталось другого окна.
  let returnTimer = 0;
  const onReturned = (): void => {
    window.clearTimeout(returnTimer);
    returnTimer = window.setTimeout(() => claimFocus('returned'), 0);
  };
  const onVisible = (): void => {
    if (document.visibilityState !== 'hidden') onReturned();
  };
  const offOverlay = onOverlayClosed(onReturned);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onReturned);
  // Агента в панели нет — по опросу состояния, а не по ленте: её `live` отстаёт, и шапка
  // называла вышедшего агента работающим. Агент вернулся — всё оживает тем же опросом.
  let wasGone = false;
  const syncGone = (): void => {
    const gone = liveHandle?.absent() ?? false;
    feed.setAgentGone(gone);
    composer?.setDisabled(gone);
    goneEl.hidden = !gone || !!thread.querySelector('.th-chat__empty .th-chat__to-term');
    if (wasGone && !gone) claimFocus('returned');
    wasGone = gone;
  };
  let liveHandle: LiveHandle | null = null;
  const live = (liveHandle = mountLive({ ...slots, head: stateRow, stop: feed.stopSlot, onTerminalClosed }, session, transport, (state, changed) => {
    syncGone();
    feed.setStateShown(state !== null);
    // Пока агент работает, переписка дочитывается раз в секунду.
    feed.setBusy(state?.screen.kind === 'working');
    if (changed) feed.refresh();
  }));

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
    focusInput: () => claimFocus('shown'),
    teardown: () => {
      offOverlay();
      window.clearTimeout(returnTimer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onReturned);
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
