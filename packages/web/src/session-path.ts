// Резолв абсолютного пути сессии (session_path из tmux) в пару (корень, подпуть)
// для файлового/репозиторного браузера. Session-scoped Проводник/Репозиторий
// открываются ровно по этому пути, без выбора корня.

import type { Transport } from './transport';

/** Находит корень-whitelist, содержащий путь сессии, и подпуть внутри него.
 *  Возвращает null, если сессия не найдена или её путь вне всех корней. */
export async function resolveSessionPath(
  transport: Transport,
  name: string,
): Promise<{ root: string; subpath: string } | null> {
  const [sessions, groups] = await Promise.all([transport.list(), transport.dirs()]);
  const sess = sessions.find((s) => s.name === name);
  if (!sess) return null;
  // Самый длинный корень-префикс (корректно для вложенных корней: projects + projects/Sprut).
  let best = '';
  for (const g of groups) {
    const r = g.root;
    if ((sess.path === r || sess.path.startsWith(`${r}/`)) && r.length > best.length) best = r;
  }
  if (!best) return null;
  const subpath = sess.path === best ? '' : sess.path.slice(best.length + 1);
  return { root: best, subpath };
}
