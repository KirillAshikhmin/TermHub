// Окошко живого терминала в чате: экран агента, которого чат не узнал (меню, новый вид
// вопроса, чужое приложение). Тот же терминал, что на вкладке, но зрителем размера
// (`passive`): окно tmux чат не меняет. Создаётся лениво, по первому показу, а на
// сворачивании снимается совсем — лишний клиент tmux на сессию не держим.
//
// Это отдельное окно поверх области чата (якорь — `.th-chat`, не окно браузера): своя
// шапка с названием, причиной открытия и кнопкой закрытия. Не модальное. Esc окно не
// закрывает — это клавиша агенту, и уходит она в панель.
import { t } from './i18n';
import type { Transport } from './transport';

export interface ChatTermHandle {
  /** Корень окошка (место `terminal` оболочки). */
  el: HTMLElement;
  show(): void;
  hide(): void;
  visible(): boolean;
  /** Почему окно открыто — строкой в шапке; пустая строка её прячет. */
  setReason(text: string): void;
  teardown(): void;
}

export interface ChatTermOptions {
  /** Окно закрыто его собственной кнопкой (окно уже спрятано, терминал снят). */
  onClose?: () => void;
}

export function mountChatTerm(host: HTMLElement, session: string, transport: Transport, opts: ChatTermOptions = {}): ChatTermHandle {
  const el = document.createElement('div');
  el.className = 'th-chat-term';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', t('chat.term.title'));
  el.hidden = true;

  const head = document.createElement('div');
  head.className = 'th-chat-term__head';
  const title = document.createElement('span');
  title.className = 'th-chat-term__title';
  title.textContent = `${t('chat.term.title')} · ${session}`;
  const why = document.createElement('span');
  why.className = 'th-chat-term__why';
  why.hidden = true;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'th-chat-term__close';
  close.textContent = '×';
  close.setAttribute('aria-label', t('chat.term.close'));
  close.title = t('chat.term.close');
  head.append(title, why, close);
  const body = document.createElement('div');
  body.className = 'th-chat-term__body';
  el.append(head, body);
  host.append(el);

  let teardownTerm: (() => void) | null = null;
  let shown = false;
  let disposed = false;
  /** Номер показа: быстрый показ-скрытие-показ не должен смонтировать терминал дважды. */
  let epoch = 0;

  const show = (): void => {
    if (disposed || shown) return;
    shown = true;
    el.hidden = false;
    const mine = ++epoch;
    void import('./term').then(({ mountTerminal }) => {
      if (disposed || !shown || mine !== epoch) return;
      teardownTerm = mountTerminal(body, session, transport, { embedded: true, passive: true }).teardown;
    });
  };
  const hide = (): void => {
    if (!shown) return;
    shown = false;
    epoch += 1;
    el.hidden = true;
    teardownTerm?.();
    teardownTerm = null;
    body.replaceChildren();
  };
  close.addEventListener('click', () => {
    hide();
    opts.onClose?.();
  });

  return {
    el,
    show,
    hide,
    visible: () => shown,
    setReason: (text) => {
      why.textContent = text;
      why.title = text;
      why.hidden = text === '';
    },
    teardown: () => {
      hide();
      disposed = true;
      el.remove();
    },
  };
}
