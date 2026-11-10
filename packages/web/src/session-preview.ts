// Превью сессии для обзора: последняя реплика беседы агента — из ленты (транскрипт на
// диске), а не с экрана. Кэш на транспорт; перечитываем, только когда сессия шевелилась,
// и не чаще раза в 10 с на сессию — работающий агент меняет activityTs каждый опрос.
import { whenCap } from './capabilities';
import type { Transport } from './transport';

interface Entry {
  stamp: number;
  at: number;
  text: string;
}

const PREVIEW_CHARS = 240;
const MIN_INTERVAL_MS = 10_000;
const cache = new WeakMap<Transport, Map<string, Entry>>();
const busy = new WeakSet<Transport>();

function entries(transport: Transport): Map<string, Entry> {
  let map = cache.get(transport);
  if (!map) {
    map = new Map();
    cache.set(transport, map);
  }
  return map;
}

/** Последняя известная реплика сессии или '' — ещё не читали либо беседы нет. */
export function previewOf(transport: Transport, session: string): string {
  return cache.get(transport)?.get(session)?.text ?? '';
}

/** Сжать реплику в одну строку превью. */
export function previewText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

/** Дочитать превью сессий, которые шевелились с прошлого раза. По одной за раз: relay
 *  держит один запрос ленты в полёте. onUpdate зовётся после каждой изменившейся. */
export function refreshPreviews(
  transport: Transport,
  sessions: Array<{ name: string; activityTs: number }>,
  onUpdate: () => void,
  now: () => number = Date.now,
): Promise<void> {
  if (busy.has(transport)) return Promise.resolve();
  busy.add(transport);
  const run = async (): Promise<void> => {
    if (!(await whenCap('feed', transport))) return;
    const map = entries(transport);
    for (const s of sessions) {
      const known = map.get(s.name);
      if (known && (known.stamp === s.activityTs || now() - known.at < MIN_INTERVAL_MS)) continue;
      let text = '';
      try {
        const page = await transport.feed(s.name, { limit: 8 });
        if (page.ok) {
          const last = [...page.entries].reverse().find((e) => (e.kind === 'agent' || e.kind === 'human') && e.text.trim());
          if (last) text = previewText(last.text);
        }
      } catch {
        // Обрыв: превью остаётся прежним, следующий опрос спросит снова.
        continue;
      }
      // Отказ ленты (нет агента, нет беседы) оставляет прежний текст, но запоминает
      // отметку — иначе обычная оболочка спрашивалась бы на каждом опросе.
      const changed = text !== '' && text !== known?.text;
      map.set(s.name, { stamp: s.activityTs, at: now(), text: text || known?.text || '' });
      if (changed) onUpdate();
    }
    for (const name of [...map.keys()]) if (!sessions.some((s) => s.name === name)) map.delete(name);
  };
  return run().finally(() => busy.delete(transport));
}
