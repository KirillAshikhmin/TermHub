// Экран ленты сессии — пятая вкладка рабочего пространства. Показывает беседу
// целиком: реплики человека и агента полным текстом, вызовы инструментов — строчкой
// мелким шрифтом, мышление скрыто за тумблером (у Codex оно всегда пустое, поэтому
// прятать его по умолчанию — единственный честный вариант).
//
// Сверху — поиск: сначала по загруженному в память, мгновенно и без сети; не нашлось —
// дочитывает беседу назад страницами, считая просмотренные записи. Находка переносит
// ленту к своему месту (`around`) и подсвечивает запись.
//
// Открывается на хвосте, подтягивает предыдущие при листании вверх и прирастает
// новыми, пока агент работает. Два правила, на которых легко обжечься:
//   • край беседы — `bof`/`eof`, а НЕ пустой список записей: страница бывает пустой
//     на шаге через строку, не влезшую в окно ответа;
//   • страница бывает короче запрошенного лимита, не достигнув края.
// Транспорт (LAN/relay) экрану не виден: он зовёт transport.feed() и читает значение.

import { renderChatMarkdown, linkifyPaths, type PathLinker } from './chat-render';
import { createMark, highlightShell, isShellTool } from './chat-color';
import { mountToolDetail } from './chat-tool';
import { openCreateModal } from './dashboard';
import { formatDate } from './format';
import { t } from './i18n';
import { renderMarkdown } from './markdown';
import { sfeedHash } from './routes';
import { mountSessionBar } from './tabs';
import type { FeedEntry, FeedOptions, FeedPage, FeedResult, Transport } from './transport';
import { errorScreen, iconButton, renderHoloBar, svgIcon, wireToolbar } from './ui';
import { allTokens, formatDuration, formatElapsed, formatTokens, sessionUsage } from './usage';
import { whenCap } from './capabilities';

/** Размер страницы: хвост открывается быстро, листание тянет такими же кусками. */
const LIMIT = 100;
/** Период приращения — тот же, что и у опроса сессий. */
const POLL_MS = 3000;
/** Период приращения, пока агент работает (чат знает это с экрана панели). */
const FAST_POLL_MS = 1000;
/** Насколько близко к верху надо подлистать, чтобы начать тянуть предыдущие. */
const NEAR_TOP = 200;
/** «Внизу» — не дальше двух-трёх строк от конца: палец, остановившийся почти у края,
 *  ещё считается внизу, и приращение к нему прилипает. */
const NEAR_BOTTOM = 100;
/** Сколько держится подсветка записи, к которой перенесли ленту. */
const HIGHLIGHT_MS = 2000;
/** Сколько страниц назад дочитывает один заход поиска, не нашедшего ничего. */
const SEARCH_PAGES = 20;
/** Длина строки вокруг совпадения в находке. */
const SNIPPET = 120;
/** Пауза в наборе, после которой поиск лезет за пределы загруженного: слово
 *  набирают по букве, а дочитывание — дело сетевое. */
const SEARCH_IDLE_MS = 300;
/** Показывать ли мышление (выбор держится между открытиями). */
const THINKING_KEY = 'termhub.feedThinking';
/** Скрыты ли действия: ключ старше тумблера «Показать действия» и хранит прежний смысл —
 *  выбор, сделанный до переворота, не теряется. */
const HIDE_ACTIONS_KEY = 'termhub.feedHideActions';
/** Открыто ли поле поиска по беседе в чате (кнопка шапки переписки). */
const SEARCH_KEY = 'termhub.feedSearch';

/** Экран ленты для роутера и для поиска (таск поиска дописывает свой вид в searchSlot). */
export interface FeedHandle {
  /** Корень экрана (полоса сессий и Holo-бар — его соседи в host). */
  el: HTMLElement;
  /** Полоса поиска над списком: поле, строка о ходе и находки. */
  searchSlot: HTMLElement;
  /** Снимок загруженных записей, от ранней к поздней. */
  entries(): FeedEntry[];
  /** Дочитать страницу назад. true — страница дочитана и начало ещё впереди,
   *  false — начало беседы достигнуто. null — экрана больше нет: ответа о беседе
   *  не существует, и принимать его за край нельзя. */
  loadOlder(): Promise<boolean | null>;
  /** Перенести ленту к записи по её курсору и подсветить. */
  jumpTo(cursor: string): Promise<void>;
  /** Запросить приращение сейчас, не дожидаясь опроса (чат зовёт на смену состояния агента). */
  refresh(): void;
  /** Отправленное сообщение, которого в транскрипте ещё нет: стоит в конце переписки
   *  с пометкой и исчезает, когда агент запишет реплику с тем же текстом (поле ввода чата). */
  addLocal(text: string, state?: LocalState): LocalMessage;
  /** Место в строке шапки переписки под состояние агента с экрана (слово состояния, время,
   *  «Стоп») — его наполняет живая часть чата. В ленте без чата не в разметке. */
  stateSlot: HTMLElement;
  /** Место в ряду кнопок шапки сразу после поиска — под «Стоп» живой части. */
  stopSlot: HTMLElement;
  /** Состояние агента показано в `stateSlot`: своя подпись «Агент работает» тогда лишняя. */
  setStateShown(on: boolean): void;
  /** Агент сейчас работает: приращение просится раз в секунду, а не раз в три. Условия
   *  опроса те же — вкладка активна, страница видима, очередь запросов пуста. */
  setBusy(on: boolean): void;
  teardown(): void;
}

export type LocalState = 'sending' | 'queued' | 'failed';
export interface LocalAction {
  label: string;
  run(): void;
}
export interface LocalMessage {
  /** Сменить пометку. `delivered` — агент принял запрос, ждём записи транскрипта.
   *  После `remove` не делает ничего. */
  set(state: LocalState, opts?: { note?: string; actions?: LocalAction[]; delivered?: boolean }): void;
  remove(): void;
}

/** Находка поиска: запись, к которой переносят ленту, и строка вокруг совпадения. */
export interface FeedHit {
  entry: FeedEntry;
  /** Точка прыжка. Отсутствует у вехи склейки — она не привязана к строке ни
   *  одного из сшитых файлов транскрипта; текст при этом всё равно найден. */
  cursor?: string;
  /** Строка текста с совпадением; длинная — окном вокруг него, края с многоточием. */
  snippet: string;
}

/** Строка вокруг совпадения: сначала своя строка текста, потом окно по её краям. */
function snippetAt(text: string, at: number, len: number): string {
  const from = text.lastIndexOf('\n', at) + 1;
  const end = text.indexOf('\n', at + len);
  const line = text.slice(from, end < 0 ? text.length : end);
  if (line.length <= SNIPPET) return line.trim();
  const start = Math.max(0, at - from - Math.floor((SNIPPET - len) / 2));
  const head = start > 0 ? '…' : '';
  const tail = start + SNIPPET < line.length ? '…' : '';
  return `${head}${line.slice(start, start + SNIPPET).trim()}${tail}`;
}

/** Поиск по загруженным записям: подстрока без учёта регистра, ничего умнее.
 *  Чистая функция над снимком ленты — своего состояния поиск не держит.
 *  Порядок находок — ленты: от ранней к поздней. */
export function searchFeed(entries: FeedEntry[], query: string): FeedHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const hits: FeedHit[] = [];
  for (const entry of entries) {
    const at = entry.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    // Курсор передаём как есть: у вехи склейки его нет (не привязана к строке ни
    // одного из сшитых файлов), но текст найден — и хит показывает его.
    hits.push({ entry, cursor: entry.cursor, snippet: snippetAt(entry.text, at, needle.length) });
  }
  return hits;
}

function readThinking(): boolean {
  try {
    return localStorage.getItem(THINKING_KEY) === '1';
  } catch {
    return false;
  }
}

function writeThinking(on: boolean): void {
  try {
    localStorage.setItem(THINKING_KEY, on ? '1' : '0');
  } catch {
    // Персист необязателен — выбор проживёт хотя бы это открытие.
  }
}

/** Слова на отказ агента. `cursor-stale` сюда не попадает: он лечится сам (см. ask). */
function failureText(res: { reason: string; detail: string }): string {
  if (res.reason === 'no-agent') return t('feed.fail.noAgent');
  if (res.reason === 'no-transcript') return t('feed.fail.noTranscript');
  if (res.reason === 'unknown-format') return t('feed.fail.unknownFormat');
  if (res.reason === 'forbidden') return t('feed.fail.forbidden');
  const base = t('feed.fail.lookupFailed');
  return res.detail ? `${base}: ${res.detail}` : base;
}

/** Режим «переписка внутри чата»: каркас сессии (полоса сессий, Holo-бар) держит чат,
 *  а лента даёт только список — с оформлением, раскрытием действий и ссылками. */
export interface FeedChatOptions {
  /** Куда вести пути из текста; `ready` закрывается, когда корни известны. */
  linker: PathLinker & { ready: Promise<void> };
  /** Связь с агентом пропала (`false`) или вернулась (`true`): переписка остаётся на экране. */
  onConnection?: (ok: boolean) => void;
  /** Пустой экран без беседы: узел вместо строки ошибки (приглашение написать запрос,
   *  «агент не запущен»). null — оставить обычный отказ. */
  emptyState?: (reason: 'no-transcript' | 'no-agent') => HTMLElement | null;
  /** Миниатюры картинок под сообщениями человека и агента (`chat-images.ts`). */
  images?: { attach(box: HTMLElement, text: string): void };
}

/** Монтирует ленту сессии в host. */
export function mountFeed(host: HTMLElement, session: string, transport: Transport, chat?: FeedChatOptions): FeedHandle {
  host.replaceChildren();

  // ── Каркас: полоса сессий + Holo-бар + тело вкладки ──────────────────
  const sbar = chat
    ? null
    : mountSessionBar({
        transport,
        current: session,
        onSwitch: (name) => (location.hash = sfeedHash(name)),
        onCreate: () => openCreateModal(transport),
      });
  let hideBar = (): void => {};
  const toolbar = document.createElement('div');
  toolbar.className = 'th-holowrap th-slide th-slide--top';
  if (!chat) toolbar.append(renderHoloBar({ active: 'feed', session, transport, onHide: () => hideBar() }));

  const main = document.createElement('main');
  main.className = chat ? 'th-feed th-feed--chat' : 'th-feed';

  // ── Шапка: чья беседа, работает ли агент, тумблер мышления ───────────
  const head = document.createElement('div');
  head.className = 'th-feed__head';
  const agentEl = document.createElement('span');
  agentEl.className = 'th-feed__agent';
  const liveEl = document.createElement('span');
  liveEl.className = 'th-feed__live';
  liveEl.setAttribute('role', 'status');
  liveEl.textContent = t('feed.live');
  liveEl.hidden = true;
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'th-feed__toggle-wrap';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.className = 'th-feed__toggle';
  toggle.checked = readThinking();
  const toggleText = document.createElement('span');
  toggleText.textContent = t('feed.showThinking');
  toggleWrap.title = t('feed.thinkingHelp');
  toggleWrap.append(toggle, toggleText);
  const actionsWrap = document.createElement('label');
  actionsWrap.className = 'th-feed__toggle-wrap';
  const actionsToggle = document.createElement('input');
  actionsToggle.type = 'checkbox';
  actionsToggle.className = 'th-feed__show-actions';
  actionsToggle.checked = true;
  try { actionsToggle.checked = localStorage.getItem(HIDE_ACTIONS_KEY) !== '1'; } catch { /* необязательная настройка */ }
  actionsWrap.append(actionsToggle, document.createTextNode(t('feed.showActions')));
  // Расход этой сессии: время работы и токены за сегодня, в подсказке — за всю беседу.
  const usageEl = document.createElement('span');
  usageEl.className = 'th-feed__usage';
  usageEl.hidden = true;
  const stateSlot = document.createElement('span');
  stateSlot.className = 'th-feed__state';
  const stopSlot = document.createElement('span');
  stopSlot.className = 'th-feed__stop';
  let stateShown = false;
  // В чате вместо чекбоксов с подписями — три кнопки-иконки, как кнопки шапки приложения:
  // поиск по беседе, рассуждения, действия. Чекбоксы остаются носителями состояния (их
  // слушают те же обработчики), но в разметку не идут.
  const headButton = (name: 'search' | 'thinking' | 'actions', icon: string, onClick: () => void): HTMLButtonElement => {
    const b = iconButton(icon, t(`feed.toggle.${name}`), onClick);
    b.classList.add('th-feed__tool');
    b.dataset.toggle = name;
    return b;
  };
  const press = (b: HTMLButtonElement, on: boolean): void => {
    b.setAttribute('aria-pressed', String(on));
    b.classList.toggle('is-on', on);
  };
  const flip = (box: HTMLInputElement): void => {
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change'));
  };
  let searchOn = true;
  if (chat) {
    try { searchOn = localStorage.getItem(SEARCH_KEY) === '1'; } catch { searchOn = false; }
  }
  const searchBtn = headButton('search', 'search', () => setSearch(!searchOn, true));
  const thinkingBtn = headButton('thinking', 'bulb', () => flip(toggle));
  const actionsBtn = headButton('actions', 'bolt', () => flip(actionsToggle));
  const paintButtons = (): void => {
    press(searchBtn, searchOn);
    press(thinkingBtn, toggle.checked);
    press(actionsBtn, actionsToggle.checked);
  };
  if (chat) {
    const tools = document.createElement('span');
    tools.className = 'th-feed__tools';
    tools.append(searchBtn, stopSlot, thinkingBtn, actionsBtn);
    head.append(agentEl, stateSlot, liveEl, usageEl, tools);
    paintButtons();
  } else head.append(agentEl, liveEl, usageEl, toggleWrap, actionsWrap);

  // Полоса поиска — над списком и под шапкой (наполняется ниже, когда есть чем
  // листать назад: поиску нужны loadOlder и jumpTo).
  const searchSlot = document.createElement('div');
  searchSlot.className = 'th-feed__search';
  searchSlot.hidden = !searchOn;

  // ── Список: край сверху, записи, отказ и счёт пропусков снизу ────────
  const listEl = document.createElement('div');
  listEl.className = 'th-feed__list';
  const edgeEl = document.createElement('div');
  edgeEl.className = 'th-feed__edge';
  edgeEl.hidden = true;
  const itemsEl = document.createElement('div');
  itemsEl.className = 'th-feed__items';
  const noticeEl = document.createElement('div');
  noticeEl.className = 'th-feed__notice';
  noticeEl.setAttribute('role', 'status');
  noticeEl.hidden = true;
  const tailEl = document.createElement('div');
  tailEl.className = 'th-feed__edge th-feed__edge--tail';
  tailEl.hidden = true;
  const skippedEl = document.createElement('div');
  skippedEl.className = 'th-feed__skipped';
  skippedEl.hidden = true;
  // Локальные записи (отправленное, но ещё не записанное агентом) — сразу за перепиской.
  const localEl = document.createElement('div');
  localEl.className = 'th-feed__local-list';
  listEl.append(edgeEl, itemsEl, localEl, tailEl, noticeEl, skippedEl);

  // Кнопка «вниз»: уйдя листать историю, вернуться к концу беседы больше нечем.
  // У конца её нет — там она только закрывала бы последнюю запись.
  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'th-fab th-feed__fab';
  fab.setAttribute('aria-label', chat ? t('chat.toLast') : t('feed.toBottom'));
  fab.title = chat ? t('chat.toLast') : t('feed.toBottom');
  fab.append(svgIcon('down'));
  fab.hidden = true;
  main.append(head, searchSlot, listEl, fab);
  if (sbar) {
    host.append(sbar.el, toolbar, main);
    hideBar = wireToolbar({ toolbars: [toolbar], floatMount: main, toggleMount: sbar.toggleSlot }).hide;
  } else host.append(main);

  // ── Состояние окна ленты ─────────────────────────────────────────────
  let items: FeedEntry[] = [];
  let seen = new Set<string>();
  let agent: 'claude' | 'codex' | 'opencode' = 'claude';
  // До первой страницы чья это беседа неизвестно — значка нет, а не «Claude» наугад.
  let agentKnown = false;
  let headCursor = '';
  let tailCursor = '';
  let bof = false;
  // Достигнут ли конец беседы загруженным окном: после прыжка к находке — нет.
  let eof = false;
  let complete = true;
  let live = false;
  let skipped = 0;
  let showThinking = toggle.checked;
  let showActions = actionsToggle.checked;
  // Устаревший курсор лечится молча — но ровно один раз на действие.
  let staleRetried = false;
  let disposed = false;
  let highlightTimer = 0;
  // Последний запрос не дошёл (обрыв связи): в чате опрос продолжается и без `live`,
  // чтобы состояние обновилось само, как только связь вернётся.
  let offline = false;

  const nearBottom = (): boolean => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= NEAR_BOTTOM;
  const paintFab = (): void => {
    fab.hidden = nearBottom();
  };
  const toBottom = (): void => {
    listEl.scrollTop = listEl.scrollHeight;
    paintFab();
  };
  fab.addEventListener('click', toBottom);

  // В чате поле ввода лежит в потоке под перепиской и отнимает у неё высоту, пока растёт;
  // scrollTop при этом на месте, и низ уезжает под край. Был у низа до смены высоты — идём
  // за ним (и при возврате высоты после отправки); читающего выше не трогаем.
  let seenHeight = -1;
  const heightWatch =
    chat && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          const prev = seenHeight;
          seenHeight = listEl.clientHeight;
          if (prev < 0 || prev === seenHeight) return;
          if (listEl.scrollHeight - listEl.scrollTop - prev <= NEAR_BOTTOM) toBottom();
        })
      : null;
  heightWatch?.observe(listEl);

  const showNotice = (text: string, reason?: string): void => {
    noticeEl.hidden = false;
    // В чате у пустой беседы свои слова: приглашение написать запрос и «агент не запущен».
    if (chat?.emptyState && items.length === 0 && (reason === 'no-transcript' || reason === 'no-agent')) {
      const node = chat.emptyState(reason);
      if (node) {
        noticeEl.replaceChildren(node);
        return;
      }
    }
    // Пустому экрану нужна та же дорога назад, что у Проводника и Репозитория, —
    // сообщение и «Повторить». Но когда беседа уже загружена, сбой одного запроса
    // её не стирает: экран остаётся читаемым, а отказ говорит строкой.
    if (items.length === 0) noticeEl.replaceChildren(errorScreen(text, () => void enqueue(tailJob)));
    else noticeEl.replaceChildren(document.createTextNode(text));
  };
  const clearNotice = (): void => {
    noticeEl.replaceChildren();
    noticeEl.hidden = true;
  };

  // Что написано на верхнем крае списка — взаимоисключающие состояния, поэтому
  // каждый признак назван по своей роли, а не общим «занято».
  let edgeSaysFirstLoad = true;
  let edgeSaysLoadingOlder = false;
  const paintEdge = (): void => {
    // Верхний край: первая страница в пути, тянем предыдущие, начало лежит в другом
    // файле (`complete:false`) или начало беседы достигнуто (`bof`).
    const text = edgeSaysFirstLoad
      ? t('feed.loading')
      : edgeSaysLoadingOlder
        ? t('feed.loadingOlder')
        : !complete
          ? t('feed.incomplete')
          : bof
            ? t('feed.start')
            : '';
    edgeEl.textContent = text;
    edgeEl.hidden = text === '';
    // Нижний край читает `eof`: конца беседы в окне нет — впереди есть что дочитать
    // (так бывает после прыжка к находке, и низ списка тянет продолжение сам).
    const more = agentKnown && !eof;
    tailEl.textContent = more ? t('feed.tailMore') : '';
    tailEl.hidden = !more;
  };

  const paintHeader = (): void => {
    agentEl.textContent = agentKnown ? t(`feed.${agent}`) : '';
    liveEl.hidden = !live || stateShown;
    skippedEl.textContent = t('feed.skipped', { n: skipped });
    skippedEl.hidden = skipped === 0;
  };

  /** Одна запись. Вид определяется только `kind`: ветки не рисуем — их не бывает. */
  const renderEntry = (entry: FeedEntry, prev: FeedEntry | undefined): HTMLElement => {
    const box = document.createElement('div');
    box.className = `th-feed__entry th-feed__entry--${entry.kind}`;
    box.dataset.kind = entry.kind;
    if (entry.cursor) box.dataset.cursor = entry.cursor;

    if (entry.kind === 'tool') {
      box.hidden = !showActions;
      // Подряд идущие вызовы читаются одним столбиком — соседа помечаем, чтобы CSS
      // убрал зазор между ними.
      if (prev?.kind === 'tool') box.classList.add('is-cont');
      // Что агент делает, его словами — первой строкой; «инструмент: аргумент» — второй.
      // Без описания строка прежняя: имя и аргумент лежат прямо в записи.
      let line: HTMLElement = box;
      if (chat && entry.desc) {
        box.classList.add('has-desc');
        const desc = document.createElement('div');
        desc.className = 'th-feed__tooldesc';
        desc.textContent = entry.desc;
        line = document.createElement('span');
        line.className = 'th-feed__toolline';
        box.append(desc, line);
      }
      if (chat && entry.result) line.append(createMark(entry.result));
      if (entry.tool) {
        const name = document.createElement('span');
        name.className = 'th-feed__toolname';
        name.textContent = entry.tool;
        line.append(name);
      }
      const what = document.createElement('span');
      what.className = 'th-feed__tooltext';
      // Агент кладёт имя инструмента и в `tool`, и первым словом `text» — вторую
      // копию не показываем, иначе выходит «Bash Bash cd …».
      const dup = entry.tool && (entry.text === entry.tool || entry.text.startsWith(`${entry.tool} `));
      what.textContent = dup ? entry.text.slice(entry.tool!.length).trimStart() : entry.text;
      line.append(what);
      if (chat) {
        linkifyPaths(what, chat.linker);
        // Команда оболочки подсвечивается по синтаксису; подсветка заменяет узлы, поэтому
        // ссылки на пути ставятся ещё раз, когда она готова.
        if (isShellTool(entry.tool) && what.textContent) {
          void highlightShell(what, what.textContent).then(() => linkifyPaths(what, chat.linker));
        }
        // Раскрытие — только у действий, у которых агент назвал подробности.
        if (entry.detail && entry.cursor) {
          const cursor = entry.cursor;
          mountToolDetail(box, entry, () => transport.feedDetail(session, cursor));
        }
      }
      return box;
    }

    if (entry.kind === 'note' && (entry.note === 'agent-start' || entry.note === 'agent-done' || entry.note === 'agent-message')) {
      return renderAgentEvent(box, entry);
    }

    if (entry.kind === 'note') {
      const label = document.createElement('span');
      label.className = 'th-feed__notelabel';
      label.textContent = entry.note ? t(`feed.note.${entry.note}`) : '';
      box.append(label);
      // Сводка сжатия — не подпись к вехе, а целый markdown-документ: агент дальше
      // работает по нему, а не по беседе. Рисуется карточкой своего цвета, как ответ.
      if (entry.note === 'compacted' && entry.text) {
        box.classList.add('th-feed__entry--summary');
        const text = document.createElement('div');
        text.className = 'th-feed__text th-feed__md';
        text.append(chat ? renderChatMarkdown(entry.text, chat.linker) : renderMarkdown(entry.text));
        box.append(text);
        if (entry.truncated) {
          const cut = document.createElement('div');
          cut.className = 'th-feed__cut';
          cut.textContent = t('feed.truncated');
          box.append(cut);
        }
        return box;
      }
      if (entry.text) {
        const text = document.createElement('div');
        text.className = 'th-feed__notetext';
        text.textContent = entry.text;
        box.append(text);
      }
      return box;
    }

    const meta = document.createElement('div');
    meta.className = 'th-feed__meta';
    // В чате подписи «кто» нет: реплику человека отличает плашка справа, ответ агента —
    // отсутствие плашки. Время остаётся подсказкой.
    if (chat && entry.at) box.title = formatDate(entry.at);
    const who = document.createElement('span');
    who.className = 'th-feed__who';
    who.textContent =
      entry.kind === 'human' ? t('feed.you') : entry.kind === 'thinking' ? t('feed.thinking') : t(`feed.${agent}`);
    meta.append(who);
    if (entry.at) {
      const when = document.createElement('time');
      when.className = 'th-feed__time';
      when.textContent = formatDate(entry.at);
      meta.append(when);
    }
    const text = document.createElement('div');
    text.className = 'th-feed__text';
    // Ответ агента приезжает markdown-ом и в терминале нарисован — в ленте он
    // рисуется тем же набором: заголовки, списки, таблицы, код. Реплику человека
    // рисовать нечем — её набрали руками, и в терминале она тоже как набрана.
    if (entry.kind === 'human') text.textContent = entry.text;
    else {
      text.classList.add('th-feed__md');
      text.append(chat ? renderChatMarkdown(entry.text, chat.linker) : renderMarkdown(entry.text));
    }
    if (chat && entry.kind !== 'thinking') box.append(text);
    else box.append(meta, text);
    if (entry.kind !== 'thinking') chat?.images?.attach(box, entry.text);
    if (entry.truncated) {
      const cut = document.createElement('div');
      cut.className = 'th-feed__cut';
      cut.textContent = t('feed.truncated');
      box.append(cut);
    }
    if (entry.kind === 'thinking') box.hidden = !showThinking;
    return box;
  };

  /** Событие фонового агента: запуск, завершение (с длительностью, если агент её дал) или
   *  пришедшее от него сообщение — оно свёрнуто в строку и раскрывается по нажатию. */
  const renderAgentEvent = (box: HTMLElement, entry: FeedEntry): HTMLElement => {
    box.classList.add('th-feed__entry--event');
    box.dataset.note = entry.note;
    if (entry.at) box.title = formatDate(entry.at);
    if (entry.note === 'agent-message') {
      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'th-feed__notelabel th-feed__event-toggle';
      toggleBtn.textContent = entry.from ? t('feed.note.agent-message', { from: entry.from }) : t('feed.note.agent-message-anon');
      toggleBtn.setAttribute('aria-expanded', 'false');
      const body = document.createElement('div');
      body.className = 'th-feed__event-body th-feed__text th-feed__md';
      body.hidden = true;
      let filled = false;
      toggleBtn.addEventListener('click', () => {
        if (!filled) {
          filled = true;
          body.append(chat ? renderChatMarkdown(entry.text, chat.linker) : renderMarkdown(entry.text));
          if (entry.truncated) {
            const cut = document.createElement('div');
            cut.className = 'th-feed__cut';
            cut.textContent = t('feed.truncated');
            body.append(cut);
          }
        }
        body.hidden = !body.hidden;
        toggleBtn.setAttribute('aria-expanded', String(!body.hidden));
      });
      box.append(toggleBtn, body);
      return box;
    }
    const label = document.createElement('span');
    label.className = 'th-feed__notelabel';
    const key =
      entry.note === 'agent-start' ? 'agent-start'
      : entry.outcome === 'failed' ? 'agent-failed'
      : entry.outcome === 'stopped' ? 'agent-stopped'
      : 'agent-done';
    const words = t(`feed.note.${key}`, { name: entry.text });
    label.textContent = entry.elapsed !== undefined ? `${words} · ${formatElapsed(entry.elapsed)}` : words;
    box.append(label);
    return box;
  };

  const applyThinking = (): void => {
    for (const el of itemsEl.querySelectorAll<HTMLElement>('[data-kind="thinking"]')) el.hidden = !showThinking;
  };

  actionsToggle.addEventListener('change', () => {
    showActions = actionsToggle.checked;
    try { localStorage.setItem(HIDE_ACTIONS_KEY, showActions ? '0' : '1'); } catch { /* необязательная настройка */ }
    for (const el of itemsEl.querySelectorAll<HTMLElement>('[data-kind="tool"]')) el.hidden = !showActions;
    paintButtons();
    paintHits(lastHits);
  });

  toggle.addEventListener('change', () => {
    showThinking = toggle.checked;
    writeThinking(showThinking);
    applyThinking();
    paintButtons();
    // Находки на мышление зависят от того же тумблера: включили — открылись
    // обратно, выключили — перестали притворяться доступными (см. jumpable).
    paintHits(lastHits);
  });

  // Окно заменили целиком (прыжок к находке, хвост заново): снимок поиска сделан
  // по прежнему окну и правдой быть перестал. Поиск подписывается ниже — ему
  // нужны loadOlder и jumpTo, которых здесь ещё нет.
  let windowReplaced = (): void => {};

  const resetWindow = (): void => {
    items = [];
    seen = new Set<string>();
    itemsEl.replaceChildren();
    bof = false;
    eof = false;
    complete = true;
    skipped = 0;
  };

  // ── Локальные записи: отправлено, но транскрипта ещё нет ─────────────
  interface LocalRec {
    key: string;
    state: LocalState;
    delivered: boolean;
    el: HTMLElement;
  }
  const locals: LocalRec[] = [];
  const sameText = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const dropLocal = (rec: LocalRec): void => {
    const i = locals.indexOf(rec);
    if (i >= 0) locals.splice(i, 1);
    rec.el.remove();
  };
  /** Пришла реплика человека: снимаем локальную запись с тем же текстом. Агент мог
   *  записать реплику иначе (вложение стало «[Image #1]») — тогда уходит старейшая из
   *  принятых агентом: транскрипт пишется в порядке отправки. Ошибочные не снимаются. */
  const settleLocal = (text: string): void => {
    const key = sameText(text);
    const exact = locals.find((l) => l.state !== 'failed' && l.key === key);
    const rec = exact ?? locals.find((l) => l.state !== 'failed' && l.delivered);
    if (rec) dropLocal(rec);
  };
  const addLocal = (text: string, state: LocalState = 'sending'): LocalMessage => {
    const box = document.createElement('div');
    box.className = 'th-feed__entry th-feed__entry--human th-feed__entry--local';
    const body = document.createElement('div');
    body.className = 'th-feed__text';
    body.textContent = text;
    const status = document.createElement('div');
    status.className = 'th-feed__local';
    status.setAttribute('role', 'status');
    box.append(body, status);
    const rec: LocalRec = { key: sameText(text), state, delivered: false, el: box };
    const paint = (note?: string, actions: LocalAction[] = []): void => {
      box.dataset.state = rec.state;
      const label = document.createElement('span');
      label.className = 'th-feed__local-state';
      label.textContent = t(`chat.local.${rec.state}`);
      status.replaceChildren(label);
      if (note) {
        const n = document.createElement('span');
        n.className = 'th-feed__local-note';
        n.textContent = note;
        status.append(n);
      }
      for (const action of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'th-feed__local-btn';
        b.textContent = action.label;
        b.addEventListener('click', () => action.run());
        status.append(b);
      }
    };
    paint();
    chat?.images?.attach(box, text);
    locals.push(rec);
    const stick = nearBottom();
    localEl.append(box);
    if (stick || locals.length === 1) toBottom();
    return {
      set: (next, opts = {}) => {
        if (!locals.includes(rec)) return;
        rec.state = next;
        if (opts.delivered !== undefined) rec.delivered = opts.delivered;
        paint(opts.note, opts.actions);
      },
      remove: () => dropLocal(rec),
    };
  };

  /** Вклеивает страницу в окно и возвращает, сколько записей действительно прибавилось
   *  (склейка беседы приезжает одной и той же записью в обеих соседних страницах). */
  const applyPage = (pageData: FeedPage, where: 'prepend' | 'append'): number => {
    agent = pageData.agent;
    agentKnown = true;
    live = pageData.live;
    complete = pageData.complete;
    skipped += pageData.skipped;
    if (where === 'prepend') {
      headCursor = pageData.head;
      bof = pageData.bof;
    } else {
      tailCursor = pageData.tail;
      eof = pageData.eof;
      if (items.length === 0) {
        headCursor = pageData.head;
        bof = pageData.bof;
      }
    }
    const fresh = pageData.entries.filter((e) => !seen.has(e.id));
    for (const e of fresh) seen.add(e.id);
    if (where === 'append') for (const e of fresh) if (e.kind === 'human') settleLocal(e.text);
    if (fresh.length > 0) {
      const frag = document.createDocumentFragment();
      if (where === 'prepend') {
        for (let i = 0; i < fresh.length; i += 1) frag.append(renderEntry(fresh[i]!, fresh[i - 1]));
        const wasHeight = listEl.scrollHeight;
        const wasTop = listEl.scrollTop;
        itemsEl.prepend(frag);
        items = [...fresh, ...items];
        // Листающий историю не должен дёргаться: держим под пальцем ту же запись.
        listEl.scrollTop = wasTop + (listEl.scrollHeight - wasHeight);
      } else {
        // «Внизу ли» решается здесь, в момент вклейки, а не перед запросом: за время
        // ответа пользователь мог уйти листать историю — или, наоборот, дойти до низа.
        const stick = nearBottom();
        let prev = items[items.length - 1];
        for (const e of fresh) {
          frag.append(renderEntry(e, prev));
          prev = e;
        }
        itemsEl.append(frag);
        items = [...items, ...fresh];
        if (stick) toBottom();
      }
    }
    paintHeader();
    paintEdge();
    paintFab();
    return fresh.length;
  };

  /** Один запрос к агенту. `null` — отказ уже показан (или ответ устарел),
   *  `'stale'` — курсор протух и хвост стоит взять заново. */
  let answered = false;
  const ask = async (opts: FeedOptions): Promise<FeedPage | 'stale' | null> => {
    let res: FeedResult;
    try {
      res = await transport.feed(session, { limit: LIMIT, ...opts });
    } catch {
      if (!disposed) {
        offline = true;
        chat?.onConnection?.(false);
        showNotice(t('feed.loadError'));
      }
      return null;
    }
    if (disposed) return null;
    // Первый ответ тоже называется: шапке чата нужен статус «подключено», а не только
    // возврат после обрыва.
    if (offline || !answered) {
      offline = false;
      answered = true;
      chat?.onConnection?.(true);
    }
    if (res.ok) {
      staleRetried = false;
      clearNotice();
      return res;
    }
    if (res.reason === 'cursor-stale') {
      const byCursor = Boolean(opts.before ?? opts.after ?? opts.around);
      // Хвост курсора не называл, либо лечение уже пробовали: дело не в устаревшем
      // курсоре — показываем как сбой поиска.
      if (byCursor && !staleRetried) return 'stale';
      showNotice(failureText({ reason: 'lookup-failed', detail: res.detail }));
      return null;
    }
    showNotice(failureText(res), res.reason);
    return null;
  };

  // Очередь запросов: один в полёте, порядок — как просили. Флага занятости мало:
  // отброшенная просьба листать вверх не повторится сама (пользователь уже у края,
  // и второго события прокрутки не будет), поэтому она не отбрасывается, а ждёт.
  let chain: Promise<void> = Promise.resolve();
  let queueDepth = 0;
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    queueDepth += 1;
    const run = chain.then(job, job).finally(() => {
      queueDepth -= 1;
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** Взять хвост беседы заново — с нуля, окном по умолчанию. Внутри очереди его
   *  зовут напрямую: через enqueue он ждал бы сам себя. */
  const tailJob = async (): Promise<void> => {
    try {
      const pageData = await ask({});
      if (!pageData || pageData === 'stale') return;
      resetWindow();
      applyPage(pageData, 'append');
      toBottom();
      windowReplaced();
    } finally {
      edgeSaysFirstLoad = false;
      paintEdge();
    }
  };

  const olderJob = async (): Promise<boolean | null> => {
    if (disposed) return null;
    if (bof) return false;
    edgeSaysLoadingOlder = true;
    paintEdge();
    try {
      for (;;) {
        const pageData = await ask({ before: headCursor });
        if (disposed) return null;
        if (pageData === 'stale') {
          staleRetried = true;
          await tailJob();
          return !bof;
        }
        if (!pageData) return !bof;
        // Пустая страница со сдвинутым курсором — шаг через строку, не влезшую в
        // окно ответа: край НЕ достигнут, идём дальше. Остановка — только по `bof`
        // или по курсору, который перестал двигаться.
        const moved = pageData.head !== headCursor;
        if (applyPage(pageData, 'prepend') > 0 || bof || !moved) return !bof;
      }
    } finally {
      edgeSaysLoadingOlder = false;
      paintEdge();
    }
  };

  const newerJob = async (): Promise<void> => {
    if (disposed) return;
    const pageData = await ask({ after: tailCursor });
    if (disposed) return;
    if (pageData === 'stale') {
      staleRetried = true;
      await tailJob();
      return;
    }
    if (pageData) applyPage(pageData, 'append');
  };

  const highlight = (cursor: string): void => {
    // Курсор агент даёт всей строке транскрипта, а не записи: с одним курсором в
    // списке стоит целая группа (у Claude строка часто начинается мышлением, за
    // которым идёт реплика). Находка принадлежит этой строке — отмечаем её всю.
    const group = [...itemsEl.querySelectorAll<HTMLElement>('[data-cursor]')].filter(
      (el) => el.dataset.cursor === cursor,
    );
    if (group.length === 0) return;
    // Вести надо к ВИДИМОЙ записи строки: отметка на скрытом мышлении прокруткой не
    // показывается, и переход доехал бы до человека без единого следа.
    let target = group.find((el) => !el.hidden);
    if (!target) {
      // Вся строка спрятана тумблером, а след перехода нужен: показываем ту самую
      // запись, ради которой прыгали. Выбор тумблера при этом не меняем — его
      // вернёт себе первое же переключение (applyThinking).
      target = group[0]!;
      target.hidden = false;
    }
    for (const el of group) el.classList.add('is-hit');
    target.scrollIntoView?.({ block: 'center' });
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
      for (const el of group) el.classList.remove('is-hit');
    }, HIGHLIGHT_MS);
  };

  const jumpJob = async (cursor: string): Promise<void> => {
    const pageData = await ask({ around: cursor });
    if (disposed) return;
    if (pageData === 'stale') {
      staleRetried = true;
      await tailJob();
      return;
    }
    if (!pageData) return;
    resetWindow();
    applyPage(pageData, 'append');
    highlight(cursor);
    windowReplaced();
  };

  // По одной подкачке в каждую сторону за раз: событий прокрутки приходит куда
  // больше, чем страниц, и вторая просьба только заняла бы очередь.
  //
  // Но «занят» — не ответ: он неотличим от «дальше есть ещё», и вызывающий (поиск
  // дочитывает ленту назад) счёл бы непрочитанную страницу прочитанной. Поэтому
  // вторая просьба не отбивается, а ждёт ту же подкачку и получает её настоящий
  // итог. Значений о беседе два — «дочитал, начало впереди» и «начало достигнуто»;
  // снесённый экран не отвечает о беседе вовсе и говорит null.
  let olderRun: Promise<boolean | null> | null = null;
  const loadOlder = (): Promise<boolean | null> => {
    if (disposed) return Promise.resolve(null);
    if (bof) return Promise.resolve(false);
    if (olderRun) return olderRun;
    const run = enqueue(olderJob).finally(() => {
      if (olderRun === run) olderRun = null;
    });
    olderRun = run;
    return run;
  };

  let newerInQueue = false;
  const loadNewer = async (): Promise<void> => {
    if (disposed || newerInQueue) return;
    newerInQueue = true;
    try {
      await enqueue(newerJob);
    } finally {
      newerInQueue = false;
    }
  };

  const jumpTo = (cursor: string): Promise<void> => enqueue(() => jumpJob(cursor));

  // ── Поиск: мгновенно по загруженному, дальше — дочитыванием назад ─────
  const queryEl = document.createElement('input');
  queryEl.type = 'search';
  queryEl.className = 'th-input th-feed__query';
  queryEl.placeholder = t('feed.search.placeholder');
  queryEl.setAttribute('aria-label', t('feed.search.placeholder'));
  const statusEl = document.createElement('div');
  statusEl.className = 'th-feed__searchstatus';
  statusEl.setAttribute('role', 'status');
  statusEl.hidden = true;
  const moreEl = document.createElement('button');
  moreEl.type = 'button';
  moreEl.className = 'th-btn th-btn--sm th-feed__searchmore';
  moreEl.textContent = t('feed.search.deeper');
  moreEl.hidden = true;
  const hitsEl = document.createElement('div');
  hitsEl.className = 'th-feed__hits';
  searchSlot.append(queryEl, statusEl, moreEl, hitsEl);

  // Поколение поиска: следующий запрос обесценивает идущее дочитывание, и его
  // поздние страницы уже не считаются просмотренными для нового слова.
  let searchGen = 0;
  let searchTimer = 0;

  const paintStatus = (text: string, deeper: boolean): void => {
    statusEl.textContent = text;
    statusEl.hidden = text === '';
    moreEl.hidden = !deeper;
  };

  // Находки, показанные последними, — чтобы при переключении тумблера
  // перерисовать их доступность заново, не гоняя поиск (тот же снимок, другой вид).
  let lastHits: FeedHit[] = [];

  /** Находку можно открыть, только если у неё есть точка прыжка и её запись не
   *  спрятана тумблером мышления — иначе клик либо не имеет цели вовсе (веха
   *  склейки без курсора), либо вёл бы к записи, которой сейчас не видно в ленте. */
  const jumpable = (hit: FeedHit): boolean => Boolean(hit.cursor) && (hit.entry.kind !== 'thinking' || showThinking) && (hit.entry.kind !== 'tool' || showActions);

  const paintHits = (found: FeedHit[]): void => {
    lastHits = found;
    const frag = document.createDocumentFragment();
    for (const hit of found) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'th-feed__hit';
      const canJump = jumpable(hit);
      row.disabled = !canJump;
      if (hit.cursor) row.dataset.cursor = hit.cursor;
      if (hit.entry.at) {
        const when = document.createElement('time');
        when.className = 'th-feed__hittime';
        when.textContent = formatDate(hit.entry.at);
        row.append(when);
      }
      const kind = document.createElement('span');
      kind.className = 'th-feed__hitkind';
      kind.textContent = t(`feed.kind.${hit.entry.kind}`);
      const text = document.createElement('span');
      text.className = 'th-feed__hittext';
      text.textContent = hit.snippet;
      row.append(kind, text);
      if (canJump) {
        const cursor = hit.cursor!;
        row.addEventListener('click', () => void jumpTo(cursor));
      }
      frag.append(row);
    }
    hitsEl.replaceChildren(frag);
  };

  /** Дочитывает назад страницами, пока не найдёт, не упрётся в начало беседы
   *  или не истратит свои SEARCH_PAGES страниц. */
  const deepen = async (my: number, query: string): Promise<void> => {
    paintStatus(t('feed.search.scanning', { n: items.length }), false);
    for (let page = 0; page < SEARCH_PAGES; page += 1) {
      const had = items.length;
      const more = await loadOlder();
      if (disposed || my !== searchGen) return;
      const found = searchFeed(items, query);
      if (found.length > 0) {
        paintHits(found);
        paintStatus(t('feed.search.found', { n: found.length }), false);
        return;
      }
      // Начало беседы достигнуто — искать больше негде, кнопки «дальше» нет.
      if (!more) {
        paintStatus(t('feed.search.all'), false);
        return;
      }
      // Страница не прибавилась, хотя край не достигнут: подкачку сейчас ведёт
      // листание или она сорвалась. Бюджет на это не тратим — пусть человек
      // попросит ещё сам.
      if (items.length === had) break;
      paintStatus(t('feed.search.scanning', { n: items.length }), false);
    }
    paintStatus(t('feed.search.limit', { n: items.length }), true);
  };

  /** Начинает заход дочитывания, если он ещё чей-то. Своей очереди поверх очереди
   *  экрана не держим: вторая просьба к loadOlder() ждёт ту же подкачку и получает
   *  её настоящий итог, так что заход поверх идущего страницу не теряет. */
  const startScan = (my: number, query: string): void => {
    if (disposed || my !== searchGen) return;
    void deepen(my, query);
  };

  const runSearch = (query: string): void => {
    searchGen += 1;
    const my = searchGen;
    window.clearTimeout(searchTimer);
    if (query.trim() === '') {
      paintHits([]);
      paintStatus('', false);
      return;
    }
    const found = searchFeed(items, query);
    paintHits(found);
    if (found.length > 0) {
      paintStatus(t('feed.search.found', { n: found.length }), false);
      return;
    }
    // По загруженному пусто — дочитываем назад, честно показывая счёт. Не сразу:
    // на следующей букве этот заход всё равно стал бы ничьим.
    searchTimer = window.setTimeout(() => startScan(my, query), SEARCH_IDLE_MS);
  };

  windowReplaced = (): void => {
    // Идущий заход считал записи прежнего окна — его итог уже ничей.
    searchGen += 1;
    window.clearTimeout(searchTimer);
    const query = queryEl.value;
    if (query.trim() === '') return;
    // Пересобираем снимок по новому окну: за его пределы лезем только по просьбе —
    // человек сюда только что перешёл, а не просил искать дальше.
    const found = searchFeed(items, query);
    paintHits(found);
    paintStatus(found.length > 0 ? t('feed.search.found', { n: found.length }) : '', false);
  };

  queryEl.addEventListener('input', () => runSearch(queryEl.value));
  // Кнопка поиска шапки чата: включили — поле показано и в фокусе; выключили — поле
  // спрятано, запрос и находки сброшены. Прыжок к записи от поля не зависит.
  function setSearch(on: boolean, byHand: boolean): void {
    searchOn = on;
    searchSlot.hidden = !on;
    try { localStorage.setItem(SEARCH_KEY, on ? '1' : '0'); } catch { /* необязательная настройка */ }
    paintButtons();
    if (on) {
      if (byHand) queryEl.focus();
    } else if (queryEl.value !== '') {
      queryEl.value = '';
      runSearch('');
    }
  }
  moreEl.addEventListener('click', () => {
    searchGen += 1;
    window.clearTimeout(searchTimer);
    startScan(searchGen, queryEl.value);
  });

  // ── Листание вверх ───────────────────────────────────────────────────
  listEl.addEventListener('scroll', () => {
    paintFab();
    if (listEl.scrollTop <= NEAR_TOP) void loadOlder();
    // Хвоста беседы в окне нет (`eof` ложь — так бывает после прыжка к находке):
    // у нижнего края дочитываем вперёд, как у верхнего дочитываем назад. Края не
    // спорят за событие: на беседе короче экрана близки оба сразу, и «или-или»
    // оставило бы хвост недостижимым — опрос у мёртвого агента выключен. Обе
    // подкачки идут одной очередью и каждая сама встаёт на своём краю.
    if (!eof && nearBottom()) void loadNewer();
  });

  // ── Приращение ───────────────────────────────────────────────────────
  // Экран показан — это и вкладка (.th-ws-view вне рабочего пространства нет), и
  // сама страница: в фоне опроса нет.
  const shown = (): boolean => {
    const view = main.closest('.th-ws-view');
    return document.visibilityState === 'visible' && (!view || view.classList.contains('is-active'));
  };
  // Таймер один, с шагом в секунду: работающий агент опрашивается каждым шагом,
  // остальное время — каждым третьим (ADR 0028).
  let busyAgent = false;
  let sincePoll = 0;
  const timer = window.setInterval(() => {
    sincePoll += FAST_POLL_MS;
    if (!busyAgent && sincePoll < POLL_MS) return;
    sincePoll = 0;
    // Запросы не копим: пока очередь не пуста, следующего продолжения не просим.
    if (disposed || queueDepth > 0 || !(live || offline || busyAgent) || !shown()) return;
    // Первая загрузка не удалась — продолжать нечего, берём хвост заново.
    void (offline && items.length === 0 ? enqueue(tailJob) : loadNewer());
  }, FAST_POLL_MS);
  // Корни проводника приехали позже первых записей — пути в них становятся ссылками.
  if (chat) {
    void chat.linker.ready.then(() => {
      if (disposed) return;
      for (const el of itemsEl.querySelectorAll<HTMLElement>('.th-feed__md, .th-feed__tooltext')) {
        linkifyPaths(el, chat.linker);
      }
    });
  }

  paintHeader();
  paintEdge();
  paintFab();
  void enqueue(tailJob);

  // ── Расход сессии: счётчик в шапке ленты ─────────────────────────────
  // Спрашивается при открытии и раз в 30 с, пока вкладка на экране; у агента без
  // возможности `usage` счётчика нет вовсе. Отказ (нет агента, opencode) счётчик прячет.
  const refreshUsage = async (): Promise<void> => {
    if (!(await whenCap('usage', transport)) || disposed) return;
    try {
      const res = await sessionUsage(transport, session);
      if (disposed) return;
      usageEl.hidden = !res.ok;
      if (!res.ok) return;
      const line = (u: typeof res.total): Record<string, string> => ({
        time: formatDuration(u.activeMs),
        out: formatTokens(u.output),
        all: formatTokens(allTokens(u)),
      });
      usageEl.textContent = t('feed.usageToday', line(res.today));
      usageEl.title = t('feed.usageTotal', line(res.total));
    } catch {
      // Обрыв связи: прежние цифры остаются, следующий заход спросит снова.
    }
  };
  const usageTimer = window.setInterval(() => {
    if (shown()) void refreshUsage();
  }, 30_000);
  void refreshUsage();

  return {
    el: main,
    searchSlot,
    entries: () => [...items],
    loadOlder,
    jumpTo,
    refresh: () => void loadNewer(),
    addLocal,
    stateSlot,
    stopSlot,
    setStateShown: (on) => {
      stateShown = on;
      paintHeader();
    },
    setBusy: (on) => {
      busyAgent = on;
    },
    teardown: () => {
      disposed = true;
      window.clearInterval(usageTimer);
      window.clearInterval(timer);
      window.clearTimeout(highlightTimer);
      window.clearTimeout(searchTimer);
      heightWatch?.disconnect();
      sbar?.teardown();
      host.replaceChildren();
    },
  };
}
