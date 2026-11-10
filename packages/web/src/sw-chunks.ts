// Сборка файла из кусков для service worker. Там, где фильтр душит каждое соединение
// после пары десятков пакетов, большой файл не доезжает никогда, а кусок до 8 КБ на
// свежем соединении проходит. Relay в таком режиме отдаёт сжатый файл кусками
// `_c/<номер>/<путь>` (число кусков и тип — в заголовках), здесь они тянутся
// параллельно, склеиваются и распаковываются. Вынесено из sw.ts ради тестов.

const PARALLEL = 5;
const TRIES = 3;
const TIMEOUT_MS = 12_000;

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Адрес куска `index` для файла `target`; null — файл вне области service worker. */
export function chunkUrl(scope: string, target: URL, index: number): string | null {
  const base = new URL(scope);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) return null;
  const rel = target.pathname.slice(base.pathname.length);
  if (rel.length === 0 || rel.startsWith('_c/')) return null;
  return new URL(`_c/${index}/${rel}`, base).href;
}

async function chunk(doFetch: Fetch, url: string): Promise<Response> {
  let last: unknown;
  for (let attempt = 0; attempt < TRIES; attempt++) {
    const abort = new AbortController();
    // Задушенное соединение не рвётся, а молчит — без срока запрос висел бы вечно.
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const res = await doFetch(url, { signal: abort.signal, cache: 'no-store' });
      if (res.status === 404) return res;
      if (res.ok) {
        const body = await res.arrayBuffer();
        return new Response(body, { status: 200, headers: res.headers });
      }
      last = new Error(`chunk ${res.status}`);
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

/** Собирает файл из кусков. null — сервер кусков не отдаёт (решать вызывающему). */
export async function fetchChunked(target: URL, scope: string, doFetch: Fetch): Promise<Response | null> {
  const first = chunkUrl(scope, target, 0);
  if (!first) return null;
  const head = await chunk(doFetch, first);
  if (!head.ok) return null;
  const total = Number(head.headers.get('X-Chunks'));
  if (!Number.isInteger(total) || total < 1 || total > 100_000) return null;
  const parts: ArrayBuffer[] = new Array<ArrayBuffer>(total);
  parts[0] = await head.arrayBuffer();
  let next = 1;
  const worker = async (): Promise<void> => {
    while (next < total) {
      const index = next++;
      const res = await chunk(doFetch, chunkUrl(scope, target, index) as string);
      if (!res.ok) throw new Error(`chunk ${index} missing`);
      parts[index] = await res.arrayBuffer();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, total - 1) }, worker));
  const packed = new Blob(parts as BlobPart[]).stream().pipeThrough(new DecompressionStream('gzip'));
  // Распаковываем сразу: ошибка сборки должна всплыть здесь, а не посреди чтения ответа.
  const body = await new Response(packed).arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': head.headers.get('X-Content-Type') ?? 'application/octet-stream',
      'Cache-Control': head.headers.get('Cache-Control') ?? 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
