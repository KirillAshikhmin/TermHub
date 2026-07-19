// Хранилище CLI-клиента: собственная долговременная identity клиента
// (client-identity.json — ОТДЕЛЬНАЯ от агентской identity.json, чтобы ключи клиента
// и агента не смешивались даже на одной машине) и список известных агентов
// (known-agents.json), добавленных пейрингом. Оба файла — 0600 (writeSecretFile).
// Требует предварительного initCrypto() (libsodium) при создании identity.

import fs from 'node:fs';
import { fromB64, generateIdentity, toB64 } from '@termhub/protocol';
import type { Identity } from '@termhub/protocol';
import { clientIdentityPath, knownAgentsPath, writeSecretFile } from './paths.js';

/** Известный агент, добавленный пейрингом (для connect и показа в списке). */
export interface KnownAgent {
  /** fingerprint(agentEdPub) — он же адресат connect в relay. */
  agentId: string;
  /** Человеческое имя (задаёт пользователь при пейринге; по умолчанию — agentId). */
  name: string;
  /** Публичный ключ агента (base64) — для sessionKeys. */
  agentEdPub: string;
  /** relay, через который спарен этот агент. */
  relayUrl: string;
  addedAt: number;
}

/** Загружает identity клиента из client-identity.json, создавая её при первом обращении.
 *  Требует предварительного вызова initCrypto() (libsodium). */
export function loadClientIdentity(): Identity {
  const file = clientIdentityPath();
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { edPub: string; edSec: string };
    return {
      edPub: fromB64(raw.edPub),
      edSec: fromB64(raw.edSec),
    };
  }
  const id = generateIdentity();
  writeSecretFile(
    file,
    JSON.stringify(
      {
        edPub: toB64(id.edPub),
        edSec: toB64(id.edSec),
      },
      null,
      2,
    ),
  );
  return id;
}

/** Читает список известных агентов (новые — первыми). */
export function loadKnownAgents(): KnownAgent[] {
  const file = knownAgentsPath();
  if (!fs.existsSync(file)) return [];
  const list = JSON.parse(fs.readFileSync(file, 'utf8')) as KnownAgent[];
  return [...list].sort((a, b) => b.addedAt - a.addedAt);
}

function saveKnownAgents(list: KnownAgent[]): void {
  writeSecretFile(knownAgentsPath(), JSON.stringify(list, null, 2));
}

/** Хранилище клиента: identity + операции над списком известных агентов. */
export interface ClientStore {
  readonly identity: Identity;
  /** Список известных агентов (новые — первыми). */
  list(): KnownAgent[];
  /** Находит агента по точному agentId или по имени. */
  get(idOrName: string): KnownAgent | undefined;
  /** Добавляет/заменяет агента (дедуп по agentId). */
  add(agent: KnownAgent): void;
  /** Удаляет агента по agentId. */
  remove(agentId: string): void;
}

/** Открывает хранилище клиента, загружая (или создавая) его identity.
 *  Требует предварительного initCrypto(). */
export function loadClientStore(): ClientStore {
  const identity = loadClientIdentity();
  return {
    identity,
    list: () => loadKnownAgents(),
    get: (idOrName) => loadKnownAgents().find((a) => a.agentId === idOrName || a.name === idOrName),
    add: (agent) => {
      const current = loadKnownAgents();
      // Метка (name) — ключ `connect <метка>`. Если её уже носит ДРУГОЙ агент,
      // молча не перетираем: connect по метке стал бы неоднозначным. Предупреждаем.
      const clash = current.find((a) => a.agentId !== agent.agentId && a.name === agent.name);
      if (clash)
        console.warn(
          `[client-store] label "${agent.name}" is already used by agent ${clash.agentId}; ` +
            `"termhub connect ${agent.name}" will become ambiguous — set a unique one via --agent-label`,
        );
      const others = current.filter((a) => a.agentId !== agent.agentId);
      saveKnownAgents([...others, agent]);
    },
    remove: (agentId) => saveKnownAgents(loadKnownAgents().filter((a) => a.agentId !== agentId)),
  };
}
