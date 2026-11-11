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
