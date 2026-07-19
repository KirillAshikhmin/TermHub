// Слой конфигурации агента: config.json + identity.json + authorized.json.
// Секреты пишутся с правами 0600, каталог — 0700 (см. paths.ts).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { generateIdentity } from '@termhub/protocol';
import type { Identity } from '@termhub/protocol';
import {
  configDir,
  configPath,
  identityPath,
  authorizedPath,
  writeSecretFile,
} from './paths.js';

export { configDir };
export type { Identity };

// Выделенный tmux-сокет для рабочих сессий TermHub. Изолирует их от дефолтного
// сервера, чтобы случайный `tmux kill-server` (без -L) не сносил рабочие сессии.
// Единый источник имени: агент (cli.ts) и алиасы tm/tml (setup.ts) обязаны совпадать.
export const TMUX_SOCKET = 'termhub';

/** Версия TermHub (для /api/diag, doctor, About). Держим в синхроне с package.json. */
export const VERSION = '0.1.0';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;

/** Конфиг ~/.termhub/config.json (см. «Зафиксированные форматы»). */
export interface TermhubConfig {
  port: number;
  host: string;
  passwordHash: string;
  cookieSecret: string;
  sessionRoots: string[];
  /** Пути к файлам сертификата/ключа (не сам PEM-контент); null — обычный http. */
  tls: { cert: string; key: string } | null;
  relayUrl: string | null;
  vapid: { publicKey: string; privateKey: string; subject: string };
  locale: null | 'ru' | 'en';
}

/** Ограничение доступа гостевого устройства (шаринг одной сессии).
 *  Отсутствует у полнодоступных устройств. */
export interface DeviceScope {
  /** Единственная доступная сессия. */
  session: string;
  /** Разрешён ли ввод в терминал (иначе только просмотр). */
  write: boolean;
  /** Разрешён ли файловый браузер. */
  files: boolean;
}

/** Устройство, допущенное к remote-доступу (authorized.json). */
export interface AuthorizedDevice {
  name: string;
  edPub: string;
  fingerprint: string;
  addedAt: number;
  /** Ограничение доступа (гость); отсутствие — полный доступ. */
  scope?: DeviceScope;
}

/** Хеш пароля: scrypt$N$r$p$saltB64$hashB64 (node:crypto scrypt). */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const hash = crypto.scryptSync(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64'),
    hash.toString('base64'),
  ].join('$');
}

/** Проверяет пароль против хеша в постоянном времени (timingSafeEqual). */
export function verifyPassword(pw: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  // maxmem поднимаем, т.к. дефолтный лимит (32 МБ) мал для больших N из чужого хеша.
  const actual = crypto.scryptSync(pw, salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export function saveConfig(c: TermhubConfig): void {
  writeSecretFile(configPath(), JSON.stringify(c, null, 2));
}

export function loadConfig(): TermhubConfig {
  const file = configPath();
  if (!fs.existsSync(file))
    throw new Error(`Config not found (${file}). Run: termhub setup`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TermhubConfig;
}

/** Загружает identity из identity.json, создавая её при первом обращении.
 *  Требует предварительного вызова initCrypto() (libsodium). */
export function loadIdentity(): Identity {
  const file = identityPath();
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { edPub: string; edSec: string };
    return {
      edPub: new Uint8Array(Buffer.from(raw.edPub, 'base64')),
      edSec: new Uint8Array(Buffer.from(raw.edSec, 'base64')),
    };
  }
  const id = generateIdentity();
  writeSecretFile(
    file,
    JSON.stringify(
      {
        edPub: Buffer.from(id.edPub).toString('base64'),
        edSec: Buffer.from(id.edSec).toString('base64'),
      },
      null,
      2,
    ),
  );
  return id;
}

export function loadAuthorized(): AuthorizedDevice[] {
  const file = authorizedPath();
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8')) as AuthorizedDevice[];
}

export function saveAuthorized(list: AuthorizedDevice[]): void {
  writeSecretFile(authorizedPath(), JSON.stringify(list, null, 2));
}
