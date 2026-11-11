// Расход по сессиям: токены и время работы агента из транскриптов — за сегодня и всего.
// Считает агент (transcript-usage), сюда приезжает готовая сводка. Едет запросом ленты с
// флагом `usage` (ADR 0033), поэтому работает на обоих транспортах без своего кадра.
import { t } from './i18n';
import { sessionTitleText } from './session-status';
import type { FeedFailure, Transport } from './transport';
import { iconButton, openModal, spinner } from './ui';

export interface UsageTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  turns: number;
  activeMs: number;
}

export interface UsagePage {
  ok: true;
  agent: string;
  total: UsageTotals;
  today: UsageTotals;
  started: number;
  last: number;
}

/** Память процессов сессии в байтах едет и с расходом, и с отказом: у сессии без агента
 *  токенов нет, а память есть. Нет поля — агент её не посчитал (или он старше). */
export type UsageResult = (UsagePage | FeedFailure) & { memory?: number };

/** Расход одной сессии. Отказ — значение `{ok:false}`, исключение — только сбой связи. */
export function sessionUsage(transport: Transport, session: string): Promise<UsageResult> {
  return transport.feed(session, { usage: true }) as unknown as Promise<UsageResult>;
}

/** Все токены ответа: вход (мимо кэша, из кэша, в кэш) и выход. */
export function allTokens(u: UsageTotals): number {
  return u.input + u.cached + u.cacheWrite + u.output;
}

/** 1234 → «1,2k», 3 400 000 → «3,4M»: сводке нужен порядок, а не точное число. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Память: мегабайты до гигабайта, дальше гигабайты с одним знаком. */
export function formatMemory(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? t('usage.gb', { n: (mb / 1024).toFixed(1) }) : t('usage.mb', { n: Math.round(mb) });
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return ms > 0 ? t('usage.lessMinute') : '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? t('usage.hm', { h, m }) : t('usage.m', { m });
}

function sum(rows: UsageTotals[]): UsageTotals {
  const out: UsageTotals = { input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 0, activeMs: 0 };
  for (const r of rows) {
    out.input += r.input;
    out.cached += r.cached;
    out.cacheWrite += r.cacheWrite;
    out.output += r.output;
    out.turns += r.turns;
    out.activeMs += r.activeMs;
  }
  return out;
}

function cells(u: UsageTotals): string[] {
  return [formatDuration(u.activeMs), formatTokens(u.output), formatTokens(allTokens(u))];
}

function row(tag: 'td' | 'th', values: string[], cls = ''): HTMLTableRowElement {
  const tr = document.createElement('tr');
  if (cls) tr.className = cls;
  values.forEach((value, i) => {
    const cell = document.createElement(i === 0 ? 'th' : tag);
    cell.textContent = value;
    tr.append(cell);
  });
  return tr;
}

export function openUsage(transport: Transport): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-usage';
    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('usage.title');
    head.append(title, iconButton('close', t('common.close'), close));
    const status = document.createElement('div');
    status.className = 'th-usage__status';
    status.append(spinner());
    const table = document.createElement('table');
    table.className = 'th-usage__table';
    const thead = document.createElement('thead');
    const groups = document.createElement('tr');
    for (const [text, span] of [['', 2], [t('usage.today'), 3], [t('usage.total'), 3]] as const) {
      const th = document.createElement('th');
      th.colSpan = span;
      th.textContent = text;
      groups.append(th);
    }
    const cols = [t('usage.time'), t('usage.output'), t('usage.all')];
    thead.append(groups, row('th', [t('usage.session'), t('usage.memory'), ...cols, ...cols]));
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);
    box.append(head, status, table);

    void (async () => {
      let sessions: Array<{ name: string; title: string }>;
      try {
        sessions = await transport.list();
      } catch {
        status.textContent = t('usage.failed');
        return;
      }
      const today: UsageTotals[] = [];
      const total: UsageTotals[] = [];
      let memory = 0;
      let memoryKnown = false;
      let rows = 0;
      for (const s of sessions) {
        if (!box.isConnected) return;
        let res: UsageResult;
        try {
          res = await sessionUsage(transport, s.name);
        } catch {
          continue; // обрыв на одной сессии сводку по остальным не срывает
        }
        // Сессия без агента (обычная оболочка): токенов нет, но память она занимает —
        // строка с прочерками. Нет ни того, ни другого — показывать нечего.
        if (!res.ok && res.memory === undefined) continue;
        if (res.memory !== undefined) {
          memory += res.memory;
          memoryKnown = true;
        }
        const text = sessionTitleText(s.title);
        const name = text && text !== s.name ? `${text} · ${s.name}` : s.name;
        const dashes = ['—', '—', '—'];
        if (res.ok) {
          today.push(res.today);
          total.push(res.total);
        }
        tbody.append(
          row('td', [
            name,
            formatMemory(res.memory),
            ...(res.ok ? cells(res.today) : dashes),
            ...(res.ok ? cells(res.total) : dashes),
          ]),
        );
        rows += 1;
      }
      if (!box.isConnected) return;
      if (rows === 0) {
        status.textContent = t('usage.none');
        return;
      }
      tbody.append(
        row(
          'td',
          [t('usage.sum'), formatMemory(memoryKnown ? memory : undefined), ...cells(sum(today)), ...cells(sum(total))],
          'th-usage__sum',
        ),
      );
      status.textContent = t('usage.note');
    })();
    return box;
  });
}
