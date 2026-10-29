// База opencode: все беседы всех каталогов лежат в одном SQLite-файле, который ведёт общий
// фоновый сервер (`opencode serve --service`). Его TUI в панели беседу на диск не пишет и
// базу открытой не держит — поэтому по открытым файлам панели, как у Codex, её не найти.
//
// Агент открывает базу только на чтение и ровно на один запрос: писать ему туда нечего, а
// долгое соединение держало бы WAL-файлы сервера дольше нужного.

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

/** Путь базы: opencode кладёт данные по XDG, по умолчанию под ~/.local/share. */
export function opencodeDbPath(home: string): string {
  const data = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(data, 'opencode', 'opencode.db');
}

/** Есть ли база. Нет файла — opencode здесь ещё ни разу не работал, это не сбой. */
export async function opencodeDbExists(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Открывает базу только на чтение. `node:sqlite` грузится лениво: модуль экспериментальный и
 *  при первом импорте пишет предупреждение в лог — платить им стоит только тем, у кого opencode. */
export async function openOpencodeDb(file: string): Promise<DatabaseSync> {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file, { readOnly: true });
}

/** Таблицы или столбца нет — база другой версии opencode, а не сбой чтения. */
export function isSchemaError(err: unknown): boolean {
  return /no such (table|column)/i.test(err instanceof Error ? err.message : String(err));
}
