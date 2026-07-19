// @vitest-environment happy-dom
import 'fake-indexeddb/auto';

import { fingerprint, initCrypto } from '@termhub/protocol';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  addAgent,
  clientFingerprint,
  listAgents,
  loadClientName,
  loadIdentity,
  removeAgent,
  saveClientName,
} from '../src/keys';
import type { KnownAgent } from '../src/keys';

/** Полностью очищает базу termhub между тестами (изоляция состояния). */
function wipeDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('termhub');
    req.onsuccess = (): void => resolve();
    req.onerror = (): void => reject(req.error);
    req.onblocked = (): void => resolve();
  });
}

function agent(overrides: Partial<KnownAgent> = {}): KnownAgent {
  return { agentId: 'AAAA', name: 'Home', edPub: 'ZWRQdWI=', addedAt: 1000, ...overrides };
}

beforeAll(async () => {
  await initCrypto();
});

afterEach(async () => {
  await wipeDb();
});

describe('keys — identity', () => {
  it('создаёт identity при первом запуске и возвращает ту же при повторном', async () => {
    const first = await loadIdentity();
    expect(first.edPub.length).toBe(32);
    expect(first.edSec.length).toBe(64);

    const second = await loadIdentity();
    expect([...second.edPub]).toEqual([...first.edPub]);
    expect([...second.edSec]).toEqual([...first.edSec]);
  });

  it('clientFingerprint совпадает с fingerprint(edPub) сохранённой identity', async () => {
    const identity = await loadIdentity();
    expect(await clientFingerprint()).toBe(fingerprint(identity.edPub));
  });

  it('имя устройства по умолчанию и после сохранения', async () => {
    expect(await loadClientName()).toBe('TermHub Web');
    await saveClientName('Мой ноут');
    expect(await loadClientName()).toBe('Мой ноут');
  });
});

describe('keys — известные агенты', () => {
  it('пустой список при первом запуске', async () => {
    expect(await listAgents()).toEqual([]);
  });

  it('добавляет агента и читает его обратно', async () => {
    await addAgent(agent());
    const list = await listAgents();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ agentId: 'AAAA', name: 'Home', edPub: 'ZWRQdWI=' });
  });

  it('дедуп по agentId — повторное добавление заменяет запись', async () => {
    await addAgent(agent({ name: 'Old' }));
    await addAgent(agent({ name: 'New', addedAt: 2000 }));
    const list = await listAgents();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('New');
  });

  it('сортирует по addedAt (новые первыми)', async () => {
    await addAgent(agent({ agentId: 'OLD1', addedAt: 1000 }));
    await addAgent(agent({ agentId: 'NEW2', addedAt: 3000 }));
    await addAgent(agent({ agentId: 'MID3', addedAt: 2000 }));
    expect((await listAgents()).map((a) => a.agentId)).toEqual(['NEW2', 'MID3', 'OLD1']);
  });

  it('удаляет агента по agentId, остальных не трогает', async () => {
    await addAgent(agent({ agentId: 'KEEP', addedAt: 1000 }));
    await addAgent(agent({ agentId: 'DROP', addedAt: 2000 }));
    await removeAgent('DROP');
    expect((await listAgents()).map((a) => a.agentId)).toEqual(['KEEP']);
  });
});
