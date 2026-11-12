// «В терминале набрано»: текст, который человек начал писать в строке агента в терминале,
// виден над полем чата, пока само поле пусто. «Забрать в поле» — прежнее действие
// `take-input`: агент стирает свою строку и возвращает текст. Зрителю без права ввода
// строка видна без кнопки (поля у него нет).
import type { ActResult } from '@termhub/protocol/chat';

import type { LiveHandle } from './chat-live';
import { t } from './i18n';
import { toast } from './ui';

/** Поле чата глазами строки: пусто ли оно и как положить в него текст. */
export interface TypedField {
  text(): string;
  setText(text: string): void;
  focus(): void;
  /** Подписка на любую смену текста поля; возвращает отписку. */
  onText(fn: () => void): () => void;
}

export interface TypedDeps {
  live: Pick<LiveHandle, 'state' | 'act' | 'subscribe'>;
  /** null — зритель без права ввода. */
  field: TypedField | null;
}

/** Ставит строку перед `anchor` (местом поля ввода). */
export function mountTyped(anchor: HTMLElement, deps: TypedDeps): { el: HTMLElement; teardown(): void } {
  const { live, field } = deps;
  const el = document.createElement('div');
  el.className = 'th-typed';
  el.setAttribute('role', 'status');
  el.hidden = true;
  const label = document.createElement('span');
  label.className = 'th-typed__label';
  label.textContent = t('chat.typed.label');
  const text = document.createElement('span');
  text.className = 'th-typed__text';
  el.append(label, text);

  let disposed = false;
  let taking = false;
  let takeBtn: HTMLButtonElement | null = null;

  const sync = (): void => {
    if (disposed) return;
    const typed = live.state()?.screen.input ?? '';
    const show = typed !== '' && (field ? field.text() === '' : true);
    el.hidden = !show;
    if (show) {
      text.textContent = typed;
      text.title = typed;
    }
  };

  const take = async (): Promise<void> => {
    if (!field || taking || disposed) return;
    taking = true;
    if (takeBtn) takeBtn.disabled = true;
    try {
      let res: ActResult;
      try {
        res = await live.act({ kind: 'take-input' });
      } catch {
        toast(t('chat.composer.noConnection'), 'error');
        return;
      }
      if (disposed) return;
      if (!res.ok) {
        toast(res.reason === 'busy' ? t('chat.composer.busy') : res.detail || t('chat.composer.failed'), 'error');
        return;
      }
      // Пока шёл запрос, человек мог начать писать сам — его текст остаётся следом.
      field.setText([res.taken ?? '', field.text()].filter(Boolean).join('\n'));
      field.focus();
    } finally {
      taking = false;
      if (takeBtn) takeBtn.disabled = false;
      sync();
    }
  };

  if (field) {
    takeBtn = document.createElement('button');
    takeBtn.type = 'button';
    takeBtn.className = 'th-typed__take';
    takeBtn.textContent = t('chat.composer.take');
    takeBtn.addEventListener('click', () => void take());
    el.append(takeBtn);
  }

  anchor.before(el);
  const offLive = live.subscribe(() => sync());
  const offText = field?.onText(sync);
  sync();

  return {
    el,
    teardown: () => {
      disposed = true;
      offLive();
      offText?.();
      el.remove();
    },
  };
}
