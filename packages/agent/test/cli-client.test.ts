// CLI-клиент против НАСТОЯЩЕГО relay (startRelay) + агентского RelayLink (Task 11).
// (1) runPair: пейринг по коду — клиент сохраняет агента (метка agentLabel), агент
//     сохраняет клиента под deviceName (флаг --name). (2) connectAgent: после
//     пейринга list() отдаёт сессии реального tmux-сокета, open→write→onData содержит
//     эхо; к незарегистрированному агенту ready реджектится (не висит). (3)
//     devices/revoke: локальные операции над authorized.json агента. TTY-обёртка
//     connect (raw mode) здесь не тестируется.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { initCrypto, generateIdentity, fingerprint, type Identity } from '@termhub/protocol';
import { startRelay, type RelayHandle } from '../../relay/src/index.js';
import { RelayLink } from '../src/relay-link.js';
import { SessionService } from '../src/sessions.js';
import { saveAuthorized, loadAuthorized } from '../src/config.js';
import type { AuthorizedDevice } from '../src/config.js';
import { loadClientStore, type ClientStore } from '../src/client-store.js';
import { runPair } from '../src/pair-cmd.js';
import { connectAgent } from '../src/connect-cmd.js';
import { runDevices, runRevoke } from '../src/devices-cmd.js';

/** Доступен ли tmux (иначе connect-happy пропускается). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

const SANDBOX_SESSION = 'cliclient-sandbox';
const td = new TextDecoder();
const te = new TextEncoder();

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let agentIdentity: Identity;
let agentId: string;
let relayHandle: RelayHandle;
let relayUrl: string;
let link: RelayLink;
let sessions: SessionService;
let store: ClientStore;
let termhubDir: string;
let root: string;
const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
}

/** Ждёт, пока агент зарегистрируется на relay (connect отдаёт 'connected'). */
async function waitAgentOnline(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const ws = new WebSocket(relayUrl);
    ws.on('error', () => {});
    const online = await new Promise<boolean>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ t: 'connect', agentId })));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        try {
          resolve((JSON.parse(data.toString('utf8')) as { t?: string }).t === 'connected');
        } catch {
          resolve(false);
        }
      });
      ws.on('close', () => resolve(false));
    });
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    if (online) return;
    await delay(50);
  }
  throw new Error('агент не появился онлайн на relay');
}

/** Пейрит клиента с агентом, ретраясь на «комната ещё не открыта». */
async function pairOnce(name: string, deviceName: string): Promise<{ agent: Awaited<ReturnType<typeof runPair>>; saved: AuthorizedDevice }> {
  const p = await link.openPairing();
  await delay(150);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const agent = await runPair({ code: p.code, relayUrl, name, deviceName, store, timeoutMs: 4000 });
      const saved = await p.done;
      return { agent, saved };
    } catch (err) {
      lastErr = err;
      await delay(120);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('пейринг не удался');
}

beforeAll(async () => {
  await initCrypto();
  agentIdentity = generateIdentity();
  agentId = fingerprint(agentIdentity.edPub);

  termhubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-cliclient-'));
  process.env.TERMHUB_DIR = termhubDir;

  root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-cliclient-root-'));
  fs.mkdirSync(path.join(root, 'work'));
  if (tmuxAvailable) tmux(['new-session', '-d', '-s', SANDBOX_SESSION, '-c', path.join(root, 'work')]);

  sessions = new SessionService({ roots: [root], socketName });
  relayHandle = await startRelay({ port: 0, silent: true });
  relayUrl = `ws://127.0.0.1:${relayHandle.port}/relay`;
  link = new RelayLink({
    url: relayUrl,
    identity: agentIdentity,
    authorized: () => loadAuthorized(),
    sessions,
    socketName,
  });
  link.start();

  // Отдельная identity клиента (client-identity.json), не агентская identity.json.
  store = loadClientStore();
  await waitAgentOnline();
});

afterAll(async () => {
  await link.stop();
  await relayHandle.close();
  if (tmuxAvailable) {
    try {
      tmux(['kill-server']);
    } catch {
      /* сервер мог уже не работать */
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(termhubDir, { recursive: true, force: true });
  delete process.env.TERMHUB_DIR;
});

describe('runPair — пейринг CLI-клиента', () => {
  it('клиент сохраняет агента, агент сохраняет клиента', async () => {
    saveAuthorized([]);
    store.remove(agentId);

    const { agent, saved } = await pairOnce('my-agent', 'test-laptop');

    // Клиент сохранил агента в known-agents.
    expect(agent.agentId).toBe(agentId);
    expect(agent.name).toBe('my-agent');
    expect(agent.agentEdPub).toBe(b64(agentIdentity.edPub));
    expect(agent.relayUrl).toBe(relayUrl);
    const knownFromStore = store.get('my-agent');
    expect(knownFromStore?.agentId).toBe(agentId);

    // Агент сохранил клиента в authorized под именем устройства (deviceName ← --name),
    // а НЕ под меткой агента; отпечаток — клиентский.
    expect(saved.name).toBe('test-laptop');
    expect(saved.fingerprint).toBe(fingerprint(store.identity.edPub));
    const authorized = loadAuthorized();
    expect(authorized.some((d) => d.fingerprint === fingerprint(store.identity.edPub))).toBe(true);
  });
});

describe('connectAgent — список сессий и терминал', () => {
  it.skipIf(!tmuxAvailable)(
    'list() отдаёт сессии, open→write→onData содержит эхо',
    async () => {
      // Клиент авторизован на агенте и знает агента.
      saveAuthorized([
        {
          name: 'cli',
          edPub: b64(store.identity.edPub),
          fingerprint: fingerprint(store.identity.edPub),
          addedAt: Date.now(),
        },
      ]);
      store.add({ agentId, name: 'agent', agentEdPub: b64(agentIdentity.edPub), relayUrl, addedAt: Date.now() });

      const remote = connectAgent(store, relayUrl, agentId);
      try {
        await remote.ready;

        const list = await remote.list();
        expect(list.some((s) => s.name === SANDBOX_SESSION)).toBe(true);

        const chunks: Uint8Array[] = [];
        let closed = false;
        const term = remote.open(SANDBOX_SESSION, {
          cols: 80,
          rows: 24,
          onData: (b) => chunks.push(b),
          onClose: () => {
            closed = true;
          },
        });

        await delay(500); // дать агенту прикрепить pty к сессии
        term.write(te.encode('echo TMHMARKER\r'));

        let output = '';
        for (let i = 0; i < 100; i++) {
          output = chunks.map((c) => td.decode(c)).join('');
          if (output.includes('TMHMARKER')) break;
          await delay(50);
        }
        expect(output).toContain('TMHMARKER');
        expect(closed).toBe(false);

        term.close();
      } finally {
        remote.close();
      }
    },
    30000,
  );

  it('connectAgent на неизвестного агента бросает', () => {
    expect(() => connectAgent(store, relayUrl, 'NOSUCHAGENT')).toThrow();
  });

  it('connectAgent к незарегистрированному на relay агенту — ready реджектится, не висит', async () => {
    // Агент известен клиенту (есть в store), но НЕ подключён к relay → relay
    // отвечает {t:'error', code:'agent-offline'}. ready должен быстро отклониться
    // осмысленной ошибкой (RemoteConn рвёт сокет + таймаут установления), не зависнуть.
    const offline = generateIdentity();
    const offlineAgentId = fingerprint(offline.edPub);
    store.add({ agentId: offlineAgentId, name: 'offline', agentEdPub: b64(offline.edPub), relayUrl, addedAt: Date.now() });
    try {
      const remote = connectAgent(store, relayUrl, offlineAgentId);
      await expect(remote.ready).rejects.toThrow(/offline/);
      remote.close();
    } finally {
      store.remove(offlineAgentId);
    }
  }, 10000);
});

describe('devices / revoke — локальные операции над authorized.json', () => {
  it('runDevices отдаёт список, runRevoke удаляет по fingerprint и по имени', () => {
    const dev1: AuthorizedDevice = { name: 'laptop', edPub: 'AA==', fingerprint: 'FPR-ONE', addedAt: 1 };
    const dev2: AuthorizedDevice = { name: 'phone', edPub: 'BB==', fingerprint: 'FPR-TWO', addedAt: 2 };
    saveAuthorized([dev1, dev2]);

    expect(runDevices()).toHaveLength(2);

    // Удаление по fingerprint.
    expect(runRevoke('FPR-ONE')).toBe(true);
    expect(loadAuthorized().map((d) => d.fingerprint)).toEqual(['FPR-TWO']);

    // Удаление по имени.
    expect(runRevoke('phone')).toBe(true);
    expect(runDevices()).toHaveLength(0);

    // Несуществующее — false.
    expect(runRevoke('nope')).toBe(false);
  });
});
