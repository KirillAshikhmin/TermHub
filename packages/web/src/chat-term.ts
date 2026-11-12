// Окошко живого терминала в чате: экран агента, которого чат не узнал (меню, новый вид
// вопроса, чужое приложение). Тот же терминал, что на вкладке, но зрителем размера
// (`passive`): окно tmux чат не меняет. Создаётся лениво, по первому показу, а на
// сворачивании снимается совсем — лишний клиент tmux на сессию не держим.
import type { Transport } from './transport';

export interface ChatTermHandle {
  /** Корень окошка (место `terminal` оболочки). */
  el: HTMLElement;
  show(): void;
  hide(): void;
  visible(): boolean;
  teardown(): void;
}

export function mountChatTerm(host: HTMLElement, session: string, transport: Transport): ChatTermHandle {
  const el = document.createElement('div');
  el.className = 'th-chat-term';
  el.hidden = true;
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
      teardownTerm = mountTerminal(el, session, transport, { embedded: true, passive: true }).teardown;
    });
  };
  const hide = (): void => {
    if (!shown) return;
    shown = false;
    epoch += 1;
    el.hidden = true;
    teardownTerm?.();
    teardownTerm = null;
    el.replaceChildren();
  };

  return {
    el,
    show,
    hide,
    visible: () => shown,
    teardown: () => {
      hide();
      disposed = true;
      el.remove();
    },
  };
}
