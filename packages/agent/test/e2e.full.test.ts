// Сквозной E2E всей remote-связки: НАСТОЯЩИЙ relay (startRelay) + агентский
// RelayLink на изолированном tmux-сокете + клиентское ЯДРО из Task 13 (runPair,
// connectAgent). Ничего не мокается — гоняются реальные компоненты по localhost:
//
//   1. startRelay → агент регистрируется (RelayLink.start / openPairing).
//   2. Пейринг по коду: агент openPairing() ↔ клиент runPair() — проверяем, что
//      клиент сохранил агента, а агент — устройство (fingerprint совпадает).
//   3. connectAgent → E2E-хендшейк → list видит сессию → open → write «echo …» →
//      ждём эхо в onData → resize(100×30) → tmux подтверждает window_width=100.
//   4. Отзыв устройства (saveAuthorized([])) → повторный connect → агент отвергает
//      (ready реджектится ERROR-фреймом хендшейка).
//   5. Негатив: повторный pair тем же кодом → отказ (код одноразовый — агент его
//      уже погасил и молчит, клиент реджектится по тайм-ауту).
//
// tmux нужен для шагов 3–4 (реальный pty поверх tmux attach) — весь describe
// пропускается, если tmux недоступен.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initCrypto,
  generateIdentity,
  fingerprint,
  type Identity,
} from '@termhub/protocol';
import { startRelay, type RelayHandle } from '../../relay/src/index.js';
import { RelayLink } from '../src/relay-link.js';
import { SessionService } from '../src/sessions.js';
import { loadAuthorized, saveAuthorized } from '../src/config.js';
import { loadClientStore, type ClientStore } from '../src/client-store.js';
import { runPair, type RunPairOpts } from '../src/pair-cmd.js';
import { connectAgent } from '../src/connect-cmd.js';

/** Доступен ли tmux — иначе весь сценарий пропускается (нужен реальный pty). */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

const te = new TextEncoder();
const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Прогоняет tmux в изолированном сокете; при ошибке (нет сессии/сервера) — ''. */
function tmux(args: string[]): string {
  try {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Реджектит промис, если он не завершился за ms (страховка E2E-шагов). */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_res, rej) => {
      const t = setTimeout(() => rej(new Error(`Тайм-аут: ${label} (${ms} мс)`)), ms);
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/** runPair с ретраем ТОЛЬКО на гонку «комната ещё не открыта» (no-room).
 *  Прочие ошибки (тайм-аут, отказ агента) пробрасываются сразу — это и есть исход. */
async function pairWithRetry(opts: RunPairOpts): Promise<Awaited<ReturnType<typeof runPair>>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await runPair(opts);
    } catch (err) {
      lastErr = err;
      if (!/Комната пейринга не найдена/.test((err as Error).message)) throw err;
      await delay(100);
    }
  }
  throw lastErr;
}

// Общее состояние сценария (шаги идут последовательно и опираются друг на друга).
let agentIdentity: Identity;
let agentId: string;
let relayHandle: RelayHandle;
let relayUrl: string;
let link: RelayLink;
let sessions: SessionService;
let clientStore: ClientStore;
let termhubDir: string;
let root: string;
let firstPairCode: string;

const SESSION_NAME = 'e2e';
const ECHO_MARK = 'E2E_OK';

describe.skipIf(!tmuxAvailable)('E2E: агент ↔ relay ↔ клиент (полная связка)', () => {
  beforeAll(async () => {
    await initCrypto();

    // Единый временный TERMHUB_DIR: агент (identity/authorized) и клиент
    // (client-identity/known-agents) кладут туда СВОИ файлы (не пересекаются).
    termhubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-e2e-'));
    process.env.TERMHUB_DIR = termhubDir;

    // Корень сессий с одним подкаталогом (SessionService.create требует dir внутри root).
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-e2e-root-'));
    fs.mkdirSync(path.join(root, 'work'));

    agentIdentity = generateIdentity();
    agentId = fingerprint(agentIdentity.edPub);
    // authorized.json ещё нет → агент стартует с пустым списком устройств.

    sessions = new SessionService({ roots: [root], socketName });
    clientStore = loadClientStore();

    relayHandle = await startRelay({ port: 0, silent: true });
    relayUrl = `ws://127.0.0.1:${relayHandle.port}/relay`;

    // socketName ОБЯЗАТЕЛЕН: RelayLink пробрасывает его в attachTerminal, иначе pty
    // цеплялся бы к дефолтному tmux-серверу, а не к изолированной песочнице теста.
    link = new RelayLink({
      url: relayUrl,
      identity: agentIdentity,
      authorized: () => loadAuthorized(),
      sessions,
      socketName,
    });
    link.start();
  }, 30_000);

  afterAll(async () => {
    if (link) await link.stop();
    if (relayHandle) await relayHandle.close();
    if (tmuxAvailable) tmux(['kill-server']);
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (termhubDir) fs.rmSync(termhubDir, { recursive: true, force: true });
    delete process.env.TERMHUB_DIR;
  });

  it('1+2: агент регистрируется и пейринг по коду взаимно сохраняет клиента и агента', async () => {
    // openPairing внутри дожидается регистрации агента на relay (whenReady).
    const pairing = await withTimeout(link.openPairing(), 10_000, 'openPairing (регистрация агента)');
    firstPairCode = pairing.code;
    expect(firstPairCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Клиент проходит пейринг по коду через настоящий relay.
    const known = await withTimeout(
      pairWithRetry({ code: firstPairCode, relayUrl, name: 'e2e-agent', deviceName: 'e2e-client', store: clientStore }),
      20_000,
      'runPair',
    );
    const device = await withTimeout(pairing.done, 10_000, 'agent pairing.done');

    // agentId выведен из edPub агента — совпадает с тем, что сохранил клиент.
    expect(known.agentId).toBe(agentId);

    // Клиент сохранил агента в known-agents.json.
    const storedAgent = clientStore.get(agentId);
    expect(storedAgent).toBeDefined();
    expect(storedAgent!.agentEdPub).toBe(Buffer.from(agentIdentity.edPub).toString('base64'));

    // Агент сохранил устройство клиента в authorized.json (fingerprint совпадает).
    const clientFp = fingerprint(clientStore.identity.edPub);
    expect(device.fingerprint).toBe(clientFp);
    const authorized = loadAuthorized();
    expect(authorized.some((d) => d.fingerprint === clientFp)).toBe(true);
    expect(authorized.find((d) => d.fingerprint === clientFp)!.name).toBe('e2e-client');
  }, 40_000);

  it('3: connect → list видит сессию → open/write эхо → resize(100×30) подтверждён tmux', async () => {
    // Сессию создаём напрямую через SessionService (RemoteAgent из Task 13 не имеет
    // create-операции) — тот же сервис, что обслуживает LIST/OPEN у RelayLink.
    await sessions.create({ name: SESSION_NAME, root, dir: 'work', preset: 'zsh' });
    // Детерминируем реакцию окна на resize клиента.
    tmux(['set', '-g', 'window-size', 'latest']);

    const remote = connectAgent(clientStore, relayUrl, agentId);
    await withTimeout(remote.ready, 20_000, 'remote.ready (E2E-хендшейк)');

    // LIST через зашифрованный поток должен показать нашу сессию.
    const list = await withTimeout(remote.list(), 15_000, 'remote.list');
    expect(list.some((s) => s.name === SESSION_NAME)).toBe(true);

    // OPEN на 80×24, затем гоним echo и ждём метку в onData.
    let output = '';
    let resolveEcho!: () => void;
    const echoSeen = new Promise<void>((r) => {
      resolveEcho = r;
    });
    const dec = new TextDecoder();
    const term = remote.open(SESSION_NAME, {
      cols: 80,
      rows: 24,
      onData: (bytes) => {
        output += dec.decode(bytes, { stream: true });
        if (output.includes(ECHO_MARK)) resolveEcho();
      },
      onClose: () => {},
    });

    // Первый write — после короткой паузы (даём zsh подняться); при необходимости
    // повторяем, пока метка не появится или не выйдет общий тайм-аут шага.
    let echoDone = false;
    void echoSeen.then(() => {
      echoDone = true;
    });
    await delay(500);
    for (let i = 0; i < 8 && !echoDone; i += 1) {
      term.write(te.encode(`echo ${ECHO_MARK}\r`));
      await Promise.race([echoSeen, delay(1000)]);
    }
    await withTimeout(echoSeen, 5000, 'эхо E2E_OK в onData');
    expect(output).toContain(ECHO_MARK);

    // RESIZE 100×30 → tmux (единственный attached pty, window-size latest) → ширина окна 100.
    // Читаем через list-windows: он берёт размер из объекта окна и, в отличие от
    // `display -t =session`, не требует клиентского контекста у самой команды.
    // Проверяем ширину (как в брифе): высота окна на 1 меньше запрошенной (30→29) из-за
    // строки статуса tmux, поэтому её жёстко не фиксируем.
    term.resize(100, 30);
    let width = '';
    for (let i = 0; i < 50; i += 1) {
      width = tmux(['list-windows', '-t', `=${SESSION_NAME}`, '-F', '#{window_width}']);
      if (width === '100') break;
      await delay(100);
    }
    expect(width).toBe('100');

    term.close();
    remote.close();
  }, 60_000);

  it('4: отзыв устройства → повторный connect отвергается агентом (ERROR-хендшейк)', async () => {
    // Отзыв: authorized становится пустым — агент больше не знает это устройство.
    saveAuthorized([]);
    expect(loadAuthorized()).toEqual([]);

    const remote = connectAgent(clientStore, relayUrl, agentId);
    // Агент на hello незнакомца шлёт plaintext ERROR-фрейм → RemoteConn реджектит ready.
    await expect(withTimeout(remote.ready, 20_000, 'revoked remote.ready')).rejects.toThrow(/rejected the device|not authorized/i);
    remote.close();
  }, 30_000);

  it('5: повторный пейринг тем же кодом отвергается (код одноразовый)', async () => {
    // Агент уже погасил пейринг из шага 2 (this.pairing settled) и на новый hello по
    // тому же коду не отвечает — клиент реджектится по тайм-ауту. Ретрая тут нет
    // (ошибка — не no-room), короткий тайм-аут делает проверку быстрой.
    await expect(
      pairWithRetry({ code: firstPairCode, relayUrl, name: 'e2e-agent', deviceName: 'e2e-again', store: clientStore, timeoutMs: 3000 }),
    ).rejects.toThrow();

    // Отзыв из шага 4 в силе: повторный пейринг ничего не дописал в authorized.
    expect(loadAuthorized()).toEqual([]);
  }, 20_000);

  it('6: гость со scope видит только свою сессию (list отфильтрован)', async () => {
    // Вторая сессия — гость её видеть не должен.
    fs.mkdirSync(path.join(root, 'work2'));
    await sessions.create({ name: 'e2e-other', root, dir: 'work2', preset: 'zsh' });

    // Пейринг со scope: только SESSION_NAME, ввод разрешён, файлы нет.
    const pairing = await withTimeout(
      link.openPairing({ session: SESSION_NAME, write: true, files: false }),
      10_000,
      'openPairing scoped',
    );
    await withTimeout(
      pairWithRetry({ code: pairing.code, relayUrl, name: 'e2e-agent', deviceName: 'e2e-guest', store: clientStore }),
      20_000,
      'runPair scoped',
    );
    const device = await withTimeout(pairing.done, 10_000, 'pairing.done scoped');
    expect(device.scope).toEqual({ session: SESSION_NAME, write: true, files: false });

    // Гость: list отдаёт только свою сессию, не «e2e-other».
    const remote = connectAgent(clientStore, relayUrl, agentId);
    await withTimeout(remote.ready, 20_000, 'remote.ready scoped');
    const list = await withTimeout(remote.list(), 15_000, 'remote.list scoped');
    expect(list.map((ssn) => ssn.name)).toEqual([SESSION_NAME]);
  }, 60_000);
});
