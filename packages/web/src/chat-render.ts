// Оформление сообщений чата поверх markdown.ts: кликабельные пути и кнопка копирования
// у блоков кода. Сам markdown.ts не трогаем — он общий с просмотром файлов; здесь
// пост-обработка готового DOM (узлы, не innerHTML).

import { t } from './i18n';
import { renderMarkdown } from './markdown';
import { filesHash, sfilesHash } from './routes';
import { resolveSessionPath } from './session-path';
import { detectPaths, filePathParts, parentRel } from './termlinks';
import type { Transport } from './transport';

/** Куда ведёт путь из текста. null — не открываем (вне корней, нет права `files`). */
export interface PathLinker {
  target(path: string): string | null;
}

/** Пунктуация, прилипшая к пути в прозе («см. /a/b.ts.»): к пути не относится. */
const TAIL = /[.,;:)\]]+$/;
/** Куда не заходим: готовые ссылки, блоки кода, кнопки. Инлайн-код — заходим. */
const SKIP = 'a, pre, button';

/** Линкует пути в текстовых узлах `root`. Повторный проход безопасен: пути внутри уже
 *  поставленной ссылки пропускаются. */
export function linkifyPaths(root: ParentNode, linker: PathLinker): void {
  // Ссылка markdown с локальным путём: название становится ссылкой, если путь открывается;
  // иначе остаётся названием (и станет ссылкой следующим проходом, когда приедут корни).
  for (const span of root.querySelectorAll<HTMLElement>('span.th-md__pathlink[data-path]')) {
    const target = linker.target(span.dataset.path ?? '');
    if (!target) continue;
    const a = document.createElement('a');
    a.className = 'th-path th-md__pathlink';
    a.href = target;
    a.append(...span.childNodes);
    span.replaceWith(a);
  }
  const texts: Text[] = [];
  const walker = document.createTreeWalker(root as Node, 4 /* SHOW_TEXT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text;
    if (node.parentElement?.closest(SKIP)) continue;
    texts.push(node);
  }
  for (const node of texts) {
    const text = node.data;
    const parts: Array<string | HTMLAnchorElement> = [];
    let at = 0;
    for (const m of detectPaths(text)) {
      const path = m.path.replace(TAIL, '');
      if (path.length < 2) continue;
      const target = linker.target(path);
      if (!target) continue;
      if (m.index > at) parts.push(text.slice(at, m.index));
      const a = document.createElement('a');
      a.className = 'th-path';
      a.href = target;
      a.textContent = path;
      parts.push(a);
      at = m.index + path.length;
    }
    if (parts.length === 0) continue;
    if (at < text.length) parts.push(text.slice(at));
    node.replaceWith(...parts);
  }
}

/** Кнопка «Копировать» для блока кода. Без буфера (небезопасный контекст) — молча. */
export function copyButtonFor(pre: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'th-md__copy';
  btn.textContent = t('chat.copy');
  btn.setAttribute('aria-label', t('chat.copy'));
  let timer = 0;
  btn.addEventListener('click', () => {
    const code = pre.querySelector('code')?.textContent ?? '';
    const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (!write) return;
    void write(code).then(
      () => {
        btn.textContent = t('chat.copied');
        window.clearTimeout(timer);
        timer = window.setTimeout(() => (btn.textContent = t('chat.copy')), 1500);
      },
      () => {},
    );
  });
  return btn;
}

/** Markdown сообщения агента для чата: оформление, кнопки копирования у кода, пути
 *  ссылками. Сбой разметки показывает текст как есть — одно битое сообщение не должно
 *  ронять остальные. */
export function renderChatMarkdown(text: string, linker: PathLinker | null): DocumentFragment {
  let frag: DocumentFragment;
  try {
    frag = renderMarkdown(text, { localLinks: true });
  } catch {
    frag = document.createDocumentFragment();
    const p = document.createElement('p');
    p.textContent = text;
    frag.append(p);
  }
  for (const pre of frag.querySelectorAll<HTMLElement>('pre.th-md__pre')) pre.append(copyButtonFor(pre));
  if (linker) linkifyPaths(frag, linker);
  return frag;
}

/** Линкер путей для сессии: корни проводника и каталог сессии грузятся один раз.
 *  Гостю без права `files` ссылки не нужны — `target` всегда null. `ready` закрывается,
 *  когда корни известны (или их не будет): тогда уже нарисованное можно перелинковать. */
export function createPathLinker(transport: Transport, session: string): PathLinker & { ready: Promise<void> } {
  let roots: string[] = [];
  let sessionRoot = '';
  let cwd = '';
  const scope = transport.clientScope;
  const allowed = !scope || scope.files;
  const ready = allowed
    ? Promise.all([transport.dirs(), resolveSessionPath(transport, session)]).then(
        ([groups, res]) => {
          roots = groups.map((g) => g.root);
          if (res) {
            sessionRoot = res.root;
            cwd = res.subpath ? `${res.root}/${res.subpath}` : res.root;
          }
        },
        () => {
          // Корней не узнали — пути остаются текстом, чат от этого не страдает.
        },
      )
    : Promise.resolve();
  return {
    ready,
    target(path) {
      if (!allowed) return null;
      const p = filePathParts(path, roots, cwd || undefined);
      if (!p) return null;
      return p.root === sessionRoot ? sfilesHash(session, p.rel) : filesHash(p.root, parentRel(p.rel));
    },
  };
}
