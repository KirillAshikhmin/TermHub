// Раздача web-бандла relay из ./static: index.html как no-cache, assets/* как
// immutable, SPA-fallback на index.html, заглушка если бандл не собран. Локальная
// реализация relay — агентский server.ts не импортируется.

import fs from 'node:fs';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

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
export function serveStatic(res: ServerResponse, pathname: string, staticDir: string | undefined): void {
  if (staticDir) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const full = path.normalize(path.join(staticDir, rel));
    if (full !== staticDir && !full.startsWith(staticDir + path.sep)) {
      sendPlain(res, 403, 'forbidden');
      return;
    }
    if (isFile(full)) return sendFile(res, full, staticDir);
    const index = path.join(staticDir, 'index.html');
    if (isFile(index)) return sendFile(res, index, staticDir);
  }
  const buf = Buffer.from(PLACEHOLDER_HTML, 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': NO_CACHE, 'Content-Length': buf.length });
  res.end(buf);
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sendFile(res: ServerResponse, full: string, staticDir: string): void {
  const type = MIME[path.extname(full).toLowerCase()] ?? 'application/octet-stream';
  const relFromRoot = path.relative(staticDir, full).split(path.sep);
  const cache = relFromRoot[0] === 'assets' ? IMMUTABLE_CACHE : NO_CACHE;
  const data = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': data.length });
  res.end(data);
}

function sendPlain(res: ServerResponse, status: number, text: string): void {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}
