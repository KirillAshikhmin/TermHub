// Раскрытие действия агента в чате. Строка «инструмент: аргумент» по тапу показывает
// команду и вывод, а у правки — diff с цветом строк. Подробности грузятся отдельным
// запросом по первому раскрытию (страница ленты остаётся лёгкой) и держатся в памяти,
// пока действие не закончено: незавершённое перезапрашивается при каждом раскрытии.
// Всё, что пришло из чужого транскрипта, рисуется текстом — не разметкой.

import { ansiNodes, highlightShell, isShellTool, paintMark } from './chat-color';
import { t } from './i18n';
import type { DetailResult, FeedEntry } from './transport';

type Detail = Extract<DetailResult, { ok: true }>;

export interface ToolDetailHandle {
  expanded(): boolean;
  toggle(): void;
  /** Тихо перечитать подробности идущего действия: метка строки догоняет результат без
   *  раскрытия, раскрытая панель перерисовывается. `true` — действие закончилось. */
  recheck(): Promise<boolean>;
}

const div = (cls: string, text?: string): HTMLDivElement => {
  const el = document.createElement('div');
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
};

/** Блок diff: файл за файлом, у строки знак отдельно от текста (знак не копируется). */
export function renderDiff(detail: Pick<Detail, 'diff'>): HTMLElement {
  const root = div('th-diff');
  for (const file of detail.diff ?? []) {
    const box = div('th-diff__file');
    box.append(div('th-diff__path', file.path));
    for (const line of file.lines) {
      const row = div(`th-diff__line ${line.t === '+' ? 'is-add' : line.t === '-' ? 'is-del' : 'is-ctx'}`);
      row.append(div('th-diff__sign', line.t), div('th-diff__text', line.s));
      box.append(row);
    }
    root.append(box);
  }
  return root;
}

function renderDetail(detail: Detail, shell: boolean): HTMLElement[] {
  const out: HTMLElement[] = [];
  // Веха сжатия Codex: сохранённые сообщения, свои и агента различимы подписью и плашкой.
  for (const m of detail.messages ?? []) {
    const box = div(`th-kept th-kept--${m.role}`);
    box.append(div('th-kept__who', m.role === 'human' ? t('feed.you') : t('feed.kind.agent')), div('th-kept__text', m.text));
    out.push(box);
  }
  if (detail.input) {
    out.push(div('th-tool__label', t('chat.tool.input')));
    const pre = document.createElement('pre');
    pre.className = 'th-tool__input';
    pre.textContent = detail.input;
    // Команда оболочки — подсветкой синтаксиса; сбой подсветки оставляет простой текст.
    if (shell) void highlightShell(pre, detail.input);
    out.push(pre);
  }
  if (detail.diff && detail.diff.length > 0) out.push(renderDiff(detail));
  if (detail.output !== undefined && detail.output !== '') {
    out.push(div('th-tool__label', t('chat.tool.output')));
    const pre = document.createElement('pre');
    pre.className = 'th-tool__output';
    // Цвета ANSI — узлами; нет последовательностей — тот же текстовый узел, что был.
    pre.append(ansiNodes(detail.output));
    out.push(pre);
  }
  if (detail.truncated) out.push(div('th-tool__truncated', t('chat.tool.truncated')));
  if (detail.pending) out.push(div('th-tool__pending', t('chat.tool.running')));
  else if (out.length === 0) out.push(div('th-tool__none', t('chat.tool.noResult')));
  return out;
}

/** Делает строку действия раскрываемой. `load` — запрос подробностей (чаще всего
 *  `transport.feedDetail(session, entry.cursor)`); зовётся при раскрытии, не при монтаже. */
export function mountToolDetail(row: HTMLElement, entry: FeedEntry, load: () => Promise<DetailResult>): ToolDetailHandle {
  const head = div('th-tool__head');
  head.append(...row.childNodes);
  head.setAttribute('role', 'button');
  head.tabIndex = 0;
  head.setAttribute('aria-expanded', 'false');
  head.title = t('chat.tool.expand');
  const panel = div('th-tool__panel');
  panel.hidden = true;
  row.classList.add('is-expandable');
  row.append(head, panel);
  const shell = isShellTool(entry.tool);

  let open = false;
  let loaded: Detail | null = null;
  let gen = 0;

  const showError = (res: { reason?: string } | null): void => {
    const gone = res?.reason === 'cursor-stale';
    const box = div('th-tool__error', gone ? t('chat.tool.gone') : t('chat.tool.error'));
    if (!gone) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'th-btn th-btn--sm th-tool__retry';
      retry.textContent = t('chat.tool.retry');
      retry.addEventListener('click', (e) => {
        e.stopPropagation();
        void fetchDetail();
      });
      box.append(retry);
    }
    panel.replaceChildren(box);
  };

  const fetchDetail = async (): Promise<void> => {
    const my = (gen += 1);
    panel.replaceChildren(div('th-tool__loading', t('chat.tool.loading')));
    let res: DetailResult | null = null;
    try {
      res = await load();
    } catch {
      res = null;
    }
    if (my !== gen) return;
    if (!res || !res.ok) {
      showError(res);
      return;
    }
    apply(res);
  };
  const apply = (res: Detail): void => {
    // Идущее действие не запоминаем: к следующему раскрытию оно могло закончиться.
    loaded = res.pending ? null : res;
    // Метка строки догоняет факт: на странице действие могло быть ещё «выполняется».
    const mark = head.querySelector<HTMLElement>('.th-tool__mark');
    if (mark) paintMark(mark, res.pending ? { state: 'running' } : (res.result ?? { state: 'done' }));
    panel.replaceChildren(...renderDetail(res, shell));
  };
  const recheck = async (): Promise<boolean> => {
    const my = gen;
    let res: DetailResult | null = null;
    try {
      res = await load();
    } catch {
      res = null;
    }
    // Сбой и раскрытие, начатое за это время, тихую проверку отменяют: экран не трогаем.
    if (!res || !res.ok || my !== gen) return false;
    apply(res);
    return !res.pending;
  };

  const set = (next: boolean): void => {
    open = next;
    panel.hidden = !open;
    head.setAttribute('aria-expanded', String(open));
    head.title = open ? t('chat.tool.collapse') : t('chat.tool.expand');
    row.classList.toggle('is-open', open);
    if (open && !loaded) void fetchDetail();
  };
  const toggle = (): void => set(!open);
  head.addEventListener('click', (e) => {
    // Путь внутри строки ведёт в проводник — раскрывать из-за него нечего.
    if ((e.target as Element | null)?.closest?.('a')) return;
    toggle();
  });
  head.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
  return { expanded: () => open, toggle, recheck };
}
