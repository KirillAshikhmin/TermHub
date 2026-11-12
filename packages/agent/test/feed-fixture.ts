// Ожидаемое тело ленты — одно на оба транспорта. LAN-ответ (`GET /api/feed`) и payload
// кадра FeedResult сверяются с ЭТОЙ строкой, поэтому правка сериализации одного пути
// красит тест другого: разъехаться молча тела больше не могут.

import type { FeedResult } from '../src/session-feed.js';
import type { DetailResult } from '../src/transcript-feed.js';
import type { UsageResult } from '../src/transcript-usage.js';

/** Страница ленты, которую отдаёт подставная лента обоих транспортов. Значения выбраны
 *  так, чтобы в ответе было видно каждое поле §6 — включая complete/live, которые
 *  приклеивает sessionFeed. Тип не ослаблять: он и ловит расхождение форм. */
export const FEED_PAGE: FeedResult = {
  ok: true,
  agent: 'claude',
  entries: [
    { id: 'u1', at: 1757800000000, kind: 'human', text: 'привет' },
    {
      id: 'q1',
      at: 1757800001000,
      kind: 'tool',
      text: 'AskUserQuestion Чай или вода?',
      tool: 'AskUserQuestion',
      detail: true,
      questions: [
        { text: 'Чай или вода?', header: 'Напиток', options: [{ label: 'Чай', hint: 'горячий' }, { label: 'Вода' }], answer: ['Чай'] },
      ],
    },
  ],
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
  '{"ok":true,"agent":"claude","entries":[{"id":"u1","at":1757800000000,"kind":"human","text":"привет"},' +
  '{"id":"q1","at":1757800001000,"kind":"tool","text":"AskUserQuestion Чай или вода?","tool":"AskUserQuestion","detail":true,' +
  '"questions":[{"text":"Чай или вода?","header":"Напиток","options":[{"label":"Чай","hint":"горячий"},{"label":"Вода"}],"answer":["Чай"]}]}],' +
  '"head":"42:0","tail":"42:120","bof":true,"eof":false,"skipped":0,"complete":true,"live":true}';

/** Ответ на неожиданный сбой чтения: один и тот же на обоих транспортах. */
export const FEED_CRASH_JSON = '{"ok":false,"reason":"lookup-failed","detail":"transcript vanished"}';

/** Расход сессии — тот же приём: одно тело на оба транспорта (флаг `usage` запроса ленты). */
export const USAGE_PAGE: UsageResult = {
  ok: true,
  agent: 'claude',
  total: { input: 10, cached: 200, cacheWrite: 30, output: 40, turns: 2, activeMs: 60000 },
  today: { input: 4, cached: 100, cacheWrite: 0, output: 15, turns: 1, activeMs: 1000 },
  started: 1757800000000,
  last: 1757800060000,
  context: { used: 112000, limit: 258400 },
};

export const USAGE_PAGE_JSON =
  '{"ok":true,"agent":"claude","total":{"input":10,"cached":200,"cacheWrite":30,"output":40,"turns":2,"activeMs":60000},' +
  '"today":{"input":4,"cached":100,"cacheWrite":0,"output":15,"turns":1,"activeMs":1000},' +
  '"started":1757800000000,"last":1757800060000,"context":{"used":112000,"limit":258400}}';

/** Подробности действия (`detail=<курсор>` / поле `detail` кадра Feed): тоже одно тело на
 *  оба транспорта. */
export const DETAIL_CURSOR = '77:1024';

export const DETAIL_BODY: DetailResult = {
  ok: true,
  input: 'npm test',
  output: '3 passed',
  truncated: true,
};

export const DETAIL_BODY_JSON = '{"ok":true,"input":"npm test","output":"3 passed","truncated":true}';

export const DETAIL_STALE: DetailResult = { ok: false, reason: 'cursor-stale', detail: 'cursor is not on an action' };

export const DETAIL_STALE_JSON = '{"ok":false,"reason":"cursor-stale","detail":"cursor is not on an action"}';
