// Лента opencode: страница беседы из общей базы фонового сервера (`session_message`).
// Форма ответа та же, что у файловой ленты (`readFeed`): записи от старых к новым, курсоры
// краёв, `bof`/`eof`, пределы страницы и ответа — общие, из `transcript-feed`.
//
// Курсор — `<беседа>:<seq>`. Строки беседы упорядочены `seq` (уникален в беседе, растёт, но
// идёт с пропусками), поэтому `seq` здесь — то же, что смещение строки в файле: `before`
// читает строки строго до него, `after` — начиная с него, `around` делит на «до» и «с».
// Беседа в курсоре — тот же признак, что inode у файла: курсор другой беседы панели не
// попадёт в середину чужой ленты, а получит `cursor-stale`.
//
// Ответ модели — одна строка, которая растёт, пока он пишется. Такая строка в самом конце
// беседы — то же, что недописанная строка файла: курсор остаётся перед ней, и в ленту она
// приедет целиком, когда допишется. Застрявшая посреди беседы (сервер упал на полуслове)
// уже история и читается как есть.

import type { DatabaseSync } from 'node:sqlite';
import { isSchemaError, opencodeDbExists, openOpencodeDb } from './opencode-db.js';
import {
  fromOpencode,
  limitOf,
  weigh,
  RESPONSE_LIMIT,
  type FeedEntry,
  type FeedFailure,
  type FeedOptions,
  type FeedPage,
} from './transcript-feed.js';

/** Сколько строк берётся из базы за раз: страница из сотни записей обычно укладывается в
 *  одну-две порции, а строки без записей (служебные) не заставляют ходить по одной. */
const BATCH = 100;

const LAST_SQL = 'SELECT seq, type, data, id FROM session_message WHERE session_id = ? ORDER BY seq DESC LIMIT 1';
const BACK_SQL =
  'SELECT seq, type, data, id FROM session_message WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?';
const FWD_SQL =
  'SELECT seq, type, data, id FROM session_message WHERE session_id = ? AND seq >= ? AND seq < ? ORDER BY seq ASC LIMIT ?';

/** Строка беседы, разобранная в записи ленты. */
interface Row {
  seq: number;
  entries: FeedEntry[];
  broken: boolean;
}

/** Кусок беседы в одну сторону: строки по порядку беседы и дошли ли до её края. */
interface Slice {
  rows: Row[];
  /** Строк за краем куска в эту сторону больше нет. */
  edge: boolean;
}

/** Страница беседы `session` из базы `db`. Не бросает: сбой — причина отказа. */
export async function readOpencodeFeed(
  db: string,
  session: string,
  opts: FeedOptions = {},
): Promise<FeedPage | FeedFailure> {
  try {
    if (!(await opencodeDbExists(db))) return fail('no-transcript', `no opencode database ${db}`);
  } catch (err) {
    return fail('lookup-failed', `cannot stat ${db}: ${String(err)}`);
  }
  let conn: DatabaseSync;
  try {
    conn = await openOpencodeDb(db);
  } catch (err) {
    return fail('lookup-failed', `cannot open ${db}: ${String(err)}`);
  }
  try {
    return page(conn, session, opts);
  } catch (err) {
    if (isSchemaError(err)) return fail('unknown-format', `opencode database ${db} has an unknown schema: ${String(err)}`);
    return fail('lookup-failed', `cannot read ${db}: ${String(err)}`);
  } finally {
    conn.close();
  }
}

function page(conn: DatabaseSync, session: string, opts: FeedOptions): FeedPage | FeedFailure {
  const limit = limitOf(opts.limit);
  const end = endOf(conn, session);
  const raw = opts.around ?? opts.before ?? opts.after;
  const at = raw === undefined ? end : cursorOf(raw, session, end);
  if (at === null) return fail('cursor-stale', `cursor ${raw} is not from opencode session ${session}`);
  if (opts.around !== undefined) {
    // Половина лимита до записи и половина от неё — как у файловой ленты.
    const half = Math.floor(limit / 2);
    const back = half > 0 ? take(session, backSlice(conn, session, at, half), half, true, at) : null;
    const fwd = take(session, fwdSlice(conn, session, at, end, limit - half), limit - half, false, at);
    return {
      ok: true,
      agent: 'opencode',
      entries: [...(back?.entries ?? []), ...fwd.entries],
      head: back && back.entries.length > 0 ? back.head : fwd.head,
      tail: fwd.entries.length > 0 ? fwd.tail : (back?.tail ?? fwd.tail),
      bof: back ? back.edge : !hasBefore(conn, session, at),
      eof: fwd.edge,
      skipped: (back?.skipped ?? 0) + fwd.skipped,
    };
  }
  if (opts.after !== undefined) {
    const fwd = take(session, fwdSlice(conn, session, at, end, limit), limit, false, at);
    return { ok: true, agent: 'opencode', ...fwd, bof: !hasBefore(conn, session, at), eof: fwd.edge };
  }
  // Хвост и `before` — один и тот же кусок назад: у хвоста он от границы читаемого.
  const back = take(session, backSlice(conn, session, at, limit), limit, true, at);
  return { ok: true, agent: 'opencode', ...back, bof: back.edge, eof: at >= end };
}

/** Граница читаемого: за последней строкой беседы, а если та ещё пишется — перед ней. */
function endOf(conn: DatabaseSync, session: string): number {
  const last = conn.prepare(LAST_SQL).get(session);
  if (!last) return 0;
  const row = parse(last);
  return fromOpencode(String(last.type), String(last.data), String(last.id)).pending ? row.seq : row.seq + 1;
}

function hasBefore(conn: DatabaseSync, session: string, at: number): boolean {
  return conn.prepare(BACK_SQL).all(session, at, 1).length > 0;
}

/** Курсор — `<беседа>:<seq>`. Чужая беседа, неразобранный курсор или `seq` за границей
 *  читаемого (строки откатили) — `cursor-stale`, и клиент берёт хвост заново. */
function cursorOf(raw: string, session: string, end: number): number | null {
  const parts = /^(.+):(\d+)$/.exec(raw);
  if (!parts || parts[1] !== session) return null;
  const seq = Number(parts[2]);
  return seq > end ? null : seq;
}

function cursor(session: string, seq: number): string {
  return `${session}:${seq}`;
}

/** Строки до `at`, от поздних к ранним порциями, пока не наберётся записей на страницу. */
function backSlice(conn: DatabaseSync, session: string, at: number, limit: number): Slice {
  const rows: Row[] = [];
  let bound = at;
  let count = 0;
  for (;;) {
    const batch = conn.prepare(BACK_SQL).all(session, bound, BATCH);
    for (const r of batch) {
      const row = parse(r);
      rows.unshift(row);
      count += row.entries.length;
    }
    if (batch.length < BATCH) return { rows, edge: true };
    bound = rows[0].seq;
    if (count >= limit) return { rows, edge: false };
  }
}

/** Строки с `at` и до границы читаемого, от ранних к поздним. */
function fwdSlice(conn: DatabaseSync, session: string, at: number, end: number, limit: number): Slice {
  const rows: Row[] = [];
  let from = at;
  let count = 0;
  for (;;) {
    const batch = conn.prepare(FWD_SQL).all(session, from, end, BATCH);
    for (const r of batch) {
      const row = parse(r);
      rows.push(row);
      count += row.entries.length;
    }
    if (batch.length < BATCH) return { rows, edge: true };
    from = rows[rows.length - 1].seq + 1;
    if (count >= limit) return { rows, edge: false };
  }
}

function parse(r: Record<string, unknown>): Row {
  const seq = Number(r.seq);
  const parsed = fromOpencode(String(r.type), String(r.data), String(r.id));
  return { seq, entries: parsed.entries, broken: parsed.broken };
}

/** Часть страницы из куска: обрезка по лимиту и потолку ответа, курсоры краёв. Правила
 *  файловой ленты: записи одной строки не делятся между страницами, первая строка берётся
 *  всегда, а строки без записей (служебные) курсор проходит — иначе клиент упирался бы в их
 *  полосу. `head` — первая взятая строка, `tail` — следующий за последней взятой `seq`;
 *  не взято ничего — оба курсора остаются на `at`. `edge` — дошли до края беседы в сторону
 *  чтения и взяли всё прочитанное. */
function take(
  session: string,
  slice: Slice,
  limit: number,
  fromBack: boolean,
  at: number,
): { entries: FeedEntry[]; head: string; tail: string; edge: boolean; skipped: number } {
  const rows = slice.rows;
  const step = fromBack ? -1 : 1;
  let taken = 0;
  let bytes = 0;
  let stop = fromBack ? rows.length : -1;
  for (let i = fromBack ? rows.length - 1 : 0; i >= 0 && i < rows.length; i += step) {
    const weight = rows[i].entries.reduce((n, e) => n + weigh(e), 0);
    if (taken > 0 && (taken + rows[i].entries.length > limit || bytes + weight > RESPONSE_LIMIT)) break;
    taken += rows[i].entries.length;
    bytes += weight;
    stop = i;
  }
  const kept = fromBack ? rows.slice(stop) : rows.slice(0, stop + 1);
  const entries: FeedEntry[] = [];
  let skipped = 0;
  for (const row of kept) {
    if (row.broken) skipped += 1;
    // Курсор записи — её строка: у всех записей строки он общий, как в файловой ленте.
    for (const entry of row.entries) entry.cursor = cursor(session, row.seq);
    entries.push(...row.entries);
  }
  return {
    entries,
    head: cursor(session, kept.length > 0 ? kept[0].seq : at),
    tail: cursor(session, kept.length > 0 ? kept[kept.length - 1].seq + 1 : at),
    edge: slice.edge && kept.length === rows.length,
    skipped,
  };
}

function fail(reason: FeedFailure['reason'], detail: string): FeedFailure {
  return { ok: false, reason, detail };
}
