// База состояния Codex (`~/.codex/state_<N>.sqlite`): таблица `threads` знает про каждый
// поток его название, рабочий каталог и файл беседы. Нужна она определителю ровно для
// одного: развести несколько клиентов Codex, работающих в одном каталоге.
//
// С версии, где Codex держит общий фоновый демон (`codex app-server`), клиент в панели —
// тонкий: файл беседы открыт у демона, один на всех. По открытым файлам и по каталогу
// панели неразличимы — а название потока клиент пишет в заголовок панели, и в базе оно же
// стоит рядом с файлом беседы.
//
// База открывается только на чтение и на один запрос, как база opencode.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Поток Codex глазами определителя. */
export interface CodexThreadRow {
  id: string;
  /** Файл беседы (rollout). */
  rolloutPath: string;
  /** Название потока — то, что клиент показывает в заголовке панели. */
  name: string;
}

/** Файл базы: `state_<N>.sqlite` с наибольшим N (номер — версия схемы). Нет ни одного —
 *  undefined: Codex здесь не работал или он старше этой базы. */
export async function codexStateDb(home: string): Promise<string | undefined> {
  const dir = path.join(home, '.codex');
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  let best: { n: number; name: string } | undefined;
  for (const name of names) {
    const m = /^state_(\d+)\.sqlite$/.exec(name);
    if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), name };
  }
  return best ? path.join(dir, best.name) : undefined;
}

/** Корневые неархивные потоки с этим рабочим каталогом. Базы нет — пустой список; схема
 *  незнакома — null (определитель тогда идёт прежним путём). Вложенные потоки (подагенты,
 *  ревью) отсекаются по `thread_source`: панель показывает беседу человека с агентом. */
export async function readCodexThreads(home: string, cwd: string): Promise<CodexThreadRow[] | null> {
  const file = await codexStateDb(home);
  if (!file) return [];
  const { DatabaseSync } = await import('node:sqlite');
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const rows = db
      .prepare(
        "select id, rollout_path as rolloutPath, coalesce(nullif(name, ''), title) as name from threads " +
          "where cwd = ? and archived = 0 and coalesce(thread_source, 'user') = 'user'",
      )
      .all(cwd) as unknown as Array<{ id: unknown; rolloutPath: unknown; name: unknown }>;
    return rows
      .filter((r) => typeof r.id === 'string' && typeof r.rolloutPath === 'string' && typeof r.name === 'string')
      .map((r) => ({ id: r.id as string, rolloutPath: r.rolloutPath as string, name: r.name as string }));
  } catch (err) {
    if (/no such (table|column)/i.test(err instanceof Error ? err.message : String(err))) return null;
    throw err;
  } finally {
    db.close();
  }
}

/** Сколько читать из начала файла проверки: поля родителя стоят в `session_meta` первыми,
 *  задолго до текста инструкций. */
const REVIEW_HEAD_BYTES = 4096;
/** Чей это файл проверки: идентификаторы беседы и родительского потока. Заголовок файла
 *  не меняется, поэтому ответ помнится навсегда. */
const reviewOwners = new Map<string, string[]>();

async function reviewOwnersOf(file: string): Promise<string[]> {
  const known = reviewOwners.get(file);
  if (known) return known;
  const handle = await fsp.open(file, 'r');
  let head: string;
  try {
    const buf = Buffer.alloc(REVIEW_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, REVIEW_HEAD_BYTES, 0);
    head = buf.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  const owners: string[] = [];
  for (const key of ['session_id', 'parent_thread_id']) {
    const m = new RegExp(`"${key}":"([^"]+)"`).exec(head);
    if (m) owners.push(m[1]);
  }
  reviewOwners.set(file, owners);
  return owners;
}

/** Файлы проверок Guardian, которые Codex запускал для потока с этим файлом беседы. Это
 *  отдельные потоки со своим расходом: в базе они с родителем не связаны (только общий
 *  каталог), связь стоит в `session_meta` самого файла проверки — `session_id` и
 *  `parent_thread_id`. Базы нет, поток в ней не найден, схема незнакома — пустой список. */
export async function codexReviewFiles(home: string, rolloutPath: string): Promise<string[]> {
  const file = await codexStateDb(home);
  if (!file) return [];
  const { DatabaseSync } = await import('node:sqlite');
  let candidates: string[];
  let id: string;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const own = db.prepare('select id, cwd from threads where rollout_path = ?').get(rolloutPath) as
      | { id: unknown; cwd: unknown }
      | undefined;
    if (!own || typeof own.id !== 'string' || typeof own.cwd !== 'string') return [];
    id = own.id;
    const rows = db
      .prepare("select rollout_path as rolloutPath from threads where cwd = ? and thread_source = 'guardian_review'")
      .all(own.cwd) as unknown as Array<{ rolloutPath: unknown }>;
    candidates = rows.map((r) => r.rolloutPath).filter((v): v is string => typeof v === 'string');
  } catch (err) {
    if (/no such (table|column)/i.test(err instanceof Error ? err.message : String(err))) return [];
    throw err;
  } finally {
    db.close();
  }
  // База чужая: файл берётся, только если он лежит в каталоге сессий Codex.
  const root = path.join(home, '.codex', 'sessions') + path.sep;
  const out: string[] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith(root) || !candidate.endsWith('.jsonl')) continue;
    try {
      if ((await reviewOwnersOf(candidate)).includes(id)) out.push(candidate);
    } catch {
      // Файл проверки мог уйти — остальные считаются без него.
    }
  }
  return out;
}
