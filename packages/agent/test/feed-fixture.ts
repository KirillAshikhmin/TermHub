// Ожидаемое тело ленты — одно на оба транспорта. LAN-ответ (`GET /api/feed`) и payload
// кадра FeedResult сверяются с ЭТОЙ строкой, поэтому правка сериализации одного пути
// красит тест другого: разъехаться молча тела больше не могут.

import type { FeedResult } from '../src/session-feed.js';

/** Страница ленты, которую отдаёт подставная лента обоих транспортов. Значения выбраны
 *  так, чтобы в ответе было видно каждое поле §6 — включая complete/live, которые
 *  приклеивает sessionFeed. Тип не ослаблять: он и ловит расхождение форм. */
export const FEED_PAGE: FeedResult = {
  ok: true,
  agent: 'claude',
  entries: [{ id: 'u1', at: 1757800000000, kind: 'human', text: 'привет' }],
  head: '42:0',
  tail: '42:120',
  bof: true,
  eof: false,
  skipped: 0,
  complete: true,
  live: true,
};

/** То же тело, выписанное руками: ожидание не считается тем же способом, что ответ. */
export const FEED_PAGE_JSON =
  '{"ok":true,"agent":"claude","entries":[{"id":"u1","at":1757800000000,"kind":"human","text":"привет"}],' +
  '"head":"42:0","tail":"42:120","bof":true,"eof":false,"skipped":0,"complete":true,"live":true}';

/** Ответ на неожиданный сбой чтения: один и тот же на обоих транспортах. */
export const FEED_CRASH_JSON = '{"ok":false,"reason":"lookup-failed","detail":"transcript vanished"}';
