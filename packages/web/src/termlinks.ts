// Кликабельные пути в веб-терминале: детект путей в выводе и мэппинг на файловый
// браузер TermHub. Чистые функции (без xterm/DOM) — тестируются отдельно;
// обвязку link-provider'а и отслеживание CWD держит term.ts.

import { filesHash } from './routes';

/** Найденный путь и его диапазон в строке (для xterm link-provider). */
export interface PathMatch {
  index: number;
  length: number;
  path: string;
}

// Сегмент пути — ASCII word + . - + @ .
const SEG = String.raw`[\w.\-+@]+`;
// Абсолютный: /a/b/c . Явно-относительный: ./x , ../x/y . Относительный с
// расширением: a/b/c.ext (минимум один «/», финальный сегмент с .ext).
const ABS = String.raw`(?:\/${SEG})+\/?`;
const DOTREL = String.raw`\.\.?(?:\/${SEG})+\/?`;
const RELEXT = String.raw`${SEG}(?:\/${SEG})*\/${SEG}\.\w{1,8}`;
// Lookbehind отсекает хвосты URL (http://host/x), «слово/слово» и «x.ext» внутри
// более длинного токена.
const PATH_RE = new RegExp(String.raw`(?<![\w:/.])(${ABS}|${DOTREL}|${RELEXT})`, 'g');

/** Находит пути (абсолютные и относительные) в строке терминала. */
export function detectPaths(line: string): PathMatch[] {
  const out: PathMatch[] = [];
  for (const m of line.matchAll(PATH_RE)) {
    // Убираем возможный завершающий «/», чтобы диапазон не включал лишнее.
    const path = m[1]!.length > 1 ? m[1]!.replace(/\/$/, '') : m[1]!;
    out.push({ index: m.index, length: path.length, path });
  }
  return out;
}

/** Нормализует cwd + относительный путь в абсолютный (схлопывает «.»/«..»). */
function resolveRelative(cwd: string, rel: string): string {
  const stack: string[] = [];
  for (const seg of `${cwd}/${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') stack.pop();
    else stack.push(seg);
  }
  return `/${stack.join('/')}`;
}

/** Путь → {корень (самый длинный префикс из roots), rel (ПОЛНЫЙ путь относительно
 *  корня)}. Относительный путь резолвится от cwd (без cwd — null). null также если
 *  путь вне всех корней. */
export function filePathParts(
  rawPath: string,
  roots: string[],
  cwd?: string,
): { root: string; rel: string } | null {
  const absPath = rawPath.startsWith('/') ? rawPath : cwd ? resolveRelative(cwd, rawPath) : null;
  if (!absPath) return null;
  const root = roots
    .filter((r) => absPath === r || absPath.startsWith(r.endsWith('/') ? r : `${r}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return null;
  const rel = absPath === root ? '' : absPath.slice(root.length).replace(/^\/+/, '');
  return { root, rel };
}

/** Родительская папка пути (rel к корню) — листинг валиден и для файла, и для папки. */
export function parentRel(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}

/** Хэш обычного файлового браузера (#/files) для пути. null — путь вне корней/без cwd. */
export function filesTargetForPath(rawPath: string, roots: string[], cwd?: string): string | null {
  const p = filePathParts(rawPath, roots, cwd);
  return p ? filesHash(p.root, parentRel(p.rel)) : null;
}
