// Живая часть чата: всё, что читается с экрана агента в панели (запрос `Live`, раз в
// секунду) и что на него отвечает. Полоса состояния и «Стоп», карточка вопроса или запроса
// разрешения, режим, модель, занятость контекста с расходом, число сообщений в очереди,
// окошко живого терминала для экрана, которого чат не узнал, и плашка непроверенной версии.
// Там же — фоновая работа агента: сколько у него фоновых агентов и команд оболочки и
// список этих агентов (то, что агент сам рисует в подвале и под ним).
//
// Принцип: не узнали — молчим. На экране `unknown` и `menu` нет ни карточки, ни
// переключателей — только окошко терминала; клавиши по догадке в сессию не идут. Любое
// действие уходит вместе с отпечатком показанного вопроса (его считает агент), и если на
// экране уже другое, агент отказывает `stale`.
import type {
  ActResult,
  BackgroundAgent,
  ChatAction,
  LiveState,
  ScreenQuestion,
  ScreenState,
} from '@termhub/protocol/chat';

import { mountChatTerm, type ChatTermHandle } from './chat-term';
import { noteFailure, noteUnknown, versionNoticeDue } from './chat-health';
import { t } from './i18n';
import type { Transport } from './transport';
import { iconButton, toast } from './ui';
import { allTokens, formatElapsed, formatTokens, sessionUsage, type UsagePage } from './usage';

/** Места оболочки чата, с которыми работает живая часть (поле ввода — не её). */
export interface LiveHost {
  status: HTMLElement;
  /** Место в строке шапки переписки: состояние агента, очередь и «Стоп» встают сюда.
   *  Места нет (живая часть без переписки) — они встают в `status`. */
  head?: HTMLElement;
  /** Место в ряду кнопок шапки переписки (сразу после поиска): «Стоп» встаёт сюда.
   *  Места нет — кнопка встаёт в полосу состояния. */
  stop?: HTMLElement;
  question: HTMLElement;
  terminal: HTMLElement;
  /** Только якорь. Содержимое не трогается. */
  composer: HTMLElement;
  /** Окно терминала закрылось: `byButton` — человек закрыл его сам (кнопкой окна или
   *  «Скрыть терминал»), иначе оно свернулось после узнанного экрана. */
  onTerminalClosed?: (byButton: boolean) => void;
}

export interface LiveHandle {
  /** Последнее известное состояние экрана; null — агента нет или ответа ещё не было. */
  state(): LiveState | null;
  /** Действие в сессию. Экран из ответа применяется сразу; сеть сломалась — исключение
   *  (и «нет связи» на экране). Отказ агента — значение `{ok:false}`. */
  act(action: ChatAction): Promise<ActResult>;
  /** Перечитать экран сейчас, не дожидаясь секунды. */
  refresh(): Promise<void>;
  /** Подписка на состояния; `changed` — сменился вид экрана. Возвращает отписку. */
  subscribe(fn: StateListener): () => void;
  teardown(): void;
}

export type StateListener = (state: LiveState | null, changed: boolean) => void;

const POLL_MS = 1000;
/** Сколько кадров подряд должно разойтись с показанным, чтобы вид сменился: экран в миг
 *  перерисовки или смены состояния на один кадр читается неузнанным (и наоборот), и по
 *  одиночному кадру окно терминала открывалось и сворачивалось — интерфейс «скакал». */
const SETTLE_FRAMES = 2;
const USAGE_MS = 30_000;

type Kind = ScreenState['kind'];
const KNOWN: readonly Kind[] = ['idle', 'working', 'question', 'permission'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(cls: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Причина, по которой распознавание не узнало экран (короткая английская строка агента).
 *  Агент старше поля её не шлёт. */
function whyOf(screen: ScreenState): string | undefined {
  const why: unknown = screen.why;
  return typeof why === 'string' && why.trim() ? why.trim() : undefined;
}

/** Что показать о работающем или ждущем агенте: слово состояния (то, что рисует сам
 *  агент, иначе своё), время, токены и число ожидаемых фоновых агентов. Чего экран не дал —
 *  того в строке нет. */
function stateText(screen: ScreenState, label: string): string {
  const parts = [screen.kind === 'working' && screen.status ? screen.status : label];
  if (screen.kind === 'working') {
    if (screen.elapsed !== undefined) parts.push(formatElapsed(screen.elapsed));
    if (screen.tokens !== undefined) parts.push(t('chat.live.tokens', { n: formatTokens(screen.tokens) }));
  }
  if (screen.waiting !== undefined && (screen.kind === 'working' || screen.kind === 'idle')) {
    parts.push(t('chat.live.waiting', { n: screen.waiting }));
  }
  return parts.join(' · ');
}

/** Сколько фоновых агентов называет экран: список, а без него — число из подвала. */
function agentsOf(screen: ScreenState | undefined): number {
  return screen?.agents?.length ?? screen?.agentCount ?? 0;
}

/** Строка списка фоновых агентов: тип, задача, время и токены — только нарисованное. */
function agentRow(agent: BackgroundAgent): HTMLElement {
  const row = el('li', 'th-live__sheet-row');
  if (agent.type) row.append(el('span', 'th-live__sheet-type', agent.type));
  if (agent.task) row.append(el('span', 'th-live__sheet-task', agent.task));
  const meta: string[] = [];
  if (agent.elapsed !== undefined) meta.push(formatElapsed(agent.elapsed));
  if (agent.tokens !== undefined) meta.push(t('chat.live.tokens', { n: formatTokens(agent.tokens) }));
  if (meta.length > 0) row.append(el('span', 'th-live__sheet-meta', meta.join(' · ')));
  return row;
}

export function mountLive(host: LiveHost, session: string, transport: Transport, onState?: StateListener): LiveHandle {
  const readOnly = !!transport.clientScope && !transport.clientScope.write;
  const listeners = new Set<StateListener>();
  if (onState) listeners.add(onState);

  let state: LiveState | null = null;
  let offline = false;
  let busy = false;
  let disposed = false;
  let inflight = false;
  let usage: UsagePage | null = null;

  // ── Разметка ─────────────────────────────────────────────────────────
  const bar = el(host.head ? 'span' : 'div', 'th-live__bar');
  bar.hidden = true;
  const dot = el('span', 'th-live__dot');
  const stateEl = el('span', 'th-live__state');
  stateEl.setAttribute('role', 'status');
  const queuedEl = el('span', 'th-live__queued');
  queuedEl.hidden = true;
  const stopBtn = iconButton('stop', t('chat.live.stop'), () => void ui({ kind: 'interrupt' }));
  stopBtn.classList.add('th-feed__tool', 'th-live__stop');
  stopBtn.hidden = true;
  bar.append(dot, stateEl, queuedEl);
  if (host.stop) host.stop.append(stopBtn);
  else bar.append(stopBtn);
  (host.head ?? host.status).append(bar);

  const controls = el('div', 'th-live__controls');
  controls.hidden = true;
  const modeSel = el('select', 'th-live__mode');
  modeSel.setAttribute('aria-label', t('chat.live.mode'));
  modeSel.addEventListener('change', () => void changeMode(modeSel.value));
  const modelBtn = button('th-live__model', '', () => void changeModel());
  modelBtn.title = t('chat.live.modelChange');
  const ctxEl = el('span', 'th-live__ctx');
  const compactBtn = button('th-live__compact', t('chat.live.compact'), () => void ui({ kind: 'compact' }));
  compactBtn.title = t('chat.live.compactTitle');
  const termBtn = button('th-live__term-btn', t('chat.live.showTerm'), () => toggleTerminal());
  // Фоновая работа: на десктопе две метки, на телефоне — одна компактная (выбирает CSS).
  const agentsBtn = button('th-live__bg th-live__bg--agents', '', () => toggleSheet());
  agentsBtn.title = t('chat.live.bgOpen');
  agentsBtn.setAttribute('aria-expanded', 'false');
  agentsBtn.hidden = true;
  const shellsEl = el('span', 'th-live__bg th-live__bg--shells');
  shellsEl.hidden = true;
  const bgBtn = button('th-live__bg-compact', '', () => toggleSheet());
  bgBtn.title = t('chat.live.bgOpen');
  bgBtn.setAttribute('aria-expanded', 'false');
  bgBtn.hidden = true;
  controls.append(modeSel, modelBtn, ctxEl, agentsBtn, shellsEl, bgBtn, compactBtn, termBtn);
  // Ряд управления — над местом вопроса: карточка стоит сразу над полем ввода.
  host.question.before(controls);

  // Вопрос ждёт, но агент его не показывает: кнопка в месте вопроса, над полем ввода.
  const pendingBtn = button('th-live-q__pending', t('chat.live.pendingQuestion'), () => void showPending());
  if (readOnly) pendingBtn.title = t('chat.live.viewOnly');
  const showPending = async (): Promise<void> => {
    if (busy || readOnly) return;
    busy = true;
    render();
    try {
      const res = await act({ kind: 'show-question' });
      if (!res.ok) toast(t('chat.live.pendingFailed'), 'error');
    } catch {
      toast(t('chat.live.actFailed'), 'error');
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  // Лист со списком — в области чата (якорь .th-chat), как окно терминала: не fixed.
  const sheet = el('div', 'th-live__sheet');
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', t('chat.live.bgTitle'));
  const sheetBack = el('div', 'th-live__sheet-back');
  sheetBack.addEventListener('click', () => closeSheet());
  const sheetBox = el('div', 'th-live__sheet-box');
  const sheetHead = el('div', 'th-live__sheet-head');
  const sheetSum = el('span', 'th-live__sheet-sum');
  const sheetClose = button('th-live__sheet-close', '×', () => closeSheet());
  sheetClose.setAttribute('aria-label', t('chat.live.dismiss'));
  sheetHead.append(el('span', 'th-live__sheet-title', t('chat.live.bgTitle')), sheetSum, sheetClose);
  const sheetList = el('ul', 'th-live__sheet-list');
  const sheetNote = el('div', 'th-live__sheet-note', t('chat.live.bgNoList'));
  sheetBox.append(sheetHead, sheetList, sheetNote);
  sheet.append(sheetBack, sheetBox);
  // Рядом с рядом управления: слот поля ввода остаётся последним в оболочке.
  controls.before(sheet);

  /** Лист открыт, пока в нём были агенты: их не осталось — закрывается сам. */
  let sheetHadAgents = false;
  const onSheetKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') closeSheet();
  };
  const closeSheet = (): void => {
    if (sheet.hidden) return;
    sheet.hidden = true;
    document.removeEventListener('keydown', onSheetKey);
    agentsBtn.setAttribute('aria-expanded', 'false');
    bgBtn.setAttribute('aria-expanded', 'false');
  };
  const toggleSheet = (): void => {
    if (!sheet.hidden) return closeSheet();
    sheetHadAgents = agentsOf(state?.screen) > 0;
    sheet.hidden = false;
    document.addEventListener('keydown', onSheetKey);
    agentsBtn.setAttribute('aria-expanded', 'true');
    bgBtn.setAttribute('aria-expanded', 'true');
    syncBackground();
  };

  const syncBackground = (): void => {
    const screen = state?.screen;
    const agents = agentsOf(screen);
    const shells = screen?.shells ?? 0;
    const agentsText = agents > 0 ? t('chat.live.bgAgents', { n: agents }) : '';
    const shellsText = shells > 0 ? t('chat.live.bgShells', { n: shells }) : '';
    agentsBtn.hidden = agents <= 0;
    agentsBtn.textContent = agentsText;
    shellsEl.hidden = shells <= 0;
    shellsEl.textContent = shellsText;
    const full = [agentsText, shellsText].filter((part) => part !== '').join(', ');
    bgBtn.hidden = full === '';
    bgBtn.textContent = [
      agents > 0 ? t('chat.live.bgAgentsShort', { n: agents }) : '',
      shells > 0 ? t('chat.live.bgShellsShort', { n: shells }) : '',
    ]
      .filter((part) => part !== '')
      .join(' · ');
    bgBtn.setAttribute('aria-label', full);

    if (sheet.hidden) return;
    if (agents > 0) sheetHadAgents = true;
    if (full === '' || (sheetHadAgents && agents <= 0)) return closeSheet();
    sheetSum.textContent = full;
    sheetList.replaceChildren(...(screen?.agents ?? []).map(agentRow));
    sheetList.hidden = !screen?.agents?.length;
    sheetNote.hidden = agents <= 0 || !!screen?.agents?.length;
  };

  let manualTerm = false;
  let dismissedTerm = false;
  /** Окно сейчас закрывает сам человек (кнопкой окна или «Скрыть терминал»). */
  let closingByButton = false;
  // Эпизод неузнанного экрана: начинается, когда экран неузнан (или показывает меню)
  // SETTLE_FRAMES кадров подряд, кончается, когда он столько же кадров подряд узнан.
  // Окно открывается и сворачивается только на границах эпизода.
  let episode = false;
  /** Кадров подряд, разошедшихся с текущим видом (эпизод или нет). */
  let streak = 0;
  /** Сбой «экран не узнан» за этот эпизод уже записан. */
  let episodeNoted = false;
  /** Причина, с которой окно открыто само: одиночный узнанный кадр её не стирает. */
  let autoReason = '';
  // Закрыли кнопкой окна — то же, что «Скрыть терминал»: само окно не вернётся, пока
  // эпизод не кончится и не начнётся новый.
  const term: ChatTermHandle = mountChatTerm(host.terminal, session, transport, {
    onClose: () => {
      manualTerm = false;
      dismissedTerm = true;
      // Кнопка окна уже скрыла его сама — до `syncTerminal`.
      host.onTerminalClosed?.(true);
      syncTerminal();
    },
  });

  let notice: HTMLElement | null = null;
  const showNotice = (s: LiveState): void => {
    notice = el('div', 'th-live__notice');
    notice.setAttribute('role', 'note');
    notice.append(
      el('span', 'th-live__notice-text', t('chat.live.versionNotice', { version: s.version ?? '', agent: s.agent })),
      button('th-live__notice-close', '×', () => notice?.remove()),
    );
    notice.querySelector('.th-live__notice-close')!.setAttribute('aria-label', t('chat.live.dismiss'));
    host.status.prepend(notice);
  };

  // Карточка вопроса: пересобирается только когда сменился сам вопрос — иначе опрос
  // раз в секунду сбрасывал бы отметки и текст, который человек набирает.
  let card: HTMLElement | null = null;
  let cardKey = '';
  const cardButtons: HTMLButtonElement[] = [];
  let cardInputs: Array<HTMLInputElement | HTMLButtonElement> = [];
  const picked = new Set<string>();

  const answer = (q: ScreenQuestion, payload: { option?: string; options?: string[]; text?: string }): void =>
    void ui({ kind: 'answer', stamp: q.stamp, ...payload });

  /** Свой ответ — отдельный пункт: подпись и поле с кнопкой отправки. */
  const freeItem = (q: ScreenQuestion, label: string): HTMLElement => {
    const item = el('div', 'th-live-q__free');
    item.append(el('div', 'th-live-q__free-label', label));
    const row = el('div', 'th-live-q__free-row');
    const input = el('input', 'th-live-q__input');
    input.type = 'text';
    input.placeholder = t('chat.live.other');
    input.setAttribute('aria-label', label);
    const send = button('th-live-q__send', t('chat.live.otherSend'), () => {
      const text = input.value.trim();
      if (text) answer(q, { text });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        send.click();
      }
    });
    cardInputs.push(input, send);
    row.append(input, send);
    item.append(row);
    return item;
  };

  /** Полоса шагов серии вопросов: названия, как их рисует агент, и «N из M» по вопросам. */
  const stepsBar = (q: ScreenQuestion): HTMLElement | null => {
    const steps = q.steps;
    if (!steps || steps.length === 0) return null;
    const bar = el('div', 'th-live-q__steps');
    const questions = steps.filter((s) => !s.submit).length;
    const several = steps.length > 1 && q.step !== undefined;
    steps.forEach((s, index) => {
      const b = button('th-live-q__step', s.label, () => void ui({ kind: 'step', stamp: q.stamp, to: index + 1 }));
      if (s.done) b.classList.add('is-done');
      if (s.submit) b.classList.add('is-submit');
      if (s.current) b.setAttribute('aria-current', 'step');
      // Текущий шаг и полоса, где агент текущего не выделил, не нажимаются.
      if (several && !s.current) cardInputs.push(b);
      else b.disabled = true;
      bar.append(b);
    });
    const at = q.step === undefined ? undefined : steps[q.step - 1];
    if (questions > 1 && at && !at.submit) {
      const n = steps.slice(0, q.step).filter((s) => !s.submit).length;
      bar.append(el('span', 'th-live-q__count', t('chat.live.stepOf', { n, m: questions })));
    }
    return bar;
  };

  const buildCard = (q: ScreenQuestion): HTMLElement => {
    cardButtons.length = 0;
    cardInputs = [];
    picked.clear();
    const box = el('div', 'th-live-q');
    const bar = stepsBar(q);
    if (bar) box.append(bar);
    box.append(el('div', 'th-live-q__title', q.title));
    if (q.body) box.append(el('pre', 'th-live-q__body', q.body));
    const list = el('div', 'th-live-q__opts');
    const multi = q.multi === true;
    let hasFree = false;
    for (const o of q.options) {
      if (o.free) {
        // Свободный вариант — пункт с полем на своём месте, а не кнопка.
        hasFree = true;
        list.append(freeItem(q, o.label));
        continue;
      }
      const b = el('button', 'th-live-q__opt');
      b.type = 'button';
      b.dataset.key = o.key;
      b.append(el('span', 'th-live-q__opt-label', o.label));
      if (o.hint) b.append(el('span', 'th-live-q__opt-hint', o.hint));
      if (o.selected) b.classList.add('is-pointer');
      if (multi) {
        if (o.checked) picked.add(o.key);
        b.setAttribute('aria-pressed', String(picked.has(o.key)));
        b.addEventListener('click', () => {
          if (picked.has(o.key)) picked.delete(o.key);
          else picked.add(o.key);
          b.setAttribute('aria-pressed', String(picked.has(o.key)));
        });
      } else {
        b.addEventListener('click', () => answer(q, { option: o.key }));
      }
      cardButtons.push(b);
      list.append(b);
    }
    // Свой ответ без отдельного варианта (заметка Codex) — пунктом после вариантов.
    if (q.freeText && !hasFree && !multi) list.append(freeItem(q, t('chat.live.ownAnswer')));
    box.append(list);
    if (multi) {
      const submit = button('th-live-q__submit', t('chat.live.answer'), () =>
        answer(q, { options: q.options.filter((o) => !o.free && picked.has(o.key)).map((o) => o.key) }),
      );
      cardInputs.push(submit);
      box.append(submit);
    }
    if (readOnly) box.append(el('div', 'th-live-q__readonly', t('chat.live.viewOnly')));
    return box;
  };

  // ── Отрисовка ────────────────────────────────────────────────────────
  const needsTerminal = (k: Kind): boolean => k === 'unknown' || k === 'menu';

  /** Почему открыто окно терминала — для его шапки. */
  const termReason = (): string => {
    const screen = state?.screen;
    if (screen?.kind === 'menu') autoReason = screen.menu ? t('chat.term.whyMenu', { menu: screen.menu }) : t('chat.live.menu');
    else if (screen?.kind === 'unknown') {
      const why = whyOf(screen);
      autoReason = why ? `${t('chat.term.why')} ${why}` : t('chat.term.whyUnknown');
    }
    if (episode && autoReason) return autoReason;
    return manualTerm ? t('chat.term.whyManual') : '';
  };

  const syncTerminal = (): void => {
    const was = term.visible();
    if (manualTerm || (state && episode && !dismissedTerm)) term.show();
    else term.hide();
    if (was && !term.visible()) host.onTerminalClosed?.(closingByButton);
    closingByButton = false;
    term.setReason(termReason());
    termBtn.textContent = term.visible() ? t('chat.live.hideTerm') : t('chat.live.showTerm');
  };

  const toggleTerminal = (): void => {
    if (term.visible()) {
      manualTerm = false;
      dismissedTerm = true;
      closingByButton = true;
    } else {
      manualTerm = true;
    }
    syncTerminal();
  };

  const modelLabel = (s: LiveState): string => {
    const id = s.model ?? s.screen.model;
    if (!id) return '—';
    return s.models.find((m) => m.id === id)?.label ?? id;
  };

  const contextText = (): { text: string; hint: string } => {
    const ctx = usage?.context;
    if (!ctx) return { text: '—', hint: t('chat.live.ctxNone') };
    const main = ctx.limit ? `${Math.round((ctx.used / ctx.limit) * 100)}%` : formatTokens(ctx.used);
    const today = usage ? formatTokens(allTokens(usage.today)) : '—';
    const params = {
      used: formatTokens(ctx.used),
      limit: ctx.limit ? formatTokens(ctx.limit) : '',
      total: usage ? formatTokens(allTokens(usage.total)) : '—',
      input: usage ? formatTokens(usage.total.input) : '—',
      cached: usage ? formatTokens(usage.total.cached + usage.total.cacheWrite) : '—',
      output: usage ? formatTokens(usage.total.output) : '—',
      today,
    };
    return { text: `${main} · ${today}`, hint: t(ctx.limit ? 'chat.live.ctxHint' : 'chat.live.ctxHintNoLimit', params) };
  };

  const render = (): void => {
    const s = state;
    const kind = s?.screen.kind;
    // Полоса состояния.
    bar.hidden = !s;
    dot.className = `th-live__dot is-${offline ? 'offline' : (kind ?? 'unknown')}`;
    if (!s) {
      stateEl.textContent = '';
    } else if (offline) {
      stateEl.textContent = t('chat.live.offline');
    } else {
      const label =
        kind === 'idle' ? t('chat.live.idle')
        : kind === 'working' ? t('chat.live.working')
        : kind === 'question' || kind === 'permission' ? t('chat.live.asking')
        : kind === 'menu' ? t('chat.live.menu')
        : t('chat.live.unknown');
      stateEl.textContent = stateText(s.screen, label);
      stateEl.title = stateEl.textContent;
    }
    const queued = !offline && s?.screen.queued ? s.screen.queued : 0;
    queuedEl.hidden = queued <= 0;
    queuedEl.textContent = queued > 0 ? t('chat.live.queued', { n: queued }) : '';
    stopBtn.hidden = readOnly || kind !== 'working' || offline;
    stopBtn.disabled = busy;

    // Ряд управления: только на узнанном экране ожидания или работы.
    const idleOrWorking = kind === 'idle' || kind === 'working';
    const known = !!kind && KNOWN.includes(kind);
    controls.hidden = !s;
    const working = kind === 'working';
    const acting = readOnly || !idleOrWorking;
    modeSel.hidden = acting || !s || s.modes.length === 0;
    if (s && !modeSel.hidden) {
      if (modeSel.options.length !== s.modes.length || [...modeSel.options].some((o, i) => o.value !== s.modes[i]!.id)) {
        modeSel.replaceChildren(
          ...s.modes.map((m) => {
            const o = document.createElement('option');
            o.value = m.id;
            o.textContent = m.label;
            return o;
          }),
        );
      }
      modeSel.value = s.screen.mode ?? '';
    }
    modeSel.disabled = busy || offline;
    modelBtn.hidden = acting || !s;
    if (s) modelBtn.textContent = modelLabel(s);
    modelBtn.disabled = busy || offline || working;
    compactBtn.hidden = acting || !s;
    compactBtn.disabled = busy || offline || working;
    ctxEl.hidden = !known;
    if (known) {
      const c = contextText();
      ctxEl.textContent = `${t('chat.live.ctx')} ${c.text}`;
      ctxEl.title = c.hint;
    }
    termBtn.hidden = !s;
    syncBackground();

    // Кнопка ожидающего вопроса: пока экран о нём говорит.
    const pending = !!s && !offline && (kind === 'idle' || kind === 'working') && s.screen.pending === true;
    if (pending && !pendingBtn.isConnected) host.question.prepend(pendingBtn);
    else if (!pending) pendingBtn.remove();
    pendingBtn.disabled = readOnly || busy;

    // Карточка вопроса.
    const q = s && (kind === 'question' || kind === 'permission') ? s.screen.question : undefined;
    if (!q) {
      card?.remove();
      card = null;
      cardKey = '';
    } else {
      const key = `${kind}:${q.stamp}`;
      if (key !== cardKey) {
        card?.remove();
        card = buildCard(q);
        cardKey = key;
        host.question.append(card);
      }
      const off = readOnly || offline || busy;
      for (const b of cardButtons) b.disabled = off;
      for (const i of cardInputs) i.disabled = off;
    }
    syncTerminal();
  };

  // ── Состояние ────────────────────────────────────────────────────────
  const emit = (changed: boolean): void => {
    for (const fn of [...listeners]) fn(state, changed);
  };

  /** Новый кадр экрана. Кадр, разошедшийся с текущим видом (неузнанный вне эпизода,
   *  узнанный внутри), сначала только считается: вид меняет SETTLE_FRAMES таких подряд,
   *  а до того на экране остаётся прежнее состояние. `sure` — кадр, которого человек сам
   *  добивался (меню моделей по нажатию): ждать второго незачем. */
  const apply = (next: LiveState | null, sure = false): void => {
    const prev = state;
    const needs = !!next && needsTerminal(next.screen.kind);
    if (needs === episode) streak = 0;
    else {
      streak += 1;
      if (streak < SETTLE_FRAMES && !sure) {
        // Одиночный кадр: состояние на экране прежнее, связь при этом есть.
        if (next && offline) {
          offline = false;
          render();
        }
        return;
      }
      streak = 0;
      episode = needs;
      // Граница эпизода: закрытое кнопкой окно получает право открыться в следующем.
      dismissedTerm = false;
      episodeNoted = false;
      autoReason = '';
    }
    state = next;
    if (next) {
      offline = false;
      if (!next.tested && next.version && !notice && versionNoticeDue(next.agent, next.version)) showNotice(next);
      // Сбой — один на эпизод, а не на каждый опрос и не на одиночный кадр.
      if (episode && next.screen.kind === 'unknown' && !episodeNoted) {
        episodeNoted = true;
        noteUnknown(session, next.agent, next.version, whyOf(next.screen));
      }
      // Закончил работу — расход и контекст изменились.
      if (prev?.screen.kind === 'working' && next.screen.kind !== 'working') void loadUsage();
    }
    render();
    emit(prev?.screen.kind !== next?.screen.kind || (prev === null) !== (next === null));
  };

  const shown = (): boolean => {
    const view = host.status.closest('.th-ws-view');
    return document.visibilityState === 'visible' && (!view || view.classList.contains('is-active'));
  };

  const setOffline = (): void => {
    if (offline) return;
    offline = true;
    render();
  };

  const poll = async (): Promise<void> => {
    if (disposed || inflight) return;
    if (!usageAnswered) void loadUsage();
    inflight = true;
    try {
      const res = await transport.live(session);
      if (disposed) return;
      if (res.ok) apply(res);
      else {
        offline = false;
        apply(null);
      }
    } catch {
      if (!disposed) setOffline();
    } finally {
      inflight = false;
    }
  };

  // Расход спрашивается с первым же опросом показанного вида: чат монтируется раньше,
  // чем рабочее пространство его покажет, и ждать 30-секундного таймера нельзя. Обрыв
  // ответом не считается — следующий опрос спросит снова.
  let usageAnswered = false;
  let usageInflight = false;
  const loadUsage = async (): Promise<void> => {
    if (usageInflight) return;
    usageInflight = true;
    try {
      const res = await sessionUsage(transport, session);
      usageAnswered = true;
      if (disposed) return;
      usage = res.ok && 'total' in res ? res : null;
      render();
    } catch {
      // Расход — украшение: сбой оставляет прежние числа.
    } finally {
      usageInflight = false;
    }
  };

  const act = async (action: ChatAction): Promise<ActResult> => {
    let res: ActResult;
    try {
      res = await transport.act(session, action);
    } catch (e) {
      setOffline();
      throw e;
    }
    if (disposed) return res;
    if (res.ok) {
      // Меню моделей человек открыл сам — окно встаёт сразу, без второго кадра.
      if (state) apply({ ...state, screen: res.screen }, action.kind === 'model' && res.screen.kind === 'menu');
    } else if (res.reason === 'stale') {
      void poll();
    } else if (res.reason === 'unsupported' && state) {
      noteFailure(session, 'unsupported', state.agent, state.version);
    }
    return res;
  };

  /** Действие по нажатию: одно за раз, отказ — тостом. Возвращает ответ или null. */
  const ui = async (action: ChatAction): Promise<ActResult | null> => {
    if (busy || readOnly) return null;
    busy = true;
    render();
    try {
      const res = await act(action);
      if (!res.ok) toast(res.reason === 'stale' ? t('chat.live.stale') : res.detail || t('chat.live.actFailed'), 'error');
      return res;
    } catch {
      toast(t('chat.live.actFailed'), 'error');
      return null;
    } finally {
      busy = false;
      if (!disposed) render();
    }
  };

  const changeMode = async (to: string): Promise<void> => {
    const res = await ui({ kind: 'mode', to });
    if (res?.ok && res.screen.mode !== to && state) {
      const actual = state.modes.find((m) => m.id === res.screen.mode)?.label ?? res.screen.mode ?? '—';
      toast(t('chat.live.modeFailed', { mode: actual }), 'error');
      noteFailure(session, 'mode', state.agent, state.version);
    }
    render();
  };

  const changeModel = async (): Promise<void> => {
    // Агент открывает своё меню моделей; выбор делается в нём — в окошке терминала.
    const res = await ui({ kind: 'model', to: '' });
    if (res?.ok && res.screen.kind !== 'menu' && state) {
      toast(t('chat.live.modelNoMenu'), 'error');
      noteFailure(session, 'model', state.agent, state.version);
    }
  };

  const timer = setInterval(() => {
    if (shown()) void poll();
  }, POLL_MS);
  const usageTimer = setInterval(() => {
    if (shown()) void loadUsage();
  }, USAGE_MS);
  const onVisible = (): void => {
    if (shown()) void poll();
  };
  document.addEventListener('visibilitychange', onVisible);
  if (shown()) void poll();

  return {
    state: () => state,
    act,
    refresh: poll,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    teardown: () => {
      disposed = true;
      clearInterval(timer);
      clearInterval(usageTimer);
      document.removeEventListener('visibilitychange', onVisible);
      term.teardown();
      closeSheet();
      sheet.remove();
      controls.remove();
      pendingBtn.remove();
      bar.remove();
      notice?.remove();
      card?.remove();
    },
  };
}
