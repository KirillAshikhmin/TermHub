// Расход сессии из транскрипта: токены и время работы агента — по дням и всего.
//
// Источник тот же, что у ленты: файл беседы, который агент и так пишет на диск. Claude
// кладёт `usage` в каждую строку ответа, причём одно сообщение расписано на несколько
// строк с одинаковым `message.id` и одинаковым `usage` — считаем по одному разу на id.
// Codex пишет событие `token_count` с нарастающим итогом (`total_token_usage`): расход —
// разность соседних итогов, поэтому повтор события ничего не добавляет.
//
// Файл целиком читается один раз (потоком, кусками), дальше — только дописанный хвост:
// состояние подсчёта помнится по пути файла вместе с inode и смещением.

import fsp from 'node:fs/promises';

import type { FeedFailure, FileAgent } from './transcript-feed.js';

export interface UsageTotals {
  /** Входные токены мимо кэша. */
  input: number;
  /** Входные токены, прочитанные из кэша. */
  cached: number;
  /** Токены, записанные в кэш. */
  cacheWrite: number;
  output: number;
  /** Ответов модели. */
  turns: number;
  /** Время работы: сумма промежутков между соседними записями короче ACTIVE_GAP_MS. */
  activeMs: number;
}

export interface UsagePage {
  ok: true;
  agent: FileAgent;
  total: UsageTotals;
  today: UsageTotals;
  /** Первая и последняя метка времени беседы, epoch ms; ноль — меток не было. */
  started: number;
  last: number;
  /** Проверки Guardian этого потока Codex: отдельные потоки со своим расходом, в `total`
   *  и `today` не входят. Нет поля — проверок не было (или агент не Codex). */
  reviews?: { count: number; total: UsageTotals; today: UsageTotals };
}

/** Память процессов сессии в байтах приклеивает `sessionUsage` — и к расходу, и к отказу:
 *  у сессии без агента токенов нет, а память есть. Нет поля — посчитать не удалось. */
export type UsageResult = (UsagePage | FeedFailure) & { memory?: number };

/** Расход сессии по её имени — подменяемый шов транспортов, как `FeedReader`. */
export type UsageReader = (session: string) => Promise<UsageResult>;

/** Пауза длиннее этой — уже не работа, а простой между заходами. */
export const ACTIVE_GAP_MS = 5 * 60 * 1000;
const CHUNK = 1024 * 1024;

interface State {
  ino: number;
  offset: number;
  days: Map<string, UsageTotals>;
  seen: Set<string>;
  /** Последний нарастающий итог Codex. */
  prev: { input: number; cached: number; cacheWrite: number; output: number } | null;
  started: number;
  last: number;
}

const states = new Map<string, State>();
const running = new Map<string, Promise<unknown>>();

/** Сбросить память подсчёта (тесты). */
export function clearUsageCache(): void {
  states.clear();
}

/** Расход проверок Guardian по их файлам: сумма по всем, что удалось прочитать. */
export async function readReviewsUsage(
  files: string[],
  now: number = Date.now(),
): Promise<NonNullable<UsagePage['reviews']> | undefined> {
  const total = empty();
  const today = empty();
  let count = 0;
  for (const file of files) {
    const res = await readUsage(file, 'codex', now);
    if (!res.ok) continue;
    count += 1;
    add(total, res.total);
    add(today, res.today);
  }
  return count ? { count, total, today } : undefined;
}

function add(into: UsageTotals, from: UsageTotals): void {
  into.input += from.input;
  into.cached += from.cached;
  into.cacheWrite += from.cacheWrite;
  into.output += from.output;
  into.turns += from.turns;
  into.activeMs += from.activeMs;
}

function empty(): UsageTotals {
  return { input: 0, cached: 0, cacheWrite: 0, output: 0, turns: 0, activeMs: 0 };
}

/** Локальный день метки: «сегодня» — это день пользователя, а не UTC. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function bucket(state: State, ts: number): UsageTotals {
  const key = dayKey(ts);
  let b = state.days.get(key);
  if (!b) {
    b = empty();
    state.days.set(key, b);
  }
  return b;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

const TS_RE = /"timestamp":"([^"]+)"/;

/** Учесть одну строку транскрипта. Битая строка пропускается: расход — оценка, и одна
 *  нечитаемая запись не повод отказывать во всём подсчёте. */
function consume(state: State, line: string, agent: FileAgent): void {
  const marker = agent === 'claude' ? '"usage"' : '"token_count"';
  let parsed: Record<string, unknown> | null = null;
  if (line.includes(marker)) {
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === 'object') parsed = value as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  const rawTs = parsed && typeof parsed.timestamp === 'string' ? parsed.timestamp : TS_RE.exec(line)?.[1];
  const ts = rawTs ? Date.parse(rawTs) : NaN;
  if (Number.isFinite(ts)) {
    if (!state.started) state.started = ts;
    const gap = ts - state.last;
    if (state.last && gap > 0 && gap < ACTIVE_GAP_MS) bucket(state, ts).activeMs += gap;
    if (ts > state.last) state.last = ts;
  }
  if (!parsed) return;
  // Запись без метки времени относим к последнему известному моменту беседы.
  const at = Number.isFinite(ts) ? ts : state.last;
  if (agent === 'claude') {
    if (parsed.type !== 'assistant') return;
    const message = parsed.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!message || !usage) return;
    const id = typeof message.id === 'string' ? message.id : '';
    if (id) {
      if (state.seen.has(id)) return;
      state.seen.add(id);
    }
    const b = bucket(state, at);
    b.input += num(usage.input_tokens);
    b.cached += num(usage.cache_read_input_tokens);
    b.cacheWrite += num(usage.cache_creation_input_tokens);
    b.output += num(usage.output_tokens);
    b.turns += 1;
    return;
  }
  const payload = parsed.payload as Record<string, unknown> | undefined;
  if (payload?.type !== 'token_count') return;
  const info = payload.info as Record<string, unknown> | undefined;
  const total = info?.total_token_usage as Record<string, unknown> | undefined;
  if (!total) return;
  const cached = num(total.cached_input_tokens);
  const now = {
    // У Codex входные токены включают кэшированные — разводим, как у Claude.
    input: Math.max(0, num(total.input_tokens) - cached),
    cached,
    cacheWrite: num(total.cache_write_input_tokens),
    output: num(total.output_tokens),
  };
  const prev = state.prev ?? { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  state.prev = now;
  // Итог пошёл назад (счёт начат заново) — принимаем его за новую точку отсчёта.
  if (now.input < prev.input || now.cached < prev.cached || now.output < prev.output) return;
  const delta = {
    input: now.input - prev.input,
    cached: now.cached - prev.cached,
    cacheWrite: Math.max(0, now.cacheWrite - prev.cacheWrite),
    output: now.output - prev.output,
  };
  if (delta.input + delta.cached + delta.output === 0) return;
  const b = bucket(state, at);
  b.input += delta.input;
  b.cached += delta.cached;
  b.cacheWrite += delta.cacheWrite;
  b.output += delta.output;
  b.turns += 1;
}

async function advance(file: string, agent: FileAgent): Promise<State> {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    let state = states.get(file);
    // Другой файл под тем же путём или файл укоротился — считаем заново.
    if (!state || state.ino !== stat.ino || stat.size < state.offset) {
      state = { ino: stat.ino, offset: 0, days: new Map(), seen: new Set(), prev: null, started: 0, last: 0 };
      states.set(file, state);
    }
    const buf = Buffer.allocUnsafe(CHUNK);
    let tail = Buffer.alloc(0);
    let pos = state.offset;
    while (pos < stat.size) {
      const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK, stat.size - pos), pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      let data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      let nl = data.indexOf(0x0a);
      while (nl >= 0) {
        if (nl > 0) consume(state, data.toString('utf8', 0, nl), agent);
        state.offset += nl + 1;
        data = data.subarray(nl + 1);
        nl = data.indexOf(0x0a);
      }
      // Недописанная строка ждёт следующего чтения: смещение стоит перед ней.
      tail = Buffer.from(data);
    }
    return state;
  } finally {
    await handle.close();
  }
}

/** Расход по файлу беседы. `now` — момент, чей локальный день считается «сегодня». */
export async function readUsage(file: string, agent: FileAgent, now: number = Date.now()): Promise<UsageResult> {
  // Запросы к одному файлу идут по очереди: состояние подсчёта у них общее.
  const prior = running.get(file) ?? Promise.resolve();
  const job = prior.then(
    () => advance(file, agent),
    () => advance(file, agent),
  );
  running.set(file, job);
  let state: State;
  try {
    state = await job;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason: code === 'ENOENT' ? 'no-transcript' : 'lookup-failed',
      detail: `cannot read usage from ${file}: ${(err as Error).message}`,
    };
  } finally {
    if (running.get(file) === job) running.delete(file);
  }
  const total = empty();
  for (const b of state.days.values()) {
    total.input += b.input;
    total.cached += b.cached;
    total.cacheWrite += b.cacheWrite;
    total.output += b.output;
    total.turns += b.turns;
    total.activeMs += b.activeMs;
  }
  return {
    ok: true,
    agent,
    total,
    today: { ...(state.days.get(dayKey(now)) ?? empty()) },
    started: state.started,
    last: state.last,
  };
}
