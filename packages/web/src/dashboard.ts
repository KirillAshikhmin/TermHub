// Дашборд: экран входа, сетка карточек сессий, поллинг, реакция на звонки,
// модалка создания сессии. renderSessionCard — чистая функция (тестируется).

import type { SessionInfo } from '@termhub/protocol';

import { api, ApiError } from './api';
import type { CreateSessionInput, DirGroup } from './api';
import type { TFn } from './i18n';
import { t } from './i18n';
import { notifyBell } from './notify';
import { playBell } from './sound';
import { formatRelativeTime } from './time';
import type { Transport } from './transport';
import { activity } from './activity';
import { makeActivityDot } from './activity-dot';
import { sessionManaged, sessionTitleText, sessionWorking } from './session-status';
import { bellUnseen, observeBells } from './bell-seen';
import { iconButton, openModal, renderHeader, renderTabs, spinner, svgIcon, toast } from './ui';

const POLL_INTERVAL = 3000;

/** basename каталога: последний непустой сегмент пути. */
function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : path;
}

/** true для команды claude (акцентный бейдж). */
function isClaude(command: string): boolean {
  return command.trim().toLowerCase().startsWith('claude');
}

/** Имя карточки: заголовок терминала (Claude его меняет), а в скобках — tmux-имя
 *  сессии, если отличается. Индикатор активности из заголовка срезан (он — точкой). */
function sessionDisplayName(session: SessionInfo): string {
  const term = sessionTitleText(session.title);
  return term && term !== session.name ? `${term} (${session.name})` : session.name;
}

export interface CardOptions {
  now?: number;
  showActivity?: boolean;
  onOpen?: () => void;
  onKill?: () => void;
  onRename?: () => void;
}

/** Точка активности — первый элемент в .th-card__name (перед текстом имени). */
function setCardActivityDot(name: HTMLElement | null, translate: TFn, show: boolean): void {
  if (!name) return;
  const dot = name.querySelector<HTMLElement>('.th-card__activity');
  if (show) {
    if (!dot) name.prepend(makeActivityDot('th-card__activity', translate('card.activity')));
  } else {
    dot?.remove();
  }
}

/** Чистый рендер карточки сессии из SessionInfo. */
export function renderSessionCard(session: SessionInfo, translate: TFn, opts: CardOptions = {}): HTMLElement {
  const now = opts.now ?? Date.now();

  const card = document.createElement('article');
  card.className = 'th-card';
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${translate('card.open')}: ${sessionDisplayName(session)}`);

  const top = document.createElement('div');
  top.className = 'th-card__top';

  const name = document.createElement('h3');
  name.className = 'th-card__name';
  const nameText = document.createElement('span');
  nameText.className = 'th-card__name-text';
  nameText.textContent = sessionDisplayName(session);
  name.append(nameText);
  setCardActivityDot(name, translate, opts.showActivity ?? false);
  top.append(name);

  const menuWrap = document.createElement('div');
  menuWrap.className = 'th-card__menu-wrap';
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'th-card__menu';
  menuBtn.setAttribute('aria-label', translate('card.menu'));
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.append(svgIcon('dots'));
  const pop = document.createElement('div');
  pop.className = 'th-card__menupop';
  const closeMenu = (): void => {
    menuWrap.classList.remove('is-open');
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  const renameBtn = document.createElement('button');
  renameBtn.type = 'button';
  renameBtn.className = 'th-card__menu-item';
  renameBtn.append(svgIcon('pencil'), document.createTextNode(translate('card.rename')));
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    opts.onRename?.();
  });
  const killBtn = document.createElement('button');
  killBtn.type = 'button';
  killBtn.className = 'th-card__kill';
  killBtn.append(svgIcon('trash'), document.createTextNode(translate('card.kill')));
  killBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeMenu();
    opts.onKill?.();
  });
  pop.append(renameBtn, killBtn);
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menuWrap.classList.toggle('is-open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  menuWrap.append(menuBtn, pop);
  top.append(menuWrap);
  card.append(top);

  const dir = document.createElement('div');
  dir.className = 'th-card__dir';
  dir.append(svgIcon('folder'));
  const dirName = document.createElement('span');
  dirName.textContent = basename(session.path);
  dir.append(dirName);
  dir.title = session.path;
  card.append(dir);

  const foot = document.createElement('div');
  foot.className = 'th-card__foot';

  const badge = document.createElement('span');
  badge.className = isClaude(session.command) ? 'th-badge th-badge--claude' : 'th-badge';
  badge.textContent = session.command;
  foot.append(badge);

  const time = document.createElement('span');
  time.className = 'th-card__time';
  time.textContent = formatRelativeTime(session.activityTs, translate, now);
  foot.append(time);

  if (session.attached > 0) {
    const attached = document.createElement('span');
    attached.className = 'th-attached';
    attached.title = translate('card.attached', { n: session.attached });
    attached.textContent = `${session.attached}`;
    foot.append(attached);
  }

  if (session.bell) {
    const bell = document.createElement('span');
    bell.className = 'th-bell';
    bell.setAttribute('aria-label', translate('card.bell'));
    bell.textContent = '🔔';
    foot.append(bell);
  }

  card.append(foot);

  const activate = (): void => {
    if (menuWrap.classList.contains('is-open')) {
      menuWrap.classList.remove('is-open');
      menuBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    opts.onOpen?.();
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      activate();
    }
  });

  return card;
}

/**
 * Обновляет изменяемые поля карточки НА МЕСТЕ (без пересоздания узла): бейдж
 * команды, относительное время, счётчик attached, значок звонка. Чистая —
 * тестируется отдельно. Идентичность карточки (name/каталог) не трогаем.
 */
export function updateSessionCard(
  card: HTMLElement,
  session: SessionInfo,
  translate: TFn,
  now: number = Date.now(),
  showActivity = false,
): void {
  setCardActivityDot(card.querySelector<HTMLElement>('.th-card__name'), translate, showActivity);

  // Имя-текст меняется вслед за заголовком терминала (Claude его правит).
  const nameText = card.querySelector<HTMLElement>('.th-card__name-text');
  if (nameText) nameText.textContent = sessionDisplayName(session);

  const badge = card.querySelector<HTMLElement>('.th-badge');
  if (badge) {
    badge.textContent = session.command;
    badge.className = isClaude(session.command) ? 'th-badge th-badge--claude' : 'th-badge';
  }

  const time = card.querySelector<HTMLElement>('.th-card__time');
  if (time) time.textContent = formatRelativeTime(session.activityTs, translate, now);

  const foot = card.querySelector<HTMLElement>('.th-card__foot');
  if (!foot) return;

  // attached — сразу после времени, чтобы порядок совпадал с первичным рендером.
  let attached = foot.querySelector<HTMLElement>('.th-attached');
  if (session.attached > 0) {
    if (!attached) {
      attached = document.createElement('span');
      attached.className = 'th-attached';
      if (time) time.after(attached);
      else foot.append(attached);
    }
    attached.title = translate('card.attached', { n: session.attached });
    attached.textContent = `${session.attached}`;
  } else {
    attached?.remove();
  }

  // bell — всегда последний элемент подвала.
  let bell = foot.querySelector<HTMLElement>('.th-bell');
  if (session.bell) {
    if (!bell) {
      bell = document.createElement('span');
      bell.className = 'th-bell';
      bell.setAttribute('aria-label', translate('card.bell'));
      bell.textContent = '🔔';
      foot.append(bell);
    }
  } else {
    bell?.remove();
  }
}

/** Карточка «занята» пользователем: открыто ⋯-меню или внутри неё фокус. */
function isCardBusy(card: HTMLElement): boolean {
  if (card.querySelector('.th-card__menu-wrap.is-open')) return true;
  const active = document.activeElement;
  return active instanceof Node && card.contains(active);
}

/** Переставляет карточки в порядок sessions (вызывается только без «занятых» карточек). */
function reorderGrid(grid: HTMLElement, sessions: SessionInfo[], cards: Map<string, HTMLElement>): void {
  let anchor: ChildNode | null = grid.firstChild;
  for (const session of sessions) {
    const card = cards.get(session.name);
    if (!card) continue;
    if (card === anchor) anchor = anchor.nextSibling;
    else grid.insertBefore(card, anchor);
  }
}

/** Экран входа: пароль, спиннер на время запроса, локализованная ошибка. */
export function mountLogin(root: HTMLElement): () => void {
  root.replaceChildren();
  const header = renderHeader(false);
  root.append(header.el);

  const main = document.createElement('main');
  main.className = 'th-login';

  const formCard = document.createElement('form');
  formCard.className = 'th-login__card';
  formCard.noValidate = true;

  const title = document.createElement('h1');
  title.className = 'th-login__title';
  title.textContent = t('login.title');

  const subtitle = document.createElement('p');
  subtitle.className = 'th-login__subtitle';
  subtitle.textContent = t('login.subtitle');

  const field = document.createElement('input');
  field.type = 'password';
  field.className = 'th-input';
  field.autocomplete = 'current-password';
  field.setAttribute('aria-label', t('login.password'));
  field.placeholder = t('login.password');

  const error = document.createElement('p');
  error.className = 'th-login__error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'th-btn th-btn--primary th-login__submit';
  submit.textContent = t('login.submit');

  formCard.append(title, subtitle, field, error, submit);
  main.append(formCard);
  root.append(main);
  field.focus();

  formCard.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.hidden = true;
    submit.disabled = true;
    submit.replaceChildren(spinner());
    try {
      await api.login(field.value);
      location.hash = '#/';
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      error.textContent =
        status === 429 ? t('login.rateLimited') : status === 401 ? t('login.wrongPassword') : t('login.networkError');
      error.hidden = false;
      field.select();
    } finally {
      submit.disabled = false;
      submit.textContent = t('login.submit');
    }
  });

  return () => {
    header.teardown();
    root.replaceChildren();
  };
}

// Снимок звонков переживает перемонтирование (смена языка/темы), чтобы не
// проигрывать бип повторно для уже известного звонка.
let knownBells = new Set<string>();

// Кэш последнего списка сессий по транспорту (переживает уход с дашборда и возврат):
// при повторном заходе рендерим сразу известный список, а refresh() обновит в фоне —
// без скелетонов и ожидания. Ключ — транспорт (у каждого агента relay свой инстанс).
const sessionCache = new WeakMap<Transport, SessionInfo[]>();

/** Дашборд сессий с поллингом и реакцией на новые звонки (через транспорт). */
export function mountDashboard(
  root: HTMLElement,
  transport: Transport,
  opts: { onPickAgent?: () => void } = {},
): () => void {
  root.replaceChildren();
  const header = renderHeader(true, transport, opts.onPickAgent);
  root.append(header.el, renderTabs('sessions', transport));

  const main = document.createElement('main');
  main.className = 'th-dashboard';
  const grid = document.createElement('div');
  grid.className = 'th-grid';
  grid.append(skeletonCard(), skeletonCard(), skeletonCard());
  main.append(grid);
  root.append(main);

  const fab = document.createElement('button');
  fab.type = 'button';
  fab.className = 'th-fab';
  fab.setAttribute('aria-label', t('dashboard.newSession'));
  fab.title = t('dashboard.newSession');
  fab.append(svgIcon('plus'));
  // Создали сессию → сразу открываем её терминал (а не просто обновляем список).
  fab.addEventListener('click', () =>
    openCreateModal(transport, (name) => (location.hash = `#/term/${encodeURIComponent(name)}`)),
  );
  root.append(fab);

  let stopped = false;
  let loadedOnce = false;
  let bellsSeeded = false;
  // Подавляет повторный тост, пока идёт один и тот же эпизод обрыва relay
  // (poll раз в 3с иначе спамил бы тостом на каждый неудачный refresh).
  let linkDownNotified = false;
  const cards = new Map<string, HTMLElement>();
  let showingEmpty = false;
  let gridReady = false; // false, пока в сетке скелетоны — первый рендер их убирает

  const buildCard = (session: SessionInfo, now: number, hot: boolean): HTMLElement =>
    renderSessionCard(session, t, {
      now,
      showActivity: hot,
      onOpen: () => {
        location.hash = `#/term/${encodeURIComponent(session.name)}`;
      },
      onKill: () => void killSession(session.name),
      onRename: () => openRenameModal(transport, session.name, () => void refresh()),
    });

  // Щадящее обновление: не перестраиваем всю сетку каждый поллинг (это сбрасывало
  // бы фокус и закрывало открытое ⋯-меню). Карточки создаём/удаляем/обновляем
  // точечно, «занятые» пользователем (меню/фокус) не трогаем.
  const render = (sessions: SessionInfo[]): void => {
    if (sessions.length === 0) {
      if (!showingEmpty) {
        cards.clear();
        main.replaceChildren(emptyState());
        showingEmpty = true;
      }
      return;
    }
    // Переход из скелетонов/пустого в сетку — единственный момент полной замены.
    if (!gridReady || showingEmpty || !main.contains(grid)) {
      grid.replaceChildren();
      main.replaceChildren(grid);
      cards.clear();
      showingEmpty = false;
      gridReady = true;
    }

    const now = Date.now();
    const wanted = new Set(sessions.map((s) => s.name));
    // Удаляем карточки исчезнувших сессий (кроме «занятой» — уйдёт на следующем
    // поле, когда пользователь закроет меню / уведёт фокус).
    for (const [name, card] of [...cards]) {
      if (!wanted.has(name) && !isCardBusy(card)) {
        card.remove();
        cards.delete(name);
      }
    }
    // Создаём новые и обновляем существующие на месте (кроме «занятых»).
    for (const session of sessions) {
      const existing = cards.get(session.name);
      // Работает: Claude-спиннер в заголовке; не-Claude сессии — fallback по опросу.
      const hot = sessionWorking(session.title) || (!sessionManaged(session.title) && activity.isHot(session.name));
      // 🔔 — только пока звонок «не прочитан» (не открывали сессию).
      const s = { ...session, bell: bellUnseen(session.name) };
      if (!existing) {
        const card = buildCard(s, now, hot);
        cards.set(session.name, card);
        grid.append(card);
      } else if (!isCardBusy(existing)) {
        updateSessionCard(existing, s, t, now, hot);
      }
    }
    // Порядок сетки приводим к списку сессий, только если ни одна карточка не
    // «занята» — перемещение узла сбросило бы открытое меню/фокус.
    if (![...cards.values()].some(isCardBusy)) reorderGrid(grid, sessions, cards);
  };

  const reactToBells = (sessions: SessionInfo[]): void => {
    const nextBells = new Set<string>();
    for (const s of sessions) if (s.bell) nextBells.add(s.name);
    // Первый снимок задаёт базовую линию — «новыми» звонки станут только на
    // следующих поллах, чтобы не пикать при заходе на уже звенящую сессию.
    if (bellsSeeded) {
      for (const name of nextBells) {
        if (!knownBells.has(name)) {
          playBell();
          notifyBell(name);
        }
      }
    }
    bellsSeeded = true;
    knownBells = nextBells;
  };

  const refresh = async (): Promise<void> => {
    try {
      const sessions = await transport.list();
      if (stopped) return;
      linkDownNotified = false;
      activity.observe(sessions);
      observeBells(sessions);
      reactToBells(sessions);
      render(sessions);
      sessionCache.set(transport, sessions); // кэш для мгновенного показа при возврате
      loadedOnce = true;
    } catch (err) {
      if (stopped || (err instanceof ApiError && err.status === 401)) return;
      // Relay временно недоступен (хендшейк/реконнект) — не «настоящая» ошибка:
      // сигнализируем один раз за эпизод обрыва, а не на каждый 3с-полл.
      const linkDown = transport.isStreaming === false;
      // Первый экран, пока relay поднимает поток, — это штатное «Подключение к
      // агенту…», а НЕ ошибка: показываем connecting-состояние вместо errorState
      // (иначе юзер при выборе агента видит красную ошибку до ~3с, хотя связь
      // устанавливается нормально). Не трогаем linkDownNotified — обрыв уже
      // загруженного дашборда (loadedOnce) остаётся на прежнем тост-пути.
      if (!loadedOnce && linkDown) {
        if (!main.querySelector('.th-connecting')) main.replaceChildren(connectingState());
        return;
      }
      if (linkDown && linkDownNotified) return;
      if (linkDown) linkDownNotified = true;
      if (!loadedOnce) main.replaceChildren(errorState(() => void refresh()));
      else toast(t('dashboard.reloadError'), 'error');
    }
  };

  const killSession = async (name: string): Promise<void> => {
    if (!confirm(t('card.confirmKill', { name }))) return;
    try {
      await transport.kill(name);
      knownBells.delete(name);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return;
      toast(t('card.killError'), 'error');
    }
  };

  // Мгновенный показ из кэша (без скелетонов) при возврате на дашборд; refresh() обновит в фоне.
  // ВАЖНО: loadedOnce тут НЕ ставим. Иначе при мёртвой связи (relay ещё поднимает поток)
  // экран «Подключение к агенту…» подменялся бы устаревшими карточками + красным тостом,
  // хотя данные на экране — из прошлого визита и, возможно, уже неверны.
  const cached = sessionCache.get(transport);
  if (cached) render(cached);

  const tick = (): void => {
    if (document.visibilityState === 'visible') void refresh();
  };
  const timer = window.setInterval(tick, POLL_INTERVAL);
  document.addEventListener('visibilitychange', tick);
  void refresh();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', tick);
    header.teardown();
    root.replaceChildren();
  };
}

function skeletonCard(): HTMLElement {
  const card = document.createElement('div');
  card.className = 'th-card th-card--skeleton';
  card.setAttribute('aria-hidden', 'true');
  return card;
}

function emptyState(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'th-empty';
  const glyph = document.createElement('div');
  glyph.className = 'th-empty__glyph';
  glyph.textContent = '›_';
  const title = document.createElement('h2');
  title.textContent = t('dashboard.emptyTitle');
  const hint = document.createElement('p');
  hint.className = 'th-empty__hint';
  const code = document.createElement('code');
  code.textContent = 'tm';
  hint.replaceChildren(...withInlineCode(t('dashboard.emptyHint'), 'tm', code));
  box.append(glyph, title, hint);
  return box;
}

/** Разбивает строку на узлы, заменяя первое вхождение token на codeNode. */
function withInlineCode(text: string, token: string, codeNode: HTMLElement): Node[] {
  const idx = text.indexOf(token);
  if (idx < 0) return [document.createTextNode(text)];
  return [
    document.createTextNode(text.slice(0, idx)),
    codeNode,
    document.createTextNode(text.slice(idx + token.length)),
  ];
}

/** Первый экран relay, пока идёт хендшейк с агентом: спиннер + «Подключение…». */
function connectingState(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'th-empty th-connecting';
  box.append(spinner());
  const title = document.createElement('h2');
  title.textContent = t('dashboard.connecting');
  box.append(title);
  return box;
}

function errorState(onRetry: () => void): HTMLElement {
  const box = document.createElement('div');
  box.className = 'th-empty';
  const title = document.createElement('h2');
  title.textContent = t('dashboard.reloadError');
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'th-btn';
  retry.textContent = t('common.retry');
  retry.addEventListener('click', onRetry);
  box.append(title, retry);
  return box;
}

/** Модалка создания сессии: корень, каталог, имя, пресет. В remote-режиме
 *  (transport.dirs() пуст) — ручной ввод корня и подкаталога. onCreated
 *  получает имя созданной сессии (экран терминала переходит в неё). */
/** Имя сессии для tmux: точка/двоеточие и прочие спецсимволы ломают адресацию target
 *  (session:window.pane) — оставляем только [A-Za-z0-9_-], остальное → «_», режем до 40. */
function sanitizeSessionName(name: string): string {
  return name.replace(/[^\w-]/g, '_').slice(0, 40) || 'session';
}

export function openCreateModal(transport: Transport, onCreated: (name: string) => void): void {
  openModal((close) => {
    const form = document.createElement('form');
    form.className = 'th-create';
    form.noValidate = true;

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('create.title');
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-create__body';
    body.append(spinner());

    const foot = document.createElement('div');
    foot.className = 'th-modal__foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'th-btn';
    cancel.textContent = t('common.cancel');
    cancel.addEventListener('click', close);
    const create = document.createElement('button');
    create.type = 'submit';
    create.className = 'th-btn th-btn--primary';
    create.textContent = t('create.submit');
    create.disabled = true;
    foot.append(cancel, create);

    form.append(head, body, foot);

    let preset: 'zsh' | 'claude' = 'zsh';
    // Собирает вход из текущей формы; null — форма ещё не готова/невалидна.
    let collect: (() => CreateSessionInput | null) | null = null;

    // Форма из списка каталогов (LAN): селекты корня и подкаталога.
    const buildSelectForm = (groups: DirGroup[]): void => {
      body.replaceChildren();
      const roots = groups.filter((g) => g.dirs.length > 0);
      if (roots.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'th-create__empty';
        empty.textContent = t('create.noDirs');
        body.append(empty);
        return;
      }

      const rootSelect = selectEl(roots.map((g) => g.root));
      const dirSelect = selectEl([]);
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'th-input';
      nameInput.autocomplete = 'off';

      const syncName = (): void => {
        nameInput.placeholder = sanitizeSessionName(dirSelect.value);
      };
      const syncDirs = (): void => {
        const group = roots.find((g) => g.root === rootSelect.value) ?? roots[0]!;
        dirSelect.replaceChildren(...group.dirs.map((d) => optionEl(d)));
        syncName();
      };
      rootSelect.addEventListener('change', syncDirs);
      dirSelect.addEventListener('change', syncName);

      body.append(
        field(t('create.root'), rootSelect),
        field(t('create.directory'), dirSelect),
        field(t('create.name'), nameInput),
        buildSegment((value) => (preset = value)),
      );
      syncDirs();
      collect = () => ({
        name: sanitizeSessionName(nameInput.value.trim() || dirSelect.value),
        root: rootSelect.value,
        dir: dirSelect.value,
        preset,
      });
      create.disabled = false;
      // Тело грузится асинхронно (после openModal), поэтому наводим фокус на
      // первое поле здесь — не на иконку «закрыть» в шапке.
      rootSelect.focus();
    };

    // Ручная форма (remote): текстовый ввод корня и подкаталога.
    const buildManualForm = (): void => {
      body.replaceChildren();
      const rootInput = document.createElement('input');
      rootInput.type = 'text';
      rootInput.className = 'th-input';
      rootInput.autocomplete = 'off';
      rootInput.placeholder = '/Users/me/projects';
      const dirInput = document.createElement('input');
      dirInput.type = 'text';
      dirInput.className = 'th-input';
      dirInput.autocomplete = 'off';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'th-input';
      nameInput.autocomplete = 'off';
      dirInput.addEventListener('input', () => (nameInput.placeholder = dirInput.value.trim()));

      body.append(
        field(t('create.root'), rootInput),
        field(t('create.directory'), dirInput),
        field(t('create.name'), nameInput),
        buildSegment((value) => (preset = value)),
      );
      collect = () => {
        const root = rootInput.value.trim();
        const dir = dirInput.value.trim();
        if (!root || !dir) return null;
        return { name: nameInput.value.trim() || dir, root, dir, preset };
      };
      create.disabled = false;
      // Тело грузится асинхронно (после openModal), поэтому наводим фокус на
      // первое поле здесь — не на иконку «закрыть» в шапке.
      rootInput.focus();
    };

    transport
      .dirs()
      .then((groups) => (groups.length ? buildSelectForm(groups) : buildManualForm()))
      .catch(() => {
        body.replaceChildren();
        const err = document.createElement('p');
        err.className = 'th-create__empty';
        err.textContent = t('create.error');
        body.append(err);
      });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = collect?.();
      if (!input) {
        toast(t('create.needDir'), 'error');
        return;
      }
      create.disabled = true;
      create.replaceChildren(spinner());
      try {
        await transport.create(input);
        close();
        onCreated(input.name);
      } catch (err) {
        create.disabled = false;
        create.textContent = t('create.submit');
        const message = err instanceof ApiError && err.status !== 401 && err.message ? err.message : t('create.error');
        toast(message, 'error');
      }
    });

    return form;
  });
}

/** Модалка переименования сессии: поле с текущим именем → transport.rename.
 *  Работает в обоих режимах (LAN/relay). onDone — рефреш дашборда. */
export function openRenameModal(transport: Transport, current: string, onDone: () => void): void {
  openModal((close) => {
    const form = document.createElement('form');
    form.className = 'th-create';
    form.noValidate = true;

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('rename.title');
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-create__body';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'th-input';
    input.autocomplete = 'off';
    input.value = current;
    body.append(field(t('rename.name'), input));

    const foot = document.createElement('div');
    foot.className = 'th-modal__foot';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'th-btn';
    cancel.textContent = t('common.cancel');
    cancel.addEventListener('click', close);
    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'th-btn th-btn--primary';
    submit.textContent = t('rename.submit');
    foot.append(cancel, submit);

    form.append(head, body, foot);
    // Фокус в поле (после того как openModal смонтирует форму), курсор — в конец.
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }, 0);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      // Имя нормализуем как при создании (только [A-Za-z0-9_-], ≤40).
      const next = sanitizeSessionName(input.value.trim());
      if (!next || next === current) {
        close();
        return;
      }
      submit.disabled = true;
      submit.replaceChildren(spinner());
      try {
        await transport.rename(current, next);
        close();
        onDone();
      } catch (err) {
        submit.disabled = false;
        submit.textContent = t('rename.submit');
        const message =
          err instanceof ApiError && err.status !== 401 && err.message ? err.message : t('card.renameError');
        toast(message, 'error');
      }
    });

    return form;
  });
}

function field(labelText: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'th-field';
  const span = document.createElement('span');
  span.className = 'th-field__label';
  span.textContent = labelText;
  wrap.append(span, control);
  return wrap;
}

function selectEl(values: string[]): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'th-input';
  select.replaceChildren(...values.map((v) => optionEl(v)));
  return select;
}

function optionEl(value: string): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = value;
  return opt;
}

/** Сегмент-контрол выбора пресета zsh/claude. */
function buildSegment(onChange: (value: 'zsh' | 'claude') => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'th-field';
  const label = document.createElement('span');
  label.className = 'th-field__label';
  label.textContent = t('create.preset');

  const seg = document.createElement('div');
  seg.className = 'th-segment';
  seg.setAttribute('role', 'radiogroup');
  const options: Array<{ value: 'zsh' | 'claude'; label: string }> = [
    { value: 'zsh', label: t('create.presetZsh') },
    { value: 'claude', label: t('create.presetClaude') },
  ];
  const buttons: HTMLButtonElement[] = [];
  for (const opt of options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'th-segment__btn';
    btn.textContent = opt.label;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(opt.value === 'zsh'));
    if (opt.value === 'zsh') btn.classList.add('is-active');
    if (opt.value === 'claude') btn.classList.add('th-segment__btn--claude');
    btn.addEventListener('click', () => {
      onChange(opt.value);
      for (const b of buttons) {
        const active = b === btn;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-checked', String(active));
      }
    });
    buttons.push(btn);
    seg.append(btn);
  }
  wrap.append(label, seg);
  return wrap;
}
