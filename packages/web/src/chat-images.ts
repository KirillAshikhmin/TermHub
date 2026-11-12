// Миниатюры картинок в чате: путь к файлу-картинке в сообщении агента или человека
// показывается под сообщением миниатюрой, по нажатию — окном просмотра поверх области чата.
//
// Что можно отдать, решает агент (каталоги после realpath, растр по содержимому, 20 МиБ) —
// здесь только выбор путей-кандидатов и показ. Путь из сообщения — данные: в DOM он идёт
// текстом (`textContent`, `alt`), картинка — адресом объекта Blob; `innerHTML` нет.
// Неудача молчит: сообщение остаётся текстом. Отказ агента запоминается (тот же путь второй
// раз не запрашивается), сбой связи — нет: при возврате связи путь спрашивается снова.

import { t } from './i18n';
import { detectPaths } from './termlinks';
import type { Transport } from './transport';

/** Типы, которые показываем. SVG здесь нет намеренно: это документ, а не растр. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp)$/i;
/** Пунктуация, прилипшая к пути в прозе («см. /a/b.png.»). */
const TAIL = /[.,;:)\]]+$/;
/** Больше картинок из одного сообщения не берём: ряд миниатюр, а не галерея. */
const MAX_PER_MESSAGE = 12;

/** Абсолютные пути файлов-картинок в тексте сообщения, в порядке текста, без повторов.
 *  Относительные пути и пути от `~` не берём: агент принимает только абсолютный путь, а
 *  гадать каталог за него нельзя. */
export function imagePathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of detectPaths(text)) {
    if (!m.path.startsWith('/')) continue;
    // «~/pics/a.png» находится как «/pics/a.png» — это не тот путь.
    if (text[m.index - 1] === '~') continue;
    // Путь обрывается на первом знаке не из пути; продолжение («.zip», «?x=1») значит, что
    // найденное — не имя файла целиком.
    const path = m.path.replace(TAIL, '');
    if (!IMAGE_EXT.test(path) || /[\w]/.test(text[m.index + m.path.length] ?? '')) continue;
    if (out.includes(path)) continue;
    out.push(path);
    if (out.length === MAX_PER_MESSAGE) break;
  }
  return out;
}

export interface ChatImages {
  /** Найти картинки в тексте сообщения и показать их под ним, когда оно попадёт на экран. */
  attach(box: HTMLElement, text: string): void;
  /** Связь вернулась: заново спросить миниатюры, не загруженные из-за сбоя связи. */
  retry(): void;
  teardown(): void;
}

/** Сбой связи, а не отказ агента: запрос не дошёл или ответа не дождались (LAN — статус 0
 *  и 5xx перезапускающегося агента, relay — нет потока или вышел срок). */
function isConnectionFailure(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 0 || status >= 500;
  const message = e instanceof Error ? e.message : '';
  return /not streaming|timeout|network|failed to fetch|load failed/i.test(message);
}

/** Исход загрузки, который в кэш не ложится. */
const LOST = Symbol('lost');

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Миниатюры одной сессии. `host` — область чата (`.th-chat`): окно просмотра встаёт в её
 *  границах, а не поверх всего окна браузера. */
export function createChatImages(host: HTMLElement, session: string, transport: Transport): ChatImages {
  const scope = transport.clientScope;
  const allowed = !scope || scope.files;
  /** Путь → адрес объекта или null (отказ). Отказ запоминается: повторного запроса нет. */
  const cache = new Map<string, Promise<string | null>>();
  const urls: string[] = [];
  const waiting = new Map<Element, { box: HTMLElement; paths: string[] }>();
  let disposed = false;
  /** Запросы идут по одному: через relay картинка едет кусками, и десяток параллельных
   *  загрузок занял бы канал, по которому идёт сам чат. */
  let chain: Promise<unknown> = Promise.resolve();

  /** Сообщения, чьи миниатюры не пришли из-за сбоя связи: ждут её возврата. */
  const lost = new Map<HTMLElement, string[]>();
  const load = (path: string): Promise<string | null | typeof LOST> => {
    const known = cache.get(path);
    if (known) return known;
    const job: Promise<string | null | typeof LOST> = chain.then(async () => {
      if (disposed) return null;
      try {
        const blob = await transport.image(session, path);
        if (disposed || !IMAGE_TYPES.has(blob.type) || blob.size === 0) return null;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        return url;
      } catch (e) {
        return isConnectionFailure(e) ? LOST : null;
      }
    });
    chain = job;
    const kept = job.then((res) => {
      // Сбой связи отказом не становится: следующий запрос того же пути пойдёт в сеть.
      if (res === LOST && cache.get(path) === kept) cache.delete(path);
      return res === LOST ? null : res;
    });
    cache.set(path, kept);
    return job;
  };

  // ── Окно просмотра ──────────────────────────────────────────────────
  let view: { el: HTMLElement; img: HTMLImageElement; title: HTMLElement; from: HTMLElement | null } | null = null;
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !view) return;
    // Esc закрывает окно и дальше не идёт: под окном его слушают чат и терминал.
    e.preventDefault();
    e.stopPropagation();
    closeView();
  };
  const closeView = (): void => {
    if (!view) return;
    document.removeEventListener('keydown', onKey, true);
    view.el.remove();
    const from = view.from;
    view = null;
    if (from?.isConnected) from.focus();
  };
  const openView = (path: string, url: string, from: HTMLElement): void => {
    if (!view) {
      const el = document.createElement('div');
      el.className = 'th-imgview';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-label', t('chat.image.title'));
      const head = document.createElement('div');
      head.className = 'th-imgview__head';
      const title = document.createElement('span');
      title.className = 'th-imgview__title';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'th-imgview__close';
      close.textContent = '×';
      close.setAttribute('aria-label', t('chat.image.close'));
      close.title = t('chat.image.close');
      close.addEventListener('click', closeView);
      head.append(title, close);
      const body = document.createElement('div');
      body.className = 'th-imgview__body';
      const img = document.createElement('img');
      img.className = 'th-imgview__img';
      body.append(img);
      // Нажатие мимо картинки закрывает окно, по самой картинке — нет.
      body.addEventListener('click', (e) => {
        if (e.target === body) closeView();
      });
      el.append(head, body);
      host.append(el);
      document.addEventListener('keydown', onKey, true);
      view = { el, img, title, from };
      close.focus();
    }
    view.from = from;
    view.img.src = url;
    view.img.alt = baseName(path);
    view.title.textContent = baseName(path);
    view.title.title = path;
  };

  // ── Миниатюры ───────────────────────────────────────────────────────
  const thumb = (path: string, url: string): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'th-chatimg';
    btn.setAttribute('aria-label', t('chat.image.open'));
    btn.title = path;
    const img = document.createElement('img');
    img.alt = baseName(path);
    img.decoding = 'async';
    img.src = url;
    // Файл оказался битым — миниатюры нет, сообщение остаётся текстом.
    img.addEventListener('error', () => {
      const row = btn.parentElement;
      btn.remove();
      if (row && row.childElementCount === 0) row.remove();
    });
    btn.append(img);
    btn.addEventListener('click', () => openView(path, url, btn));
    return btn;
  };

  const fill = async (box: HTMLElement, paths: string[]): Promise<void> => {
    let row = box.querySelector<HTMLElement>(':scope > .th-chatimgs');
    const missed: string[] = [];
    // По порядку текста: следующая миниатюра ждёт предыдущую.
    for (const path of paths) {
      const url = await load(path);
      if (disposed) return;
      if (url === LOST) {
        missed.push(path);
        continue;
      }
      if (!url) continue;
      if (!row) {
        row = document.createElement('div');
        row.className = 'th-chatimgs';
        box.append(row);
      }
      row.append(thumb(path, url));
    }
    if (missed.length) lost.set(box, missed);
  };

  const observer =
    allowed && typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const item = waiting.get(entry.target);
            if (!item) continue;
            waiting.delete(entry.target);
            observer?.unobserve(entry.target);
            void fill(item.box, item.paths);
          }
        })
      : null;

  return {
    attach(box, text) {
      if (!allowed || disposed) return;
      const paths = imagePathsIn(text);
      if (paths.length === 0) return;
      // Без наблюдателя (старый браузер) грузим сразу — картинка важнее экономии.
      if (!observer) {
        void fill(box, paths);
        return;
      }
      waiting.set(box, { box, paths });
      observer.observe(box);
    },
    retry() {
      if (disposed) return;
      const again = [...lost];
      lost.clear();
      for (const [box, paths] of again) if (box.isConnected) void fill(box, paths);
    },
    teardown() {
      disposed = true;
      lost.clear();
      observer?.disconnect();
      waiting.clear();
      closeView();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
      cache.clear();
    },
  };
}
