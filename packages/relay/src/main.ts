// CLI-обёртка relay: читает PORT (дефолт 9720) и STATIC_DIR из окружения,
// поднимает сервер и логирует старт. Точка входа bin termhub-relay.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRelay } from './index.js';
import { startDisguiseProxy } from './disguise-port.js';

const DEFAULT_PORT = 9720;

/** Резолвит каталог web-бандла: STATIC_DIR или ../static относительно dist. */
function resolveStaticDir(): string {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'static');
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const staticDir = resolveStaticDir();
  // HOST — адрес привязки; TLS_CERT + TLS_KEY — relay сам отвечает по HTTPS (без прокси
  // перед ним: так его запускает агент на своей машине, см. local-relay.ts агента).
  const host = process.env.HOST || undefined;
  const tls =
    process.env.TLS_CERT && process.env.TLS_KEY
      ? { cert: process.env.TLS_CERT, key: process.env.TLS_KEY }
      : undefined;
  // Запущен дочерним процессом агента: не стало родителя — не нужен и relay (иначе он
  // остался бы держать порт, и следующий запуск агента свой relay не поднял бы).
  if (typeof process.send === 'function') process.on('disconnect', () => process.exit(0));
  const handle = await startRelay({ port, host, tls, staticDir });
  console.log(`[relay] listening on ${host ?? ''}:${handle.port} (${tls ? 'https' : 'http'}, static: ${staticDir})`);
  // Порт маскировки (см. disguise-port.ts): DISGUISE_PORT включает его, DISGUISE_UPSTREAM
  // говорит, куда отдавать поток после преамбулы, — по умолчанию на сам relay, но за
  // TLS-прокси нужен адрес прокси (например caddy:9443), иначе клиент придёт без TLS.
  const disguisePort = Number(process.env.DISGUISE_PORT ?? 0);
  if (disguisePort > 0) {
    const [host, portText] = (process.env.DISGUISE_UPSTREAM ?? `127.0.0.1:${handle.port}`).split(':');
    const proxy = await startDisguiseProxy({ port: disguisePort, upstreamHost: host, upstreamPort: Number(portText) });
    console.log(`[relay] disguise port :${proxy.port} → ${host}:${portText}`);
  }
}
