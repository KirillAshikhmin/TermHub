// Лента по имени сессии: связка «имя сессии → активная панель → агент и файл беседы →
// страница ленты». Клиент знает имя сессии, а не адрес панели, поэтому панель агент
// находит сам — своим `display-message -t '=имя:'`. Это ДРУГОЙ вызов, чем в
// `session-link.ts`: там `display-message -p` идёт без `-t`, из контекста уже подключённой
// панели, и имени сессии не знает вовсе.
//
// Чтение и только чтение: в панель не уходит ни одной команды. Ни `send-keys`, ни
// переключения экрана здесь нет и быть не может — берётся адрес активной панели, а
// дальше читается файл, который агент и так пишет на диск. Полноэкранный режим
// приложения в панели от запроса ленты не меняется ничем.
//
// Три чужих зоны ответственности и ни одной своей копии: панель называет tmux (общий
// `runTmux`), агента и файл беседы — определитель первого этапа (`resolve`), форму
// `session_meta` разбирает он же, страницу и её пределы держит `readFeed`. Причины отказа
// доезжают до клиента как есть: слова те же, что знает агент и будет знать экран.
//
// Своё здесь одно — цепочка файлов Codex: корневой поток мог быть отпочкован от другого
// (`forked_from_id`), и тогда начало беседы лежит в файле-родителе. Дойдя до начала файла,
// лента продолжается в родителе, а место склейки помечается вехой `chain`.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  codexMeta,
  resolve as resolvePane,
  CODEX_SESSIONS_DIR,
  HEAD_BYTES,
  type AgentKind,
  type CodexMeta,
  type TranscriptResult,
} from './agent-transcript.js';
import { isExistingSessionName } from './sessions.js';
import { runTmux, isNoServerError } from './tmux-run.js';
import {
  limitOf,
  readFeed,
  weigh,
  RESPONSE_LIMIT,
  type FeedEntry,
  type FeedFailure,
  type FeedOptions,
  type FeedPage,
} from './transcript-feed.js';

/** Ответ ленты: страница `readFeed` плюс `complete` и `live` — как их отдал определитель,
 *  без пересчёта. Отказ — те же причины, что у определителя, плюс `cursor-stale`. */
export type FeedResult = (FeedPage & { complete: boolean; live: boolean }) | FeedFailure;

/** Источники — единственный шов: живой tmux, живой определитель и обход каталога сессий
 *  подменяются здесь и только здесь. Файлы беседы читаются настоящей файловой системой. */
export interface SessionFeedSources {
  /** Домашний каталог: под ним лежит каталог сессий Codex. */
  home: string;
  /** Сокет tmux рабочих сессий (в проде — config.TMUX_SOCKET). */
  socketName?: string;
  /** Активная панель сессии; сессии нет — undefined, сбой обхода — исключение. */
  activePane(session: string): Promise<string | undefined>;
  /** Определитель первого этапа: какой агент в панели и где файл его беседы. */
  resolve(pane: string): Promise<TranscriptResult>;
  /** Файлы каталога сессий Codex со всеми подкаталогами: по их именам ищется родитель.
   *  Обход считаный — один на запрос и только когда лента дошла до границы файла. */
  sessionFiles(dir: string): Promise<string[]>;
}

/** Адрес активной панели сессии — ровно в том виде, в каком его ждёт определитель. */
const PANE_FORMAT = '#{session_name}:#{window_id}.#{pane_id}';
/** Что считаем адресом панели: несуществующая сессия отвечает не ошибкой, а пустыми
 *  полями («:.» при коде 0), и такой «адрес» ушёл бы определителю как настоящий. */
const PANE_RE = /^.+:@\d+\.%\d+$/;
/** Предел ожидания tmux: тот же, что у определителя на его list-panes. */
const TMUX_TIMEOUT_MS = 3000;
/** Глубина цепочки файлов Codex (§7): ограничение против цикла в чужих данных. */
const MAX_CHAIN = 10;

/** Страница ленты по имени сессии. Не бросает: любой сбой возвращается причиной отказа. */
export async function sessionFeed(
  session: string,
  opts: FeedOptions = {},
  sources?: Partial<SessionFeedSources>,
): Promise<FeedResult> {
  const src = withDefaults(sources);
  if (!isExistingSessionName(session))
    return fail('lookup-failed', `session name is not a session name: «${session}»`);
  let pane: string | undefined;
  try {
    pane = await src.activePane(session);
  } catch (err) {
    return fail('lookup-failed', `cannot ask tmux for the active pane of ${session}: ${describe(err)}`);
  }
  if (!pane) return fail('lookup-failed', `session ${session} has no active pane`);
  const found = await src.resolve(pane);
  // Причина отказа определителя доезжает как есть: те же четыре слова знает и агент, и
  // экран, и новое слово для старой причины стоило бы им обоим правки.
  if (!found.ok) return { ok: false, reason: found.reason, detail: found.detail };
  // Определитель отдаёт файлы беседы от самого раннего к текущему, и лента строится по
  // текущему: он последний. Сегодня список из одного файла, и «последний» с «единственным»
  // совпадают — опираться на совпадение значит сломаться молча, когда их станет больше.
  const file = found.files.at(-1);
  if (!file) return fail('no-transcript', `resolver named no transcript file for pane ${pane}`);
  try {
    return await pageOf(file, found.agent, opts, src, found.complete, found.live);
  } catch (err) {
    return fail('lookup-failed', `cannot read the feed of pane ${pane}: ${describe(err)}`);
  }
}

/** Страница по файлу беседы и его цепочке: читает `readFeed`, а границу файлов переходит
 *  сама. Цепочка считается лениво — она нужна только на границе. */
async function pageOf(
  file: string,
  agent: AgentKind,
  opts: FeedOptions,
  src: SessionFeedSources,
  complete: boolean,
  live: boolean,
): Promise<FeedResult> {
  const links = chainOf(file, agent, src);
  let index = 0;
  let page = await readFeed(file, agent, opts);
  if (!page.ok && page.reason === 'cursor-stale') {
    // Курсор адресует файл и место в нём, поэтому он же переносит ленту через границу
    // файлов: выданный на родителе, он и читается на родителе. `cursor-stale` остаётся
    // ровно тогда, когда такого файла нет во всей цепочке.
    const chain = await links();
    for (let i = 1; i < chain.links.length; i += 1) {
      const retry = await readFeed(chain.links[i].file, agent, opts);
      if (retry.ok || retry.reason !== 'cursor-stale') {
        page = retry;
        index = i;
        break;
      }
    }
  }
  if (!page.ok) return page;
  const entries = page.entries;
  let head = page.head;
  let bof = page.bof;
  let skipped = page.skipped;
  // Назад лента идёт через границу файлов сама: дойдя до начала файла, она продолжается
  // в родителе, и место склейки помечается вехой `chain`. Вперёд так не ходят: новые
  // записи пишутся только в текущий файл, а `after` о прошлом и не спрашивает.
  if (!forwardOnly(opts)) {
    const limit = limitOf(opts.limit);
    let bytes = heft(entries);
    while (bof && entries.length < limit && bytes < RESPONSE_LIMIT) {
      const chain = await links();
      const parent = chain.links[index + 1];
      if (!parent) break;
      const more = await readFeed(parent.file, agent, { limit: limit - entries.length });
      // Родитель нечитаем (удалён, права) — лента кончается здесь: показанное дороже
      // отказа, а начало беседы клиент и так узнаёт по `bof`.
      if (!more.ok) break;
      // Потолок ответа один на всю страницу, а не на каждый её файл. Родителя, не
      // влезшего в остаток бюджета, не режем по записям — курсор стоит на границе строки,
      // и обрезанному куску не из чего выдать `head`; он приедет следующей страницей.
      const weight = heft(more.entries);
      if (bytes + weight > RESPONSE_LIMIT) break;
      // Веху ставим, только если за ней поехали записи родителя: склейка, за которой
      // ничего нет, обещает читателю продолжение, которого в этой странице не будет.
      // Пустую страницу родителя при этом не считаем концом — концом ленты остаются
      // `bof`/`eof`: пустая страница со сдвинутым курсором значит шаг через строку, не
      // влезшую в окно, и курсор уносит клиента дальше внутрь того же файла.
      if (more.entries.length > 0) {
        entries.unshift(seam(chain.links[index].thread, entries[0], more.entries[more.entries.length - 1]));
        entries.unshift(...more.entries);
      }
      head = more.head;
      bof = more.bof;
      skipped += more.skipped;
      bytes += weight;
      index += 1;
    }
    const chain = await links();
    if (bof && index + 1 < chain.links.length) {
      // Цепочку оборвал лимит страницы или бюджет ответа, а файлы дальше есть: начала
      // беседы мы не достигли, и следующий `before` придёт уже с курсором родителя.
      bof = false;
    } else if (bof && chain.cut && entries.length > 0) {
      // Предел глубины (§7): дальше не идём совсем — `bof` останавливает клиента, а веха
      // называет причину остановки: беседа продолжается в файлах, читать которые мы
      // отказались сами. На странице без записей вехи нет: отмечать ей нечего, а
      // повторённая на каждом следующем `before`, она и стала бы той петлёй, против
      // которой предел глубины введён.
      entries.unshift(seam(chain.links[index].thread, entries[0], undefined));
    }
  }
  return {
    ok: true,
    agent,
    entries,
    head,
    tail: page.tail,
    bof,
    eof: page.eof,
    complete,
    live,
    skipped,
  };
}

function withDefaults(over?: Partial<SessionFeedSources>): SessionFeedSources {
  const home = over?.home ?? os.homedir();
  const socketName = over?.socketName;
  return {
    home,
    socketName,
    activePane: over?.activePane ?? ((session) => activePaneOf(session, socketName)),
    resolve: over?.resolve ?? ((pane) => resolvePane(pane, { home, socketName })),
    sessionFiles: over?.sessionFiles ?? sessionFilesOf,
  };
}

function fail(reason: FeedFailure['reason'], detail: string): FeedFailure {
  return { ok: false, reason, detail };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Активная панель сессии: та, куда смотрит хозяин. Запрос читающий — `display-message`
 *  ничего в панель не пишет и её содержимого не трогает.
 *
 *  Цель — `=имя:`, и двоеточие здесь обязательно: tmux (проверено на 3.7b) разбирает цель
 *  как сессию только по нему, а `=имя` ищет панель с таким именем, не находит и отвечает
 *  пустым форматом при коде 0. На живых сессиях владельца лента поэтому не отдавалась ни
 *  по одной. Пустая часть после двоеточия — текущее окно сессии и его активная панель.
 *  `=` оставляет имя точным: без него tmux берёт и однозначный префикс, и запрос мёртвой
 *  сессии молча привёл бы к беседе соседней. */
async function activePaneOf(session: string, socketName?: string): Promise<string | undefined> {
  let out: string;
  try {
    out = await runTmux(['display-message', '-p', '-t', `=${session}:`, PANE_FORMAT], {
      socketName,
      timeoutMs: TMUX_TIMEOUT_MS,
    });
  } catch (err) {
    // Сервера нет — нет и сессии; остальные сбои уходят наверх и станут lookup-failed.
    if (isNoServerError(err)) return undefined;
    throw err;
  }
  const pane = out.trim();
  return PANE_RE.test(pane) ? pane : undefined;
}

/** Запрос смотрит только вперёд: старшинство курсоров то же, что у `readFeed`. */
function forwardOnly(opts: FeedOptions): boolean {
  return opts.around === undefined && opts.before === undefined && opts.after !== undefined;
}

/** Вес куска — тем же счётом, каким его считает `readFeed` внутри страницы: иначе «1 МиБ»
 *  в двух модулях означал бы разное, а на кириллице — вдвое разное. */
function heft(entries: FeedEntry[]): number {
  return entries.reduce((n, e) => n + weigh(e), 0);
}

/** Веха склейки: стоит между последней записью родителя и первой записью потомка, чтобы
 *  разрыв во времени не читался как потеря. Слово подбирает экран — здесь только код.
 *  Идентификатор — поток потомка: он же называет и саму склейку, поэтому в обеих
 *  соседних страницах она приходит одной и той же записью. */
function seam(thread: string, next: FeedEntry | undefined, prev: FeedEntry | undefined): FeedEntry {
  return { id: `chain:${thread}`, at: next?.at ?? prev?.at ?? 0, kind: 'note', note: 'chain', text: '' };
}

/** Звено цепочки: файл и поток, который в нём записан. */
interface ChainLink {
  file: string;
  thread: string;
}

/** Цепочка и то, чем она кончилась: `cut` — упёрлись в предел глубины, а файлы дальше
 *  есть. Это не начало беседы, и наружу оно уходит вехой, а не `bof`. */
interface Chain {
  links: ChainLink[];
  cut: boolean;
}

/** Цепочка файлов от текущего к корню, считается один раз за запрос и только по нужде:
 *  на обычной странице внутри файла она не нужна вовсе. */
function chainOf(file: string, agent: AgentKind, src: SessionFeedSources): () => Promise<Chain> {
  let pending: Promise<Chain> | undefined;
  return () => (pending ??= walkChain(file, agent, src));
}

/** Родитель ищется по идентификатору потока в именах файлов `~/.codex/sessions/**`:
 *  других связей у форка нет (поля «продолжает вон ту беседу» нет ни в одном файле).
 *  Глубже MAX_CHAIN не идём — это защита от цикла в чужих данных, а не предел длины
 *  беседы. У Claude цепочки нет вовсе: продолжение и форк копируют беседу целиком (D01). */
async function walkChain(file: string, agent: AgentKind, src: SessionFeedSources): Promise<Chain> {
  const meta = agent === 'codex' ? await metaOf(file) : undefined;
  const links: ChainLink[] = [{ file, thread: meta?.thread ?? '' }];
  let forked = meta?.forkedFrom ?? '';
  let names: string[] | undefined;
  while (forked) {
    if (links.length >= MAX_CHAIN) return { links, cut: true };
    const wanted = forked;
    names ??= await src.sessionFiles(path.join(src.home, CODEX_SESSIONS_DIR));
    const candidate = names.find((name) => path.basename(name).endsWith(`-${wanted}.jsonl`));
    if (!candidate) break;
    const parent = await metaOf(candidate);
    // Имя файла — не доказательство: файл берётся, только если поток в его `session_meta`
    // тот самый, иначе цепочка ушла бы в чужую беседу с похожим именем.
    if (!parent || parent.thread !== wanted) break;
    links.push({ file: candidate, thread: parent.thread });
    forked = parent.forkedFrom;
  }
  return { links, cut: false };
}

/** Первая строка rollout'а глазами определителя: форму `session_meta` разбирает он, и
 *  второго разбора у неё быть не должно — разойдясь, они молча перестали бы находить
 *  родителя. Здесь остаётся только чтение головы файла. */
async function metaOf(file: string): Promise<CodexMeta | undefined> {
  try {
    const handle = await fsp.open(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const { bytesRead } = await handle.read(buf, 0, HEAD_BYTES, 0);
      return codexMeta(buf.subarray(0, bytesRead).toString('utf8'));
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Файлы каталога сессий Codex со всеми подкаталогами (у Codex это год/месяц/день).
 *  Каталога нет — искать негде, а не сбой. */
async function sessionFilesOf(dir: string): Promise<string[]> {
  try {
    const names = await fsp.readdir(dir, { recursive: true });
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
