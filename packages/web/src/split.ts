// Сплит-вид: до четырёх сессий рядом в одном окне (десктоп). Каждая панель — обычный
// терминал во встроенном режиме (term.ts, embedded): свой канал к агенту, без шапки с
// вкладками. Состав панелей живёт в адресе (#/split/a/b/…): смена состава — новый адрес.
import { observeBells, bellUnseen, markBellSeen } from './bell-seen';
import { resetDocumentTitle } from './document-title';
import { t } from './i18n';
import { SPLIT_MAX, splitHash, termHash } from './routes';
import { sessionAgent, sessionTitleText, sessionWorking } from './session-status';
import { AGENT_MARK } from './tabs';
import { openTermSettings } from './term-settings';
import { mountTerminal, type TerminalHandle } from './term';
import type { Transport } from './transport';
import { iconButton } from './ui';

const POLL_MS = 3000;

export function mountSplit(root: HTMLElement, sessions: string[], transport: Transport): () => void {
  root.replaceChildren();
  document.title = `TermHub — ${sessions.join(' · ')}`;

  const screen = document.createElement('div');
  screen.className = 'th-split';
  screen.dataset.panes = String(sessions.length);

  // ── Шапка: назад, добавление сессии, вид ─────────────────────────────
  const bar = document.createElement('div');
  bar.className = 'th-termbar th-splitbar';
  bar.append(iconButton('back', t('term.back'), () => (location.hash = termHash(sessions[0]!))));
  const title = document.createElement('span');
  title.className = 'th-splitbar__title';
  title.textContent = t('split.title');
  const add = document.createElement('select');
  add.className = 'th-sort__select th-splitbar__add';
  add.setAttribute('aria-label', t('split.add'));
  add.hidden = true;
  add.addEventListener('change', () => {
    if (add.value) location.hash = splitHash([...sessions, add.value]);
  });
  const viewBtn = document.createElement('button');
  viewBtn.type = 'button';
  viewBtn.className = 'th-termbar__view';
  viewBtn.textContent = 'Aa';
  viewBtn.title = t('termview.title');
  viewBtn.setAttribute('aria-label', t('termview.title'));
  viewBtn.addEventListener('click', () => openTermSettings());
  bar.append(title, add, viewBtn);
  screen.append(bar);

  // ── Панели ───────────────────────────────────────────────────────────
  const grid = document.createElement('div');
  grid.className = 'th-split__grid';
  const terms: TerminalHandle[] = [];
  const heads = new Map<string, { pane: HTMLElement; name: HTMLElement; mark: HTMLElement }>();
  for (const session of sessions) {
    const pane = document.createElement('section');
    pane.className = 'th-split__pane';
    const head = document.createElement('div');
    head.className = 'th-split__head';
    const name = document.createElement('span');
    name.className = 'th-split__name';
    name.textContent = session;
    const open = iconButton('up', t('split.openFull'), () => (location.hash = termHash(session)));
    const close = iconButton('close', t('split.closePane'), () => {
      const rest = sessions.filter((s) => s !== session);
      location.hash = rest.length > 1 ? splitHash(rest) : termHash(rest[0]!);
    });
    const mark = document.createElement('span');
    mark.className = 'th-tab__agent';
    mark.hidden = true;
    head.append(mark, name, open, close);
    const body = document.createElement('div');
    body.className = 'th-split__body';
    pane.append(head, body);
    grid.append(pane);
    heads.set(session, { pane, name, mark });
    const handle = mountTerminal(body, session, transport, { embedded: true });
    terms.push(handle);
    // Клик по заголовку панели — фокус в её терминал; заодно звонок считается прочитанным.
    head.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('button')) return;
      e.preventDefault();
      handle.focus();
    });
    pane.addEventListener('focusin', () => markBellSeen(session));
  }
  screen.append(grid);
  root.append(screen);
  terms[0]?.focus();

  // ── Опрос списка: заголовки, состояние панелей, кого ещё можно добавить ──
  let stopped = false;
  const refresh = async (): Promise<void> => {
    try {
      const list = await transport.list();
      if (stopped) return;
      observeBells(list);
      for (const s of list) {
        const head = heads.get(s.name);
        if (!head) continue;
        const text = sessionTitleText(s.title);
        head.name.textContent = text && text !== s.name ? `${text} · ${s.name}` : s.name;
        head.pane.classList.toggle('is-working', sessionWorking(s.title));
        // Звонок панели, в которой стоит фокус, прочитан: на неё и так смотрят.
        const focused = head.pane.contains(document.activeElement);
        if (focused) markBellSeen(s.name);
        head.pane.classList.toggle('has-bell', !focused && bellUnseen(s.name));
        const agent = sessionAgent(s.command);
        head.mark.hidden = !agent;
        if (agent) {
          head.pane.dataset.agent = agent;
          head.mark.textContent = AGENT_MARK[agent].letter;
          head.mark.title = AGENT_MARK[agent].name;
        } else delete head.pane.dataset.agent;
      }
      const free = list.filter((s) => !sessions.includes(s.name));
      add.hidden = sessions.length >= SPLIT_MAX || free.length === 0;
      if (!add.hidden && document.activeElement !== add) {
        add.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = t('split.add');
        add.append(placeholder);
        for (const s of free) {
          const opt = document.createElement('option');
          opt.value = s.name;
          const text = sessionTitleText(s.title);
          opt.textContent = text && text !== s.name ? `${text} · ${s.name}` : s.name;
          add.append(opt);
        }
      }
    } catch {
      // Обрыв списка панели не трогает: у каждой свой канал и своё состояние связи.
    }
  };
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refresh();
  }, POLL_MS);
  void refresh();

  return () => {
    stopped = true;
    window.clearInterval(timer);
    for (const term of terms) term.teardown();
    root.replaceChildren();
    resetDocumentTitle();
  };
}
