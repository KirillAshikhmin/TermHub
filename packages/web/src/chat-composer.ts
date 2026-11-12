// Поле ввода чата: многострочный запрос агенту, вложения над текстом, подсказки команд
// («/») и файлов («@»), черновик по сессии. Отправка идёт действием `prompt` через живое
// состояние чата; отправленное сразу встаёт в переписку локальной записью и заменяется
// записью транскрипта (`FeedHandle.addLocal`).
//
// Что берёт на себя это место, а что нет: поле не знает, как запрос доходит до агента
// (вставка, клавиша отправки — дело агента TermHub) и как называются экраны агента; оно
// знает три исхода — принято, отказано «в строке агента уже есть текст», отказано иначе.
import type { ActResult, ChatAction, ChatCommand } from '@termhub/protocol/chat';

import { applyCompletion, completionAt, rankCommands, type Completion } from './chat-complete';
import type { LiveHandle } from './chat-live';
import { t } from './i18n';
import type { FeedHandle, LocalMessage, LocalState } from './feed';
import { resolveSessionPath } from './session-path';
import { enterAction } from './term-keys';
import { pathForPaste } from './term-paste';
import { readTermPrefs } from './term-prefs';
import type { Transport } from './transport';
import { svgIcon, toast } from './ui';

export interface ComposerDeps {
  transport: Transport;
  live: LiveHandle;
  thread: Pick<FeedHandle, 'addLocal' | 'refresh' | 'entries'>;
}

export interface ComposerHandle {
  el: HTMLElement;
  /** `quiet` — фокус без самопоявления экранной клавиатуры на устройстве с грубым
   *  указателем (ADR 0010): поле на время стоит в `inputmode=none`, касание возвращает ввод. */
  focus(opts?: { quiet?: boolean }): void;
  setText(text: string): void;
  /** Текст поля сейчас. */
  text(): string;
  /** Подписка на любую смену текста поля (набор, вставка, очистка); возвращает отписку. */
  onText(fn: () => void): () => void;
  teardown(): void;
}

/** Предел вложения (тот же, что у агента). */
const MAX_FILE = 50 * 1024 * 1024;
/** Предел картинки через `pasteImage` (прежнее хранилище вставок). */
const MAX_IMAGE = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const DRAFT_PREFIX = 'termhub.chatDraft.';
const MAX_SUGGEST = 50;
/** Через сколько после отправки ещё раз просим приращение, если записи всё нет. */
const RECHECK_MS = 2000;
/** Сколько записей хвоста беседы просматривается, когда выясняем, дошёл ли запрос. */
const DELIVERY_TAIL = 50;

/** Запрос с ключом попытки: повтор после потерянного ответа несёт тот же ключ, и агент,
 *  уже получивший первую попытку, вторую не набирает. Агент старше ключа поле не читает. */
type PromptAction = Extract<ChatAction, { kind: 'prompt' }> & { key?: string };

function attemptKey(): string {
  try {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch {
    /* вне защищённого контекста randomUUID нет — ниже запасной путь */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Грубый указатель — телефон и планшет: только там «камера» открывает камеру, а не то
 *  же окно выбора файла, что и «прикрепить». */
function coarsePointer(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** Путь упоминания в том виде, в каком его вставляет в строку сам агент: с пробелами —
 *  в кавычках сразу за «@». */
function mention(path: string, closed: boolean): string {
  return /\s/.test(path) ? `@"${path}${closed ? '"' : ''}` : `@${path}`;
}

interface Attachment {
  id: number;
  name: string;
  image: boolean;
  /** Путь на хосте в том виде, в каком он стоит в тексте. */
  token: string;
  path: string;
  state: 'uploading' | 'done';
  thumb?: string;
  el: HTMLElement;
  cancelled: boolean;
}

interface Draft {
  text: string;
  files: Array<{ name: string; path: string; image: boolean }>;
}

interface Suggestion {
  label: string;
  hint?: string;
  badge?: string;
  value: string;
  dir?: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readDraft(key: string): Draft {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Draft> | null;
    const files = Array.isArray(raw?.files)
      ? raw.files.filter((f) => f && typeof f.path === 'string' && typeof f.name === 'string')
      : [];
    return { text: typeof raw?.text === 'string' ? raw.text : '', files: files.map((f) => ({ ...f, image: !!f.image })) };
  } catch {
    return { text: '', files: [] };
  }
}

function writeDraft(key: string, draft: Draft): void {
  try {
    if (!draft.text && draft.files.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* черновик необязателен */
  }
}

/** Слэш-команда: «/имя» в начале и дальше пробел или конец. Путь («/root/a/file.ts …»)
 *  командой не считается — после имени у него идёт слэш. */
const COMMAND_RE = /^\/[^\s/]+(?:\s|$)/;

export function mountComposer(host: HTMLElement, session: string, deps: ComposerDeps): ComposerHandle {
  const { transport, live, thread } = deps;
  const draftKey = DRAFT_PREFIX + session;
  const filesAllowed = !transport.clientScope || transport.clientScope.files;
  let disposed = false;
  let sending = false;
  let uploading = 0;
  let nextId = 1;
  const attachments: Attachment[] = [];

  // ── Разметка ─────────────────────────────────────────────────────────
  const root = el('div', 'th-composer');
  const suggestEl = el('div', 'th-composer__suggest');
  suggestEl.setAttribute('role', 'listbox');
  suggestEl.setAttribute('aria-label', t('chat.composer.suggest'));
  suggestEl.hidden = true;
  const attsEl = el('div', 'th-composer__atts');
  attsEl.hidden = true;
  const row = el('div', 'th-composer__row');
  const attachBtn = el('button', 'th-composer__btn th-composer__attach');
  attachBtn.type = 'button';
  attachBtn.title = t('chat.composer.attach');
  attachBtn.setAttribute('aria-label', t('chat.composer.attach'));
  attachBtn.append(svgIcon('paperclip'));
  // Камера — только там, где она камера (история 28а): на десктопе её кнопки нет вовсе.
  const cameraBtn = coarsePointer() ? el('button', 'th-composer__btn th-composer__camera') : null;
  if (cameraBtn) {
    cameraBtn.type = 'button';
    cameraBtn.title = t('chat.composer.camera');
    cameraBtn.setAttribute('aria-label', t('chat.composer.camera'));
    cameraBtn.append(svgIcon('camera'));
  }
  const field = el('textarea', 'th-composer__field');
  field.rows = 1;
  field.placeholder = t('chat.composer.placeholder');
  field.setAttribute('aria-label', t('chat.slot.composer'));
  field.enterKeyHint = 'send';
  const sendBtn = el('button', 'th-composer__send');
  sendBtn.type = 'button';
  sendBtn.title = t('chat.composer.send');
  sendBtn.setAttribute('aria-label', t('chat.composer.send'));
  sendBtn.append(svgIcon('up'));
  const picker = el('input', 'th-composer__file');
  picker.type = 'file';
  picker.multiple = true;
  picker.hidden = true;
  const camera = el('input', 'th-composer__file');
  camera.type = 'file';
  camera.accept = 'image/*';
  camera.setAttribute('capture', 'environment');
  camera.hidden = true;
  const dropHint = el('div', 'th-composer__drop', t('chat.composer.drop'));
  dropHint.hidden = true;
  row.append(attachBtn, ...(cameraBtn ? [cameraBtn] : []), field, sendBtn);
  root.append(suggestEl, attsEl, row, picker, camera, dropHint);
  host.append(root);

  // ── Состояние кнопки и высоты ────────────────────────────────────────
  const syncSend = (): void => {
    sendBtn.disabled = sending || uploading > 0 || field.value.trim() === '';
  };
  const fit = (): void => {
    field.style.height = 'auto';
    // Предел высоты держит CSS (max-height); дальше поле прокручивается.
    field.style.height = `${field.scrollHeight}px`;
  };
  const save = (): void => {
    writeDraft(draftKey, {
      text: field.value,
      files: attachments.filter((a) => a.state === 'done').map((a) => ({ name: a.name, path: a.path, image: a.image })),
    });
  };
  const textListeners = new Set<() => void>();
  const changed = (): void => {
    syncSend();
    fit();
    save();
    for (const fn of [...textListeners]) fn();
  };
  const setField = (text: string): void => {
    field.value = text;
    field.setSelectionRange(text.length, text.length);
    changed();
  };

  // ── Вложения ─────────────────────────────────────────────────────────
  const paintAtts = (): void => {
    attsEl.hidden = attachments.length === 0;
  };
  const buildThumb = (att: Attachment, file?: Blob): void => {
    att.el.replaceChildren();
    att.el.className = 'th-att';
    att.el.dataset.state = att.state;
    let shown = false;
    if (att.image && file && typeof URL.createObjectURL === 'function') {
      try {
        att.thumb = URL.createObjectURL(file);
        const img = el('img', 'th-att__img');
        img.src = att.thumb;
        img.alt = att.name;
        att.el.append(img);
        shown = true;
      } catch {
        /* без миниатюры — значком */
      }
    }
    if (!shown) att.el.append(svgIcon(att.image ? 'feed' : 'file'));
    att.el.append(el('span', 'th-att__name', att.name));
    if (att.state === 'uploading') {
      const bar = el('span', 'th-att__progress');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', t('chat.composer.uploading'));
      att.el.append(bar);
    }
    const rm = el('button', 'th-att__remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', t('chat.composer.remove'));
    rm.append(svgIcon('close'));
    rm.addEventListener('click', () => removeAtt(att));
    att.el.append(rm);
  };
  const forget = (att: Attachment): void => {
    const i = attachments.indexOf(att);
    if (i >= 0) attachments.splice(i, 1);
    if (att.thumb && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(att.thumb);
    att.el.remove();
    paintAtts();
  };
  /** Путь вложения стоит в тексте отдельным словом: убираем его вместе с одним пробелом. */
  const stripToken = (token: string): void => {
    const text = field.value;
    let from = -1;
    for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
      const before = at === 0 || /\s/.test(text[at - 1]!);
      const after = at + token.length >= text.length || /\s/.test(text[at + token.length]!);
      if (before && after) {
        from = at;
        break;
      }
    }
    if (from < 0) return;
    let start = from;
    let end = from + token.length;
    if (start > 0 && text[start - 1] === ' ') start -= 1;
    else if (text[end] === ' ') end += 1;
    field.value = text.slice(0, start) + text.slice(end);
  };
  const removeAtt = (att: Attachment): void => {
    att.cancelled = true;
    if (att.state === 'done') stripToken(att.token);
    forget(att);
    changed();
  };
  const appendToken = (token: string): void => {
    const text = field.value;
    field.value = text === '' || /\s$/.test(text) ? text + token : `${text} ${token}`;
  };
  const upload = async (att: Attachment, file: File): Promise<void> => {
    uploading += 1;
    syncSend();
    try {
      const asImage = IMAGE_TYPES.includes(file.type) && file.size <= MAX_IMAGE;
      const path = await (asImage ? transport.pasteImage(file) : transport.pasteFile(file, file.name || 'file'));
      if (att.cancelled || disposed) return;
      att.path = path;
      att.token = pathForPaste(path);
      att.state = 'done';
      buildThumb(att, file);
      appendToken(att.token);
    } catch (e) {
      if (att.cancelled || disposed) return;
      forget(att);
      toast(t('chat.composer.uploadFailed', { name: att.name, reason: e instanceof Error ? e.message : String(e) }), 'error');
    } finally {
      uploading -= 1;
      if (!disposed) changed();
    }
  };
  const attach = (files: File[]): void => {
    for (const file of files) {
      const name = file.name || 'file';
      if (file.size > MAX_FILE) {
        toast(t('chat.composer.tooBig', { name }), 'error');
        continue;
      }
      const att: Attachment = {
        id: nextId++,
        name,
        image: file.type.startsWith('image/'),
        token: '',
        path: '',
        state: 'uploading',
        el: el('div', 'th-att'),
        cancelled: false,
      };
      attachments.push(att);
      buildThumb(att, file);
      attsEl.append(att.el);
      paintAtts();
      void upload(att, file);
    }
  };
  // Черновик: пути прежних вложений уже в тексте, миниатюры — значками с именем.
  const draft = readDraft(draftKey);
  for (const f of draft.files) {
    const att: Attachment = {
      id: nextId++,
      name: f.name,
      image: f.image,
      token: pathForPaste(f.path),
      path: f.path,
      state: 'done',
      el: el('div', 'th-att'),
      cancelled: false,
    };
    attachments.push(att);
    buildThumb(att);
    attsEl.append(att.el);
  }
  paintAtts();
  field.value = draft.text;

  const fromInput = (input: HTMLInputElement): void => {
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length) attach(files);
  };
  picker.addEventListener('change', () => fromInput(picker));
  camera.addEventListener('change', () => fromInput(camera));
  attachBtn.addEventListener('click', () => picker.click());
  cameraBtn?.addEventListener('click', () => camera.click());

  field.addEventListener('paste', (e) => {
    const data = (e as ClipboardEvent).clipboardData;
    if (!data || data.getData('text/plain')) return;
    const files = Array.from(data.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    attach(files);
  });
  const hasFiles = (e: Event): boolean => Array.from((e as DragEvent).dataTransfer?.types ?? []).includes('Files');
  root.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dropHint.hidden = false;
  });
  root.addEventListener('dragleave', (e) => {
    if (e.target === root || e.target === dropHint) dropHint.hidden = true;
  });
  root.addEventListener('drop', (e) => {
    dropHint.hidden = true;
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    attach(files);
  });

  // ── Отправка ─────────────────────────────────────────────────────────
  const working = (): boolean => live.state()?.screen.kind === 'working';
  const restoreToField = (text: string): void => setField(field.value ? `${text}\n${field.value}` : text);
  const failText = (res: Extract<ActResult, { ok: false }>): string => res.detail || res.reason;

  // ── Очередь агента: «Изменить» и «Отменить» ─────────────────────────
  // Сообщения, принятые работающим агентом в очередь, в порядке отправки. Кнопки стоят
  // только там, куда дотягивается клавиша возврата самого агента (`screen.queueEdit`):
  // `last` — у последнего сообщения очереди, `all` — у последнего, и действуют на всю
  // очередь. Очередь агента обязана совпасть с нашими сообщениями — иначе клавиша вернула
  // бы чужое (набранное в терминале, с другого устройства), и кнопок нет.
  interface Queued {
    msg: LocalMessage;
    text: string;
    /** Что сейчас нарисовано у сообщения — чтобы не перерисовывать на каждый опрос экрана. */
    shown: string;
    /** Экран агента хоть раз показал очередь, в которую это сообщение входит. */
    seen?: boolean;
    note?: string;
  }
  const inQueue: Queued[] = [];
  const bare = (text: string): string => text.replace(/\s+/gu, '');
  /** Наше ли сообщение стоит в очереди агента: обрезанное агентом сверяется по началу. */
  const sameQueued = (drawn: { text: string; cut?: boolean }, text: string): boolean =>
    drawn.cut ? bare(text).startsWith(bare(drawn.text)) : bare(text) === bare(drawn.text);
  const syncQueue = (): void => {
    if (disposed) return;
    const screen = live.state()?.screen;
    // Экран со строкой ввода называет очередь; на прочих (вопрос, меню) её не видно.
    if (!screen || (screen.kind !== 'idle' && screen.kind !== 'working')) return;
    const drawn = screen.queue ?? [];
    // Агент забрал сообщение из очереди — оно уже запрос, а не очередь: пометка «в очереди»
    // снимается, даже если записи о нём в беседе не будет (агент пишет его не всегда).
    // Сообщение, которого экран в очереди ещё не показывал, ждёт: экран мог отстать.
    const count = Math.max(screen.queued ?? 0, drawn.length);
    if (count >= inQueue.length) for (const item of inQueue) item.seen = true;
    while (inQueue.length > count && (inQueue[0]!.seen === true || screen.kind === 'idle')) {
      inQueue.shift()!.msg.set('sent', { delivered: true });
    }
    const scope = screen.queueEdit;
    const last = inQueue[inQueue.length - 1];
    const reachable =
      scope === 'last'
        ? !!last && drawn.length > 0 && sameQueued(drawn[drawn.length - 1]!, last.text)
        : scope === 'all'
          ? drawn.length === inQueue.length && inQueue.every((item, i) => sameQueued(drawn[i]!, item.text))
          : false;
    for (const item of inQueue) {
      const mine = reachable && item === last;
      const all = mine && scope === 'all' && inQueue.length > 1;
      const key = `${mine ? (all ? 'all' : 'one') : ''}\u0000${item.note ?? ''}`;
      if (key === item.shown) continue;
      item.shown = key;
      item.msg.set('queued', {
        delivered: true,
        ...(item.note ? { note: item.note } : {}),
        actions: mine
          ? [
              { label: t(all ? 'chat.composer.queueEditAll' : 'chat.composer.queueEdit'), run: () => void unqueue(true) },
              { label: t(all ? 'chat.composer.queueCancelAll' : 'chat.composer.queueCancel'), run: () => void unqueue(false) },
            ]
          : [],
      });
    }
  };
  /** Вернуть сообщение из очереди агента: `keep` — текст встаёт в поле ввода («Изменить»),
   *  иначе сообщение просто снято («Отменить»). Строка агента в обоих случаях остаётся пустой. */
  const unqueue = async (keep: boolean): Promise<void> => {
    if (sending || disposed) return;
    const screen = live.state()?.screen;
    const scope = screen?.queueEdit;
    const last = inQueue[inQueue.length - 1];
    if (!scope || !last) return;
    sending = true;
    syncSend();
    try {
      let res: ActResult;
      try {
        res = await live.act({ kind: 'unqueue', queued: screen?.queue?.length ?? 0 });
      } catch {
        last.note = t('chat.composer.noConnection');
        return;
      }
      if (disposed) return;
      if (!res.ok) {
        last.note = t('chat.composer.unqueueFailed', { reason: failText(res) });
        return;
      }
      const gone = scope === 'all' ? inQueue.splice(0) : inQueue.splice(-1);
      for (const item of gone) item.msg.remove();
      if (keep) {
        // Свой текст точнее прочитанного с экрана: там длинная строка перенесена, а большая
        // вставка стоит заглушкой.
        restoreToField(gone.map((item) => item.text).join('\n') || (res.taken ?? ''));
        field.focus();
      }
      thread.refresh();
    } finally {
      sending = false;
      if (!disposed) {
        syncSend();
        syncQueue();
      }
    }
  };
  const offQueue = live.subscribe(() => syncQueue());

  /** Текст запроса, как его сравнивать с записью беседы: без разницы в пробелах и переносах. */
  const plain = (s: string): string => s.replace(/\s+/gu, ' ').trim();
  const humanIds = (): Set<string> => new Set(thread.entries().filter((e) => e.kind === 'human').map((e) => e.id));

  /** Дошёл ли запрос, на который не пришло ответа: свежий экран агента и хвост беседы.
   *  `known` — реплики человека, показанные до отправки: такой же давний запрос доставкой
   *  не считается. `null` — выяснить не удалось, и слать повторно вслепую нельзя. */
  const wasDelivered = async (text: string, known: Set<string>): Promise<boolean | null> => {
    try {
      await live.refresh();
      const tail = await transport.feed(session, { limit: DELIVERY_TAIL });
      if (!tail.ok) return null;
      const want = plain(text);
      return tail.entries.some((e) => {
        if (e.kind !== 'human' || known.has(e.id)) return false;
        const got = plain(e.text);
        return got === want || (e.truncated === true && got !== '' && want.startsWith(got));
      });
    } catch {
      return null;
    }
  };

  /** `unsure` — прошлая попытка осталась без ответа (таймаут, обрыв): агент мог её получить
   *  и донажать, поэтому перед повтором сверяемся с экраном и беседой. */
  const deliver = async (
    msg: LocalMessage,
    text: string,
    state: LocalState,
    over: boolean,
    unsure?: Set<string>,
    key: string = attemptKey(),
  ): Promise<void> => {
    if (sending || disposed) return;
    sending = true;
    syncSend();
    msg.set(state);
    const known = unsure ?? humanIds();
    const back = (note: string, extra: Array<{ label: string; run(): void }> = []): void =>
      msg.set('failed', {
        note,
        actions: [
          ...extra,
          // Ответ потерян — та же попытка, тот же ключ; агент отказал — запрос не уходил,
          // и повтор считается новой попыткой.
          { label: t('chat.composer.retry'), run: () => void deliver(msg, text, state, over, lost ? known : undefined, lost ? key : undefined) },
          { label: t('chat.composer.toField'), run: () => { msg.remove(); restoreToField(text); } },
        ],
      });
    // «Отправляется» живёт до ответа на act: принял — «отправлено» (у работающего агента —
    // «в очереди»). Слэш-команда может открыть меню и в переписку не попасть вовсе —
    // она становится строкой «команда отправлена» и записи транскрипта не ждёт.
    const delivered = (): void => {
      msg.set(COMMAND_RE.test(text) ? 'command' : state === 'queued' ? 'queued' : 'sent', { delivered: true });
      if (state === 'queued' && !COMMAND_RE.test(text)) {
        inQueue.push({ msg, text, shown: '' });
        syncQueue();
      }
      thread.refresh();
      window.setTimeout(() => {
        if (!disposed) thread.refresh();
      }, RECHECK_MS);
    };
    // Ответа нет — судьба запроса неизвестна; отказ агента, наоборот, значит «не отправлен».
    let lost = unsure !== undefined;
    try {
      if (unsure) {
        const arrived = await wasDelivered(text, unsure);
        if (disposed) return;
        if (arrived) return delivered();
        if (arrived === null) return back(t('chat.composer.noConnection'));
      }
      let res: ActResult;
      try {
        const action: PromptAction = over ? { kind: 'prompt', text, over: true, key } : { kind: 'prompt', text, key };
        res = await live.act(action);
      } catch {
        lost = true;
        back(t('chat.composer.noConnection'));
        return;
      }
      lost = false;
      if (res.ok) return delivered();
      if (res.reason === 'stale' && !over) {
        if (!(live.state()?.screen.input ?? '')) await live.refresh().catch(() => {});
        if (live.state()?.screen.input) {
          msg.set('failed', {
            note: t('chat.composer.agentHasText'),
            actions: [
              { label: t('chat.composer.take'), run: () => void take(msg, text, state) },
              { label: t('chat.composer.over'), run: () => void deliver(msg, text, state, true) },
              { label: t('chat.composer.toField'), run: () => { msg.remove(); restoreToField(text); } },
            ],
          });
          return;
        }
      }
      back(res.reason === 'busy' ? t('chat.composer.busy') : failText(res));
    } finally {
      sending = false;
      if (!disposed) syncSend();
    }
  };

  /** Забрать текст из строки агента в поле: его текст, затем мой (поле не пустеет — человек
   *  дописывает и отправляет вместе). */
  const take = async (msg: LocalMessage, text: string, state: LocalState): Promise<void> => {
    if (sending || disposed) return;
    sending = true;
    syncSend();
    try {
      let res: ActResult;
      try {
        res = await live.act({ kind: 'take-input' });
      } catch {
        msg.set('failed', { note: t('chat.composer.noConnection'), actions: [{ label: t('chat.composer.toField'), run: () => { msg.remove(); restoreToField(text); } }] });
        return;
      }
      if (!res.ok) {
        msg.set('failed', {
          note: res.reason === 'busy' ? t('chat.composer.busy') : failText(res),
          actions: [
            { label: t('chat.composer.retry'), run: () => void deliver(msg, text, state, false) },
            { label: t('chat.composer.toField'), run: () => { msg.remove(); restoreToField(text); } },
          ],
        });
        return;
      }
      msg.remove();
      setField([res.taken ?? '', text, field.value].filter(Boolean).join('\n'));
      field.focus();
    } finally {
      sending = false;
      if (!disposed) syncSend();
    }
  };

  const send = (): void => {
    const text = field.value.trim();
    if (!text || sending || uploading > 0) return;
    const state: LocalState = working() ? 'queued' : 'sending';
    const msg = thread.addLocal(text, state);
    for (const att of [...attachments]) forget(att);
    setField('');
    closeSuggest();
    void deliver(msg, text, state, false);
  };

  // ── Подсказки ────────────────────────────────────────────────────────
  let commands: ChatCommand[] = [];
  let commandsOk = false;
  /** Список сверен с экраном агента: просить сверку незачем. */
  let commandsVerified = false;
  let commandsRetried = false;
  let commandsLoad: Promise<void> | null = null;
  /** `verify` — просьба сверить список с экраном агента: агент наберёт «/» в своей строке
   *  ввода и пролистает список. Открытие чата её не шлёт — только первый «/» в поле. */
  const loadCommands = (verify = false): Promise<void> => {
    if (commandsLoad) return commandsLoad;
    commandsLoad = (async () => {
      try {
        const res = await (verify ? transport.commands(session, { verify: true }) : transport.commands(session));
        if (res.ok) {
          commands = res.commands;
          commandsOk = true;
          commandsVerified = res.verified;
        }
      } catch {
        /* подсказок нет, поле работает */
      }
    })().finally(() => {
      commandsLoad = null;
    });
    return commandsLoad;
  };

  let basePath: Promise<{ root: string; subpath: string } | null> | null = null;
  const listings = new Map<string, Promise<Array<{ name: string; kind: 'dir' | 'file'; hidden: boolean }>>>();
  const listDir = (base: { root: string; subpath: string }, sub: string) => {
    let hit = listings.get(sub);
    if (!hit) {
      hit = transport.filesList(base.root, sub);
      listings.set(sub, hit);
      // Ошибку не запоминаем: следующий набор спросит заново.
      hit.catch(() => listings.delete(sub));
    }
    return hit;
  };

  const fileSuggestions = async (query: string): Promise<Suggestion[]> => {
    if (!filesAllowed) return [];
    const slash = query.lastIndexOf('/');
    const dir = slash >= 0 ? query.slice(0, slash) : '';
    const prefix = (slash >= 0 ? query.slice(slash + 1) : query).toLowerCase();
    if (dir.split('/').some((p) => p === '..')) return [];
    basePath ??= resolveSessionPath(transport, session).catch(() => null);
    const base = await basePath;
    if (!base) return [];
    const sub = [base.subpath, dir].filter(Boolean).join('/');
    let entries;
    try {
      entries = await listDir(base, sub);
    } catch {
      return [];
    }
    const visible = entries.filter((e) => !e.hidden || prefix.startsWith('.'));
    const starts = visible.filter((e) => e.name.toLowerCase().startsWith(prefix));
    const inside = visible.filter((e) => !e.name.toLowerCase().startsWith(prefix) && e.name.toLowerCase().includes(prefix));
    const byKind = (a: { kind: string; name: string }, b: { kind: string; name: string }): number =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1;
    return [...starts.sort(byKind), ...inside.sort(byKind)].slice(0, MAX_SUGGEST).map((e) => ({
      label: e.kind === 'dir' ? `${e.name}/` : e.name,
      // Каталог оставляет кавычку открытой: путь ещё набирается.
      value: mention(`${dir ? `${dir}/` : ''}${e.name}${e.kind === 'dir' ? '/' : ''}`, e.kind !== 'dir'),
      dir: e.kind === 'dir',
    }));
  };

  let suggestions: Suggestion[] = [];
  let selected = 0;
  let current: Completion | null = null;
  let seq = 0;

  function closeSuggest(): void {
    seq += 1;
    suggestions = [];
    current = null;
    suggestEl.hidden = true;
    suggestEl.replaceChildren();
  }
  const paintSuggest = (): void => {
    suggestEl.replaceChildren();
    if (suggestions.length === 0) {
      suggestEl.hidden = true;
      return;
    }
    suggestions.forEach((s, i) => {
      const opt = el('div', 'th-composer__opt');
      opt.setAttribute('role', 'option');
      opt.setAttribute('aria-selected', String(i === selected));
      if (i === selected) opt.classList.add('is-selected');
      opt.append(el('span', 'th-composer__opt-name', s.label));
      if (s.hint) opt.append(el('span', 'th-composer__opt-hint', s.hint));
      if (s.badge) opt.append(el('span', 'th-composer__opt-badge', s.badge));
      // Фокус остаётся в поле: нажатие по строке не должно его забирать.
      opt.addEventListener('mousedown', (e) => e.preventDefault());
      opt.addEventListener('click', () => pick(i));
      suggestEl.append(opt);
    });
    suggestEl.hidden = false;
    suggestEl.querySelector('.is-selected')?.scrollIntoView?.({ block: 'nearest' });
  };

  async function refreshSuggest(): Promise<void> {
    const at = completionAt(field.value, field.selectionStart ?? field.value.length);
    const mine = ++seq;
    if (!at) {
      closeSuggest();
      seq = mine;
      return;
    }
    let items: Suggestion[];
    if (at.kind === 'slash') {
      if (commandsLoad) await commandsLoad;
      if (!commandsVerified && !commandsRetried) {
        // Первый «/»: список не пришёл или не сверен — просим его со сверкой, один раз.
        // Что уже есть, показывается сразу; сверенный список подменит подсказки, когда придёт.
        commandsRetried = true;
        const verified = loadCommands(true);
        if (!commandsOk) await verified;
        else void verified.then(() => {
          if (!disposed && current?.kind === 'slash') void refreshSuggest();
        });
      }
      items = rankCommands(commands, at.query)
        .slice(0, MAX_SUGGEST)
        .map((c) => ({
          label: `/${c.name}`,
          hint: c.hint,
          badge: t(`chat.composer.source.${c.source}`),
          value: `/${c.name}`,
        }));
    } else items = await fileSuggestions(at.query);
    if (mine !== seq || disposed) return;
    current = at;
    suggestions = items;
    selected = 0;
    paintSuggest();
  }

  function pick(i: number): void {
    const s = suggestions[i];
    if (!s || !current) return;
    const res = applyCompletion(field.value, current, s.value, !s.dir);
    field.value = res.text;
    field.setSelectionRange(res.caret, res.caret);
    changed();
    closeSuggest();
    field.focus();
    void refreshSuggest();
  }

  field.addEventListener('input', () => {
    changed();
    void refreshSuggest();
  });
  field.addEventListener('click', () => void refreshSuggest());
  field.addEventListener('keyup', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') void refreshSuggest();
  });
  // Тихий фокус (inputmode=none) держится до касания поля: касание возвращает обычный ввод.
  // Поле уже в фокусе — снимаем его, чтобы само касание сфокусировало заново и браузер
  // поднял клавиатуру (смену режима у сфокусированного поля замечают не все).
  const wake = (): void => {
    if (!field.hasAttribute('inputmode')) return;
    field.removeAttribute('inputmode');
    if (document.activeElement === field) field.blur();
  };
  field.addEventListener('pointerdown', wake);
  field.addEventListener('blur', () => {
    field.removeAttribute('inputmode');
    // Тап по строке снимает фокус до клика, но mousedown выше его удерживает; уход
    // фокуса куда-то ещё список закрывает.
    window.setTimeout(() => {
      if (!disposed && document.activeElement !== field) closeSuggest();
    }, 150);
  });

  field.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const open = !suggestEl.hidden && suggestions.length > 0;
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
        paintSuggest();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSuggest();
        return;
      }
      const typedWhole = current?.kind === 'slash' && suggestions[selected]?.value === `/${current.query}`;
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !typedWhole)) {
        e.preventDefault();
        pick(selected);
        return;
      }
    }
    if (e.key === 'Enter' && enterAction(e, readTermPrefs().enterSends) === 'send') {
      e.preventDefault();
      send();
    }
  });
  sendBtn.addEventListener('click', send);

  // ── Клавиатура телефона: запас снизу, чтобы поле стояло над ней ──────
  const vv = window.visualViewport;
  const onViewport = (): void => {
    if (!vv) return;
    const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    root.closest<HTMLElement>('.th-chat')?.style.setProperty('--th-kb', `${kb}px`);
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);

  syncSend();
  fit();
  void loadCommands();

  return {
    el: root,
    focus: (opts) => {
      if (opts?.quiet && coarsePointer()) field.setAttribute('inputmode', 'none');
      field.focus();
    },
    setText: (text) => setField(text),
    text: () => field.value,
    onText: (fn) => {
      textListeners.add(fn);
      return () => textListeners.delete(fn);
    },
    teardown: () => {
      disposed = true;
      offQueue();
      vv?.removeEventListener('resize', onViewport);
      vv?.removeEventListener('scroll', onViewport);
      for (const att of attachments) if (att.thumb && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(att.thumb);
      root.remove();
    },
  };
}
