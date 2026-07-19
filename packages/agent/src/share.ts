// Команда `termhub share`: запускает пейринг у УЖЕ ЗАПУЩЕННОГО агента через его
// локальный REST (POST /api/share) и показывает код + QR. Cookie агента куётся из
// cookieSecret конфига (у CLI есть доступ к файлу — это тот же хост), поэтому
// отдельный логин не нужен. Если агент не запущен — понятная ошибка.

import http from 'node:http';
import https from 'node:https';
import qrcode from 'qrcode-terminal';
import { loadConfig } from './config.js';
import type { TermhubConfig } from './config.js';
import { issueCookie } from './auth.js';

/** Ответ /api/share. */
interface ShareResult {
  code: string;
  expiresAt: number;
}

/** Локальный адрес агента: host 0.0.0.0/:: недоступен для коннекта — идём на loopback. */
function localHost(host: string): string {
  if (host === '0.0.0.0' || host === '' || host === '::') return '127.0.0.1';
  return host;
}

/** POST /api/share к локальному агенту с cookie из cookieSecret. Кидает при недоступности/ошибке. */
function requestShare(config: TermhubConfig): Promise<ShareResult> {
  const isTls = config.tls !== null;
  const mod = isTls ? https : http;
  const options: https.RequestOptions = {
    host: localHost(config.host),
    port: config.port,
    path: '/api/share',
    method: 'POST',
    headers: {
      cookie: `termhub=${issueCookie(config.cookieSecret)}`,
      'content-type': 'application/json',
      'content-length': '0',
    },
    // Локальный самоподписанный сертификат — проверку хоста для loopback снимаем.
    rejectUnauthorized: false,
  };
  return new Promise<ShareResult>((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(body) as ShareResult);
          } catch {
            reject(new Error('Agent returned an invalid response to /api/share.'));
          }
          return;
        }
        if (res.statusCode === 503) {
          reject(new Error('Relay is not configured: set relayUrl in the config (termhub setup) and restart the agent.'));
          return;
        }
        reject(new Error(`Agent responded with error ${res.statusCode ?? '?'} to /api/share.`));
      });
    });
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED')
        reject(new Error('Agent is not running. Start it first: termhub start'));
      else reject(new Error(`Failed to reach the agent: ${err.message}`));
    });
    req.end();
  });
}

/** Печатает код пейринга крупно, QR и срок действия. */
function printPairing(result: ShareResult): void {
  const minutes = Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000));
  console.log('\nPairing code for a new device:\n');
  console.log(`    ${result.code}\n`);
  qrcode.generate(result.code, { small: true }, (qr: string) => console.log(qr));
  console.log(`\nEnter the code or scan the QR on your device. The code is valid for ~${minutes} min.`);
  console.log('The pairing window is open on the agent side — keep the agent running until it completes.\n');
}

/** Точка входа команды `termhub share`. Возвращает код выхода процесса. */
export async function runShare(): Promise<number> {
  const config = loadConfig();
  if (!config.relayUrl) {
    console.error('Relay is not configured: relayUrl is not set in the config. Run `termhub setup` and provide a Relay URL.');
    return 1;
  }
  try {
    const result = await requestShare(config);
    printPairing(result);
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}
