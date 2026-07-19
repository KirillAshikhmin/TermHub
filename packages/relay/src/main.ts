// CLI-обёртка relay: читает PORT (дефолт 9720) и STATIC_DIR из окружения,
// поднимает сервер и логирует старт. Точка входа bin termhub-relay.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from './index.js';

const DEFAULT_PORT = 9720;

/** Резолвит каталог web-бандла: STATIC_DIR или ../static относительно dist. */
function resolveStaticDir(): string {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const staticDir = resolveStaticDir();
  const handle = await startRelay({ port, staticDir });
  console.log(`[relay] listening on :${handle.port} (static: ${staticDir})`);
}
