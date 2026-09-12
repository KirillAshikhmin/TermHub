import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { open } from '../src/session-link.js';

// Мост живёт на настоящем tmux: утечку дескрипторов видно только на живом
// клиенте, а не на фейке. Сокет изолированный (-L termhub-test-<uniq>),
// kill-server в teardown — рабочие сессии этот тест не трогает.
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Сколько дескрипторов открыто у текущего процесса. /dev/fd есть и в macOS, и в Linux. */
function openFdCount(): number {
  return fs.readdirSync('/dev/fd').length;
}

describe.skipIf(!tmuxAvailable)('pty: дескрипторы возвращаются системе после dispose', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;

  function tmux(args: string[]): string {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' });
  }

  beforeAll(() => {
    tmux(['new-session', '-d', '-s', 'fdleak']);
  });

  afterAll(() => {
    try {
      tmux(['kill-server']);
    } catch {
      // сервер мог уже умереть — teardown идемпотентен
    }
  });

  // Цикл «подключился — отключился» не должен оставлять за собой ни одного
  // дескриптора: агент живёт неделями, и протечка упирается в системный лимит pty.
  it('десять подключений подряд не наращивают число открытых fd', async () => {
    const connect = async (): Promise<void> => {
      const link = open('fdleak', {
        socketName,
        cols: 100,
        rows: 30,
        configMode: 'attach',
        requestedMode: 'attach',
        onData: () => {},
        onBell: () => {},
        onMode: () => {},
        onAltScreen: () => {},
        onExit: () => {},
        log: () => {},
      });
      await Promise.race([link.ready, delay(3000)]);
      link.dispose();
      await delay(300);
    };

    // Первое подключение прогревает ленивые загрузки модуля: его дескрипторы
    // к утечке отношения не имеют, поэтому точка отсчёта — после него.
    await connect();
    await delay(500);
    const before = openFdCount();

    for (let i = 0; i < 10; i++) await connect();
    await delay(1000);

    // Допуск на дребезг самого замера (readdirSync открывает каталог) — не на утечку:
    // протечка даёт рост, кратный числу подключений.
    expect(openFdCount() - before).toBeLessThanOrEqual(2);
  }, 40_000);

  // О смене размера tmux узнаёт по SIGWINCH, а тот приходит только процессу с
  // управляющим терминалом. Свой pty этого не даёт даром: клиента поднимает
  // spawn-helper из поставки node-pty, и без него resize молча теряется.
  it('resize доходит до tmux: окно меняет ширину', async () => {
    const link = open('fdleak', {
      socketName,
      cols: 90,
      rows: 25,
      configMode: 'attach',
      requestedMode: 'attach',
      onData: () => {},
      onBell: () => {},
      onMode: () => {},
      onAltScreen: () => {},
      onExit: () => {},
      log: () => {},
    });
    await Promise.race([link.ready, delay(3000)]);

    link.resize(120, 40);
    let width = '';
    for (let i = 0; i < 30; i++) {
      width = tmux(['list-windows', '-t', '=fdleak', '-F', '#{window_width}']).trim();
      if (width === '120') break;
      await delay(100);
    }
    link.dispose();

    expect(width).toBe('120');
  }, 20_000);
});
