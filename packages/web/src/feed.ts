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

import { openCreateModal } from './dashboard';
import { formatDate } from './format';
import { t } from './i18n';
import { sfeedHash } from './routes';
import { mountSessionBar } from './tabs';
import type { FeedEntry, FeedOptions, FeedPage, FeedResult, Transport } from './transport';
import { errorScreen, renderHoloBar, wireToolbar } from './ui';

/** Размер страницы: хвост открывается быстро, листание тянет такими же кусками. */
const LIMIT = 100;
/** Период приращения — тот же, что и у опроса сессий. */
const POLL_MS = 3000;
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
  teardown(): void;
}

/** Находка поиска: запись, к которой переносят ленту, и строка вокруг совпадения. */
export interface FeedHit {
  entry: FeedEntry;
  /** Точка прыжка: у находки курсор есть всегда — без него её не предлагают. */
  cursor: string;
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
    // Точка прыжка — курсор записи; без него находку некуда открыть, поэтому
    // веха склейки в список находок не попадает.
    const cursor = entry.cursor;
    if (!cursor) continue;
    const at = entry.text.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    hits.push({ entry, cursor, snippet: snippetAt(entry.text, at, needle.length) });
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

/** Монтирует ленту сессии в host. */
export function mountFeed(host: HTMLElement, session: string, transport: Transport): FeedHandle {
  host.replaceChildren();

  // ── Каркас: полоса сессий + Holo-бар + тело вкладки ──────────────────
  const sbar = mountSessionBar({
    transport,
    current: session,
    onSwitch: (name) => (location.hash = sfeedHash(name)),
    onCreate: () => openCreateModal(transport),
  });
  let hideBar = (): void => {};
  const toolbar = document.createElement('div');
  toolbar.className = 'th-holowrap th-slide th-slide--top';
  toolbar.append(renderHoloBar({ active: 'feed', session, transport, onHide: () => hideBar() }));

  const main = document.createElement('main');
  main.className = 'th-feed';

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
  toggleText.textContent = t('feed.thinking');
  toggleWrap.append(toggle, toggleText);
  head.append(agentEl, liveEl, toggleWrap);

  // Полоса поиска — над списком и под шапкой (наполняется ниже, когда есть чем
  // листать назад: поиску нужны loadOlder и jumpTo).
  const searchSlot = document.createElement('div');
  searchSlot.className = 'th-feed__search';

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
  listEl.append(edgeEl, itemsEl, tailEl, noticeEl, skippedEl);
  main.append(head, searchSlot, listEl);
  host.append(sbar.el, toolbar, main);
  hideBar = wireToolbar({ toolbars: [toolbar], floatMount: main }).hide;

  // ── Состояние окна ленты ─────────────────────────────────────────────
  let items: FeedEntry[] = [];
  let seen = new Set<string>();
  let agent: 'claude' | 'codex' = 'claude';
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
  // Устаревший курсор лечится молча — но ровно один раз на действие.
  let staleRetried = false;
  let disposed = false;
  let highlightTimer = 0;

  const nearBottom = (): boolean => listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight <= NEAR_BOTTOM;
  const toBottom = (): void => {
    listEl.scrollTop = listEl.scrollHeight;
  };

  const showNotice = (text: string): void => {
    noticeEl.hidden = false;
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
    liveEl.hidden = !live;
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
      // Подряд идущие вызовы читаются одним столбиком — соседа помечаем, чтобы CSS
      // убрал зазор между ними.
      if (prev?.kind === 'tool') box.classList.add('is-cont');
      if (entry.tool) {
        const name = document.createElement('span');
        name.className = 'th-feed__toolname';
        name.textContent = entry.tool;
        box.append(name);
      }
      const what = document.createElement('span');
      what.className = 'th-feed__tooltext';
      what.textContent = entry.text;
      box.append(what);
      return box;
    }

    if (entry.kind === 'note') {
      const label = document.createElement('span');
      label.className = 'th-feed__notelabel';
      label.textContent = entry.note ? t(`feed.note.${entry.note}`) : '';
      box.append(label);
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
    text.textContent = entry.text;
    box.append(meta, text);
    if (entry.truncated) {
      const cut = document.createElement('div');
      cut.className = 'th-feed__cut';
      cut.textContent = t('feed.truncated');
      box.append(cut);
    }
    if (entry.kind === 'thinking') box.hidden = !showThinking;
    return box;
  };

  const applyThinking = (): void => {
    for (const el of itemsEl.querySelectorAll<HTMLElement>('[data-kind="thinking"]')) el.hidden = !showThinking;
  };

  toggle.addEventListener('change', () => {
    showThinking = toggle.checked;
    writeThinking(showThinking);
    applyThinking();
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
    return fresh.length;
  };

  /** Один запрос к агенту. `null` — отказ уже показан (или ответ устарел),
   *  `'stale'` — курсор протух и хвост стоит взять заново. */
  const ask = async (opts: FeedOptions): Promise<FeedPage | 'stale' | null> => {
    let res: FeedResult;
    try {
      res = await transport.feed(session, { limit: LIMIT, ...opts });
    } catch {
      if (!disposed) showNotice(t('feed.loadError'));
      return null;
    }
    if (disposed) return null;
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
    showNotice(failureText(res));
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

  const paintHits = (found: FeedHit[]): void => {
    const frag = document.createDocumentFragment();
    for (const hit of found) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'th-feed__hit';
      row.dataset.cursor = hit.cursor;
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
      row.addEventListener('click', () => void jumpTo(hit.cursor));
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
  moreEl.addEventListener('click', () => {
    searchGen += 1;
    window.clearTimeout(searchTimer);
    startScan(searchGen, queryEl.value);
  });

  // ── Листание вверх ───────────────────────────────────────────────────
  listEl.addEventListener('scroll', () => {
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
  const timer = window.setInterval(() => {
    // Запросы не копим: пока очередь не пуста, следующего продолжения не просим.
    if (disposed || queueDepth > 0 || !live || !shown()) return;
    void loadNewer();
  }, POLL_MS);

  paintHeader();
  paintEdge();
  void enqueue(tailJob);

  return {
    el: main,
    searchSlot,
    entries: () => [...items],
    loadOlder,
    jumpTo,
    teardown: () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearTimeout(highlightTimer);
      window.clearTimeout(searchTimer);
      sbar.teardown();
      host.replaceChildren();
    },
  };
}
