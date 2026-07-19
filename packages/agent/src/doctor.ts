// `termhub doctor` — быстрая диагностика окружения агента: конфиг, инструменты,
// tmux-сессии, слушает ли агент порт, доступен ли relay. Живой статус регистрации
// в relay смотри на веб-странице «Диагностика» (⋮ → Диагностика) или в логах агента.

import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { promisify } from 'node:util';

import { loadConfig, TMUX_SOCKET, VERSION } from './config.js';

const exec = promisify(execFile);

const G = '\x1b[32m';
const R = '\x1b[31m';
const Y = '\x1b[33m';
const DIM = '\x1b[2m';
const X = '\x1b[0m';
const ok = (l: string, d = ''): void => console.log(`  ${G}✓${X} ${l}${d ? ` — ${DIM}${d}${X}` : ''}`);
const bad = (l: string, d = ''): void => console.log(`  ${R}✗${X} ${l}${d ? ` — ${d}` : ''}`);
const warn = (l: string, d = ''): void => console.log(`  ${Y}!${X} ${l}${d ? ` — ${d}` : ''}`);

/** HTTP GET с игнором self-signed (локальный агент); первые 120 символов тела. */
function fetchText(url: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { rejectUnauthorized: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => resolve(body.slice(0, 120)));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function has(cmd: string): Promise<boolean> {
  try {
    await exec(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(): Promise<number> {
  console.log(`TermHub doctor (v${VERSION})\n`);
  let problems = 0;

  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
    ok('Config', `${config.sessionRoots.length} roots, port ${config.port}${config.tls ? ', TLS' : ''}`);
  } catch (e) {
    bad('Config', (e as Error).message);
    console.log('\nRun `termhub setup`.');
    return 1;
  }

  ok('Node', process.version);
  if (await has('git')) ok('git');
  else warn('git', 'not found — git repositories unavailable');
  if (await has('svn')) ok('svn');
  else warn('svn', 'not found — svn unavailable');
  if (await has('hg')) ok('hg');
  else warn('hg', 'not found — mercurial unavailable');

  try {
    const { stdout } = await exec('tmux', ['-L', TMUX_SOCKET, 'ls']);
    ok('tmux', `socket -L ${TMUX_SOCKET}, sessions: ${stdout.split('\n').filter(Boolean).length}`);
  } catch {
    warn('tmux', `no sessions on socket -L ${TMUX_SOCKET} — start a working session via tm`);
  }

  const scheme = config.tls ? 'https' : 'http';
  try {
    const r = await fetchText(`${scheme}://127.0.0.1:${config.port}/api/mode`);
    ok('Agent listening', `${scheme}://…:${config.port} → ${r.trim()}`);
  } catch {
    bad('Agent not responding', `port ${config.port} — running? (termhub service / termhub start)`);
    problems += 1;
  }

  if (config.relayUrl) {
    const probe = config.relayUrl
      .replace(/^ws:/, 'http:')
      .replace(/^wss:/, 'https:')
      .replace(/\/relay$/, '/api/mode');
    try {
      const r = await fetchText(probe);
      ok('Relay reachable', `${config.relayUrl} → ${r.trim()}`);
    } catch (e) {
      bad('Relay unreachable', `${config.relayUrl} (${(e as Error).message})`);
      problems += 1;
    }
    console.log(`\n  ${DIM}To check whether the agent is registered in relay — open ⋮ → Diagnostics in the web UI`);
    console.log(`  or check the agent logs ([relay-link] lines).${X}`);
  } else {
    warn('Relay', 'not configured — LAN only');
  }

  console.log(`\n${problems ? `${R}Problems: ${problems}${X}` : `${G}All good${X}`}`);
  return problems ? 1 : 0;
}
