// Поиск по лентам всех сессий: «в какой сессии я обсуждал X». Работает на клиенте поверх
// того же Transport.feed, что и экран ленты — у агента отдельного запроса нет. Глубина
// ограничена: с хвоста каждой беседы просматривается до PAGES страниц.
import type { FeedEntry } from './api';
import { searchFeed, type FeedHit } from './feed';
import { t } from './i18n';
import { sfeedHash } from './routes';
import { sessionTitleText } from './session-status';
import type { Transport } from './transport';
import { iconButton, openModal } from './ui';

const PAGE = 200;
const PAGES = 5;
const HITS_PER_SESSION = 20;

// Находка, к которой надо прыгнуть после перехода на экран ленты: адрес ленты курсора
// не несёт, поэтому просьба ждёт здесь, пока её не заберёт рабочее пространство.
let pendingJump: { session: string; cursor: string } | null = null;
export function setFeedJump(session: string, cursor: string): void {
  pendingJump = { session, cursor };
}
export function takeFeedJump(session: string): string | null {
  if (pendingJump?.session !== session) return null;
  const { cursor } = pendingJump;
  pendingJump = null;
  return cursor;
}

export interface SessionHits {
  session: string;
  hits: FeedHit[];
  /** Сколько записей просмотрено и дошли ли до начала беседы. */
  scanned: number;
  complete: boolean;
}

/** Поиск по одной беседе с хвоста назад. Край — `bof`, а не пустая страница: пустая со
 *  сдвинутым курсором означает шаг через слишком большую строку. */
export async function searchSession(
  transport: Transport,
  session: string,
  query: string,
  alive: () => boolean = () => true,
): Promise<SessionHits> {
  const found: FeedHit[] = [];
  let scanned = 0;
  let before: string | undefined;
  let complete = false;
  for (let page = 0; page < PAGES && alive(); page += 1) {
    const res = await transport.feed(session, before ? { limit: PAGE, before } : { limit: PAGE });
    if (!res.ok) break;
    const entries: FeedEntry[] = res.entries;
    scanned += entries.length;
    // Прыгнуть можно только к записи с курсором; свежие находки — первыми.
    found.push(...searchFeed(entries, query).filter((h) => h.cursor).reverse());
    if (res.bof) {
      complete = true;
      break;
    }
    if (!res.head || res.head === before) break;
    before = res.head;
  }
  return { session, hits: found.slice(0, HITS_PER_SESSION), scanned, complete };
}

export function openFeedSearch(transport: Transport): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-feedall';
    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('feedall.title');
    head.append(title, iconButton('close', t('common.close'), close));

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'th-input';
    input.placeholder = t('feedall.placeholder');
    input.setAttribute('aria-label', t('feedall.placeholder'));
    const status = document.createElement('div');
    status.className = 'th-feedall__status';
    status.setAttribute('role', 'status');
    status.textContent = t('feedall.hint');
    const list = document.createElement('div');
    list.className = 'th-feedall__list';

    // Поколение поиска: новый запрос обесценивает идущий, чтобы его находки не
    // засчитались чужому слову.
    let generation = 0;
    const run = async (): Promise<void> => {
      const query = input.value.trim();
      const mine = (generation += 1);
      const alive = (): boolean => mine === generation && box.isConnected;
      list.replaceChildren();
      if (!query) {
        status.textContent = t('feedall.hint');
        return;
      }
      let sessions: Array<{ name: string; title: string }> = [];
      try {
        sessions = await transport.list();
      } catch {
        if (alive()) status.textContent = t('feedall.failed');
        return;
      }
      let total = 0;
      for (let i = 0; i < sessions.length && alive(); i += 1) {
        const s = sessions[i]!;
        status.textContent = t('feedall.progress', { done: i, all: sessions.length, name: s.name });
        let res: SessionHits;
        try {
          res = await searchSession(transport, s.name, query, alive);
        } catch {
          continue; // обрыв одной беседы поиск по остальным не останавливает
        }
        if (!alive() || res.hits.length === 0) continue;
        total += res.hits.length;
        const group = document.createElement('div');
        group.className = 'th-feedall__group';
        const text = sessionTitleText(s.title);
        group.textContent = text && text !== s.name ? `${text} · ${s.name}` : s.name;
        list.append(group);
        for (const hit of res.hits) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'th-feedall__row';
          row.textContent = hit.snippet;
          row.addEventListener('click', () => {
            setFeedJump(s.name, hit.cursor!);
            close(sfeedHash(s.name));
          });
          list.append(row);
        }
      }
      if (alive()) status.textContent = total > 0 ? t('feedall.done', { n: total }) : t('feedall.none');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void run();
      }
    });
    box.append(head, input, status, list);
    return box;
  });
}
