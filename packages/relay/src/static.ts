// Раздача web-бандла relay из ./static: index.html как no-cache, assets/* как
// immutable, SPA-fallback на index.html, заглушка если бандл не собран. Локальная
// реализация relay — агентский server.ts не импортируется.

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

/** Защитные заголовки PWA (зеркало agent/server.ts: relay раздаёт тот же бандл). */
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ws: wss:; " +
    "font-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const PLACEHOLDER_HTML =
  '<!doctype html>\n<html lang="ru"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>TermHub relay</title></head>' +
  '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">' +
  '<h1>TermHub relay</h1>' +
  '<p>Веб-интерфейс ещё не собран. Соберите web-пакет: <code>npm run build -w @termhub/web</code>.</p>' +
  '</body></html>';

/** Раздаёт файл из staticDir с защитой от traversal и SPA-fallback; без бандла — заглушка. */
export function serveStatic(
  res: ServerResponse,
  pathname: string,
  staticDir: string | undefined,
  chunked = false,
): void {
  if (staticDir) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.normalize(path.join(staticDir, rel));
    if (full !== staticDir && !full.startsWith(staticDir + path.sep)) {
      sendPlain(res, 403, 'forbidden');
      return;
    }
    if (isFile(full)) return sendFile(res, full, staticDir, chunked);
    const index = path.join(staticDir, 'index.html');
    if (isFile(index)) return sendFile(res, index, staticDir, chunked);
  }
  const buf = Buffer.from(PLACEHOLDER_HTML, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': NO_CACHE,
    'Content-Length': buf.length,
    ...SECURITY_HEADERS,
  });
  res.end(buf);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sendFile(res: ServerResponse, full: string, staticDir: string, chunked: boolean): void {
  const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
  const relFromRoot = path.relative(staticDir, full).split(path.sep);
  const cache = relFromRoot[0] === 'assets' ? IMMUTABLE_CACHE : NO_CACHE;
  let data = fs.readFileSync(full);
  if (chunked && path.basename(full) === 'index.html') data = Buffer.from(bootIndex(data.toString('utf8')), 'utf8');
  const headers: Record<string, string | number> = {
    'Content-Type': type,
    'Cache-Control': cache,
    'Content-Length': data.length,
    ...SECURITY_HEADERS,
  };
  if (chunked) headers.Connection = 'close';
  res.writeHead(200, headers);
  res.end(data);
}

// ── Раздача кусками ───────────────────────────────────────────────────────────
// Там, где фильтр душит каждое соединение после пары десятков пакетов, бандл целиком
// не доезжает никогда, а кусок до 8 КБ на свежем соединении проходит. Поэтому файл
// сжимается и режется на куски `/_c/<номер>/<путь>`; собирает их service worker.

/** Размер куска: вместе с TLS-рукопожатием укладывается в лимит потока с запасом. */
export const CHUNK_BYTES = 8 * 1024;
/** Путь пробы: на него отвечает service worker, если умеет собирать куски. */
export const CHUNK_PROBE_PATH = '/__sw-chunked';

const gzCache = new Map<string, { stamp: string; gz: Buffer }>();

function gzipped(full: string): Buffer {
  const st = fs.statSync(full);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = gzCache.get(full);
  if (hit && hit.stamp === stamp) return hit.gz;
  const gz = zlib.gzipSync(fs.readFileSync(full), { level: 9 });
  gzCache.set(full, { stamp, gz });
  return gz;
}

/** Отдаёт кусок `/_c/<i>/<путь>` сжатого файла; число кусков и тип — в заголовках. */
export function serveChunk(res: ServerResponse, pathname: string, staticDir: string | undefined): void {
  const m = /^\/_c\/(\d{1,6})\/(.+)$/.exec(pathname);
  if (!m || !staticDir) return sendPlain(res, 404, 'not found');
  const full = path.normalize(path.join(staticDir, m[2]));
  if (!full.startsWith(staticDir + path.sep) || !isFile(full)) return sendPlain(res, 404, 'not found');
  const gz = gzipped(full);
  const total = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));
  const index = Number(m[1]);
  if (index >= total) return sendPlain(res, 404, 'not found');
  const part = gz.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES);
  const relFromRoot = path.relative(staticDir, full).split(path.sep);
  res.writeHead(200, {
    // octet-stream: прокси перед relay не должен сжимать кусок второй раз.
    'Content-Type': 'application/octet-stream',
    'Cache-Control': relFromRoot[0] === 'assets' ? IMMUTABLE_CACHE : NO_CACHE,
    'Content-Length': part.length,
    'X-Chunks': total,
    'X-Content-Type': MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(part);
}

/** Переписывает собранный index.html: скрипты и стили бандла грузит не браузер напрямую
 *  (первый же большой файл повис бы навсегда), а загрузчик — после того как service
 *  worker готов собирать их из кусков. Инлайн-скрипт нельзя: CSP разрешает только 'self'. */
export function bootIndex(html: string): string {
  const js: string[] = [];
  const css: string[] = [];
  let out = html.replace(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"[^>]*><\/script>\s*/g, (_all, src: string) => {
    js.push(src);
    return '';
  });
  out = out.replace(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>\s*/g, (_all, href: string) => {
    css.push(href);
    return '';
  });
  out = out.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>\s*/g, '');
  if (js.length === 0) return html;
  const tag = `<script src="./boot.js" data-js="${js.join(' ')}" data-css="${css.join(' ')}"></script>`;
  return out.includes('</body>') ? out.replace('</body>', `${tag}\n  </body>`) : out + tag;
}

/** Загрузчик: ждёт service worker, умеющий куски (проба), и только тогда подключает
 *  бандл. Регистрирует SW сам — приложение, которое обычно это делает, ещё не загружено. */
export const BOOT_JS = `(function () {
  var tag = document.currentScript;
  var js = (tag.getAttribute('data-js') || '').split(' ').filter(Boolean);
  var css = (tag.getAttribute('data-css') || '').split(' ').filter(Boolean);
  var done = false;
  function go() {
    if (done) return;
    done = true;
    css.forEach(function (href) {
      var l = document.createElement('link');
      l.rel = 'stylesheet';
      l.href = href;
      document.head.appendChild(l);
    });
    js.forEach(function (src) {
      var s = document.createElement('script');
      s.type = 'module';
      s.src = src;
      document.body.appendChild(s);
    });
  }
  var sw = navigator.serviceWorker;
  if (!sw) return go();
  var tries = 0;
  function probe() {
    if (done) return;
    fetch('.${CHUNK_PROBE_PATH}', { cache: 'no-store' }).then(
      function (r) { return r.ok; },
      function () { return false; }
    ).then(function (ok) {
      if (ok) return go();
      if (++tries > 40) return go();
      setTimeout(probe, 250);
    });
  }
  sw.register('sw.js').then(function (reg) { reg.update().catch(function () {}); }, function () {});
  probe();
})();
`;

function sendPlain(res: ServerResponse, status: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
