// Подсказки поля ввода — чистые функции без DOM: где открывается список («/» команд
// или «@» файлов), как он сужается и что подставляется.
import type { ChatCommand } from '@termhub/protocol/chat';

export interface Completion {
  kind: 'slash' | 'file';
  /** Набранное после «/» или «@» — до каретки. */
  query: string;
  /** Что заменяет выбор: от знака подсказки до конца слова под кареткой. */
  from: number;
  to: number;
}

const SPACE = /\s/;

/** Открыта ли подсказка при данной каретке. «/» — только в самом начале поля (так агент
 *  и читает команды), «@» — в начале или после пробела и переноса. Знак внутри слова
 *  (почта, путь a/b) и пробел между знаком и кареткой подсказку не открывают. */
export function completionAt(text: string, caret: number): Completion | null {
  if (caret < 1 || caret > text.length) return null;
  let start = caret;
  while (start > 0 && !SPACE.test(text[start - 1]!)) start -= 1;
  const sign = text[start];
  if (start === caret) return null;
  const kind = sign === '/' && start === 0 ? 'slash' : sign === '@' ? 'file' : null;
  if (!kind) return null;
  let end = caret;
  while (end < text.length && !SPACE.test(text[end]!)) end += 1;
  return { kind, query: text.slice(start + 1, caret), from: start, to: end };
}

/** Команды по запросу: имя на запрос — первыми, затем имя с запросом внутри; порядок
 *  списка агента внутри группы сохраняется. Подсказка в сужении не участвует. */
export function rankCommands(commands: ChatCommand[], query: string): ChatCommand[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const starts: ChatCommand[] = [];
  const inside: ChatCommand[] = [];
  for (const c of commands) {
    const name = c.name.toLowerCase();
    if (name.startsWith(q)) starts.push(c);
    else if (name.includes(q)) inside.push(c);
  }
  return [...starts, ...inside];
}

/** Подставляет значение вместо слова под кареткой; после него пробел (если следующий
 *  знак не пробел и пробел не отменён — каталог оставляет подсказку открытой). Каретка —
 *  сразу за вставленным. */
export function applyCompletion(text: string, at: Completion, value: string, space = true): { text: string; caret: number } {
  const rest = text.slice(at.to);
  const gap = space && (rest === '' || !SPACE.test(rest[0]!)) ? ' ' : '';
  const head = text.slice(0, at.from) + value + gap;
  return { text: head + rest, caret: at.from + value.length + gap.length };
}
