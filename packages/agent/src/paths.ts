// Файловые пути конфигурации агента. Все секреты живут рядом в каталоге
// $TERMHUB_DIR (для тестов) или ~/.termhub (по умолчанию).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Каталог конфигурации: $TERMHUB_DIR либо ~/.termhub. */
export function configDir(): string {
  return process.env.TERMHUB_DIR || path.join(os.homedir(), '.termhub');
}

export function configPath(): string {
  return path.join(configDir(), 'config.json');
}

export function identityPath(): string {
  return path.join(configDir(), 'identity.json');
}

export function authorizedPath(): string {
  return path.join(configDir(), 'authorized.json');
}

export function pushPath(): string {
  return path.join(configDir(), 'push.json');
}

/** Identity CLI-клиента (отдельная от агентской identity.json). */
export function clientIdentityPath(): string {
  return path.join(configDir(), 'client-identity.json');
}

/** Список известных агентов CLI-клиента. */
export function knownAgentsPath(): string {
  return path.join(configDir(), 'known-agents.json');
}

/** Гарантирует наличие каталога конфигурации с правами 0700. */
export function ensureConfigDir(): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Пишет секретный файл атомарно с правами 0600 (chmod после — на случай, если файл уже был). */
export function writeSecretFile(file: string, data: string): void {
  ensureConfigDir();
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
