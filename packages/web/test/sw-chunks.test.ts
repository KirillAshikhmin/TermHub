// @vitest-environment node
import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { chunkUrl, fetchChunked } from '../src/sw-chunks';

const SCOPE = 'https://relay.example.com:9443/';
const CHUNK = 8192;

/** Сервер кусков в памяти: считает запросы и умеет ронять выбранный кусок. */
function server(file: Buffer, opts: { failOnce?: number } = {}) {
  const gz = zlib.gzipSync(file);
  const total = Math.max(1, Math.ceil(gz.length / CHUNK));
  const seen: string[] = [];
  let failed = false;
  const doFetch = async (url: string): Promise<Response> => {
    seen.push(url);
    const m = /\/_c\/(\d+)\/(.+)$/.exec(new URL(url).pathname);
    if (!m || m[2] !== 'assets/main-abc.js') return new Response('nope', { status: 404 });
    const i = Number(m[1]);
    if (i >= total) return new Response('nope', { status: 404 });
    if (opts.failOnce === i && !failed) {
      failed = true;
      throw new TypeError('network');
    }
    return new Response(new Uint8Array(gz.subarray(i * CHUNK, (i + 1) * CHUNK)), {
      headers: { 'X-Chunks': String(total), 'X-Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, immutable' },
    });
  };
  return { doFetch, seen, total };
}

describe('сборка файла из кусков', () => {
  it('адрес куска строится от области service worker', () => {
    const target = new URL('assets/main-abc.js', SCOPE);
    expect(chunkUrl(SCOPE, target, 3)).toBe('https://relay.example.com:9443/_c/3/assets/main-abc.js');
    expect(chunkUrl(SCOPE, new URL('https://other.example.com/x.js'), 0)).toBeNull();
    expect(chunkUrl(SCOPE, new URL('_c/0/x.js', SCOPE), 0)).toBeNull();
    expect(chunkUrl(SCOPE, new URL(SCOPE), 0)).toBeNull();
  });

  it('большой файл склеивается и распаковывается побайтово, тип и кэш берутся из заголовков', async () => {
    const file = crypto.randomBytes(120_000);
    const srv = server(file);
    const res = await fetchChunked(new URL('assets/main-abc.js', SCOPE), SCOPE, srv.doFetch);
    expect(res).not.toBeNull();
    expect(Buffer.from(await res!.arrayBuffer()).equals(file)).toBe(true);
    expect(res!.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
    expect(res!.headers.get('Cache-Control')).toBe('public, immutable');
    expect(srv.total).toBeGreaterThan(10);
    expect(new Set(srv.seen).size).toBe(srv.total);
  });

  it('сбой одного куска повторяется, файл всё равно собирается', async () => {
    const file = crypto.randomBytes(40_000);
    const srv = server(file, { failOnce: 2 });
    const res = await fetchChunked(new URL('assets/main-abc.js', SCOPE), SCOPE, srv.doFetch);
    expect(Buffer.from(await res!.arrayBuffer()).equals(file)).toBe(true);
    expect(srv.seen.length).toBe(srv.total + 1);
  });

  it('сервер без кусков — null, решать вызывающему', async () => {
    const srv = server(Buffer.from('x'));
    expect(await fetchChunked(new URL('assets/other.js', SCOPE), SCOPE, srv.doFetch)).toBeNull();
  });
});
