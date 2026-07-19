// Хэш-маршруты файлового браузера (#/files/<root>/<path>). Вынесено отдельно от
// files.ts, чтобы формат hash был единым для экрана «Файлы» и для кликабельных
// путей терминала (termlinks.ts) — и без тяжёлых зависимостей (DOM/xterm).

/** Собрать hash для (root, path). */
export function filesHash(root: string, path: string): string {
  return `#/files/${encodeURIComponent(root)}/${path ? encodeURIComponent(path) : ''}`;
}

/** Собрать hash экрана «Репозиторий» для (root, path). */
export function repoHash(root: string, path: string): string {
  return `#/repo/${encodeURIComponent(root)}/${path ? encodeURIComponent(path) : ''}`;
}

/** Session-scoped проводник/репозиторий: #/sfiles|srepo/<session>/<subpath>
 *  (subpath относительно корня сессии). Пустой subpath → «/» корень. */
export function sfilesHash(session: string, path: string): string {
  return `#/sfiles/${encodeURIComponent(session)}/${path ? encodeURIComponent(path) : ''}`;
}
export function srepoHash(session: string, path: string): string {
  return `#/srepo/${encodeURIComponent(session)}/${path ? encodeURIComponent(path) : ''}`;
}

/** Подпуть из session-scoped hash; null — сегмент подпути отсутствует (открыть по
 *  умолчанию — по пути сессии). Имя сессии берётся роутером отдельно. */
export function parseSessionSub(prefix: 'sfiles' | 'srepo'): string | null {
  const m = new RegExp(`^#/${prefix}/[^/]*(?:/(.*))?$`).exec(location.hash);
  return m && m[1] !== undefined ? decodeURIComponent(m[1]) : null;
}
