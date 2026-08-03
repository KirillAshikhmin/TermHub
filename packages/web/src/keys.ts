// Хранилище ключей remote-режима в IndexedDB (без библиотек): долговременная
// identity клиента (создаётся при первом запуске) и список известных агентов,
// добавленных пейрингом. Пул крипто (@termhub/protocol) тянет libsodium, поэтому
// модуль импортируется только в relay-режиме (динамический import из remote.ts).

import { fingerprint, generateIdentity } from '@termhub/protocol';
import type { Identity } from '@termhub/protocol';

import { b64, unb64 } from './b64';

const DB_NAME = 'termhub';
const DB_VERSION = 1;
const STORE = 'kv';
const KEY_IDENTITY = 'identity';
const KEY_NAME = 'clientName';
const KEY_AGENTS = 'agents';

/** Агент, добавленный пейрингом (для показа и переподключения). */
export interface KnownAgent {
  /** fingerprint(agentEdPub) — он же adресат connect в relay. */
  agentId: string;
  /** Человеческое название (задаёт пользователь при пейринге). */
  name: string;
  /** Публичный ключ агента (base64) — для sessionKeys. */
  edPub: string;
  addedAt: number;
  /** Адреса прямого доступа к агенту (минуя relay), которые он сам сообщил.
   *  Браузер не может найти агента в локальной сети сам, поэтому список приходит
   *  от агента по E2E-каналу и запоминается здесь для экрана выбора сервера. */
  localUrls?: string[];
  /** Когда список адресов обновлялся последний раз (для показа «данные устарели»). */
  localUrlsAt?: number;
}

/** identity клиента в сериализованном виде (base64). */
interface StoredIdentity {
  edPub: string;
  edSec: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (): void => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = (): void => resolve(req.result);
    req.onerror = (): void => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = (): void => resolve(req.result as T | undefined);
      req.onerror = (): void => reject(req.error ?? new Error('indexedDB get failed'));
    });
  } finally {
    db.close();
  }
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = (): void => resolve();
      tx.onerror = (): void => reject(tx.error ?? new Error('indexedDB put failed'));
    });
  } finally {
    db.close();
  }
}

/** Возвращает identity клиента, создавая и сохраняя её при первом запуске. */
export async function loadIdentity(): Promise<Identity> {
  const stored = await get<StoredIdentity>(KEY_IDENTITY);
  if (stored && typeof stored.edPub === 'string' && typeof stored.edSec === 'string')
    return { edPub: unb64(stored.edPub), edSec: unb64(stored.edSec) };
  const identity = generateIdentity();
  await put(KEY_IDENTITY, { edPub: b64(identity.edPub), edSec: b64(identity.edSec) } satisfies StoredIdentity);
  return identity;
}

/** Отпечаток identity клиента (для показа человеку). */
export async function clientFingerprint(): Promise<string> {
  const identity = await loadIdentity();
  return fingerprint(identity.edPub);
}

/** Имя этого устройства (шлётся агенту в hello и хранится у него как имя устройства). */
export async function loadClientName(): Promise<string> {
  const stored = await get<string>(KEY_NAME);
  if (typeof stored === 'string' && stored) return stored;
  return 'TermHub Web';
}

/** Сохраняет имя этого устройства. */
export async function saveClientName(name: string): Promise<void> {
  await put(KEY_NAME, name);
}

/** Список известных агентов (новые — первыми). */
export async function listAgents(): Promise<KnownAgent[]> {
  const agents = await get<KnownAgent[]>(KEY_AGENTS);
  if (!Array.isArray(agents)) return [];
  return [...agents].sort((a, b) => b.addedAt - a.addedAt);
}

/** Добавляет/заменяет агента (дедуп по agentId). */
export async function addAgent(agent: KnownAgent): Promise<void> {
  const agents = (await get<KnownAgent[]>(KEY_AGENTS)) ?? [];
  const others = Array.isArray(agents) ? agents.filter((a) => a.agentId !== agent.agentId) : [];
  await put(KEY_AGENTS, [...others, agent]);
}

/** Обновляет адреса прямого доступа у известного агента. Незнакомый agentId
 *  игнорируем: агент мог быть удалён, пока ответ был в полёте. */
export async function saveAgentLocalUrls(agentId: string, localUrls: string[]): Promise<void> {
  const agents = (await get<KnownAgent[]>(KEY_AGENTS)) ?? [];
  if (!Array.isArray(agents)) return;
  const found = agents.find((a) => a.agentId === agentId);
  if (!found) return;
  const others = agents.filter((a) => a.agentId !== agentId);
  await put(KEY_AGENTS, [...others, { ...found, localUrls, localUrlsAt: Date.now() }]);
}

/** Удаляет агента по agentId. */
export async function removeAgent(agentId: string): Promise<void> {
  const agents = (await get<KnownAgent[]>(KEY_AGENTS)) ?? [];
  const others = Array.isArray(agents) ? agents.filter((a) => a.agentId !== agentId) : [];
  await put(KEY_AGENTS, others);
}
