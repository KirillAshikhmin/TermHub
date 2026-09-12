// Разбор строчного протокола tmux control mode (`tmux -CC`) и кодирование ввода
// для `send-keys -H`. Модуль чистый: ни процессов, ни сети, ни DOM — это шов,
// на котором протокол проверяется без живого tmux.

/** Вывод панели: байты уже разэкранированы и годятся для записи в терминал. */
export interface ControlOutputEvent {
  type: 'output';
  /** Идентификатор панели в форме tmux: `%0`. */
  pane: string;
  data: Uint8Array;
}

/** Ответ на команду целиком: `%begin <ts> <id> <flags>` … `%end <ts> <id> <flags>`. */
export interface ControlBlockEvent {
  type: 'block';
  /** Номер команды: по нему ответ сопоставляется с запросом. */
  id: number;
  lines: string[];
}

/** Команда не удалась: блок закрылся `%error` вместо `%end` — либо разбор забраковал его сам
 *  (закрытия нет, строка тела сверх предела). В строках — текст tmux или причина отказа. */
export interface ControlErrorEvent {
  type: 'error';
  id: number;
  lines: string[];
}

/** Уведомление tmux, не связанное с ответом на команду: `%session-changed $0 work`. */
export interface ControlNotificationEvent {
  type: 'notification';
  /** Имя без ведущего `%`: `session-changed`. */
  name: string;
  args: string[];
}

export type ControlEvent =
  | ControlOutputEvent
  | ControlBlockEvent
  | ControlErrorEvent
  | ControlNotificationEvent;

const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const BACKSLASH = 0x5c;
const ZERO = 0x30;
const SEVEN = 0x37;
const MAX_BYTE = 0xff;

/** Предел длины одной строки протокола. `%output` tmux сбрасывает за проход цикла
 *  событий — это десятки килобайт, строка ответа команды ещё короче. Мегабайт без
 *  перевода строки означает не данные, а рассинхрон: копить такой хвост нельзя, он
 *  перекопируется на каждый следующий кусок потока. */
const MAX_LINE_BYTES = 1 << 20;

/** Предел числа строк в открытом блоке. Самый большой законный ответ — снимок всей
 *  истории панели, а `history-limit` проекта — 50 000 строк; двойной запас ловит
 *  потерянный `%end` и не рубит законный ответ. Считаем строки, а не байты: длину
 *  каждой строки уже держит MAX_LINE_BYTES, вдвоём они ограничивают память блока. */
const MAX_BLOCK_LINES = 100_000;

const EMPTY = new Uint8Array(0);
const decoder = new TextDecoder();

/** Склейка хвоста прошлого куска с новым. */
function concat(head: Uint8Array, rest: Uint8Array): Uint8Array {
  const joined = new Uint8Array(head.length + rest.length);
  joined.set(head, 0);
  joined.set(rest, head.length);
  return joined;
}

/** Индекс первого пробела начиная с from; -1, если пробела дальше нет. */
function spaceAt(line: Uint8Array, from: number): number {
  for (let i = from; i < line.length; i++) {
    if (line[i] === SPACE) return i;
  }
  return -1;
}

/** Поля строки протокола после её имени; пустых полей не бывает. */
function fields(line: Uint8Array, firstSpace: number): string[] {
  if (firstSpace === -1) return [];
  return decoder
    .decode(line.subarray(firstSpace + 1))
    .split(' ')
    .filter((part) => part.length > 0);
}

/** Номер команды из `%begin|%end|%error <ts> <id> <flags>`; undefined, если строка битая. */
function commandId(line: Uint8Array, firstSpace: number): number | undefined {
  const id = Number(fields(line, firstSpace)[1]);
  return Number.isInteger(id) ? id : undefined;
}

/** Разэкранирование `%output` одним проходом, без регулярных выражений: это горячий путь.
 *  Экранируются только управляющие байты и сам слэш — тремя восьмеричными цифрами.
 *  Всё остальное (включая сырой многобайтовый UTF-8) копируется как есть. */
function unescapeOutput(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length); // разэкранированное никогда не длиннее
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const byte = src[i];
    if (byte === BACKSLASH && i + 3 < src.length) {
      const a = src[i + 1];
      const b = src[i + 2];
      const c = src[i + 3];
      if (a >= ZERO && a <= SEVEN && b >= ZERO && b <= SEVEN && c >= ZERO && c <= SEVEN) {
        const value = ((a - ZERO) << 6) | ((b - ZERO) << 3) | (c - ZERO);
        if (value <= MAX_BYTE) {
          out[n++] = value;
          i += 3;
          continue;
        }
      }
    }
    out[n++] = byte;
  }
  return out.subarray(0, n);
}

/** Разбор потока control mode. Держит состояние между кусками, поэтому у него
 *  один экземпляр на соединение. */
export class ControlParser {
  /** Хвост последнего куска без перевода строки: ждёт продолжения. */
  private tail: Uint8Array = EMPTY;
  /** Открытый блок ответа: пока он не закрыт, наружу не уходит ничего. */
  private block: { id: number; lines: string[] } | undefined;
  /** Идёт слишком длинная строка: её байты выбрасываются до ближайшего перевода строки. */
  private dropping = false;

  /** Разбирает кусок потока и возвращает события в порядке их появления. */
  parse(chunk: Uint8Array): ControlEvent[] {
    const buffer = this.tail.length === 0 ? chunk : concat(this.tail, chunk);
    const events: ControlEvent[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== LF) continue;
      if (this.dropping) this.dropping = false; // выброшенная строка кончилась
      else {
        // CR перед LF ставит терминальный драйвер pty, к данным панели он не относится.
        const end = i > start && buffer[i - 1] === CR ? i - 1 : i;
        this.line(buffer.subarray(start, end), events);
      }
      start = i + 1;
    }
    if (this.dropping || buffer.length - start > MAX_LINE_BYTES) {
      // Выброшенная строка могла быть строкой тела: ответ уже неполный. Молча потерянная
      // строка снимка хуже явного отказа — её нехватку потребитель не увидит никогда,
      // поэтому блок бракуем целиком.
      if (this.block) this.abort(this.block, `discarded: body line over ${MAX_LINE_BYTES} bytes`, events);
      this.dropping = true;
      this.tail = EMPTY;
      return events;
    }
    // Копия, а не подрезка: чужой буфер может быть переиспользован до следующего куска.
    this.tail = start < buffer.length ? new Uint8Array(buffer.subarray(start)) : EMPTY;
    return events;
  }

  /** Брак блока: ждущая команда обязана узнать об отказе. Промолчать нельзя — её ответом
   *  станет следующий блок, и сопоставление ответов по номеру сдвинется навсегда. */
  private abort(open: { id: number; lines: string[] }, reason: string, events: ControlEvent[]): void {
    this.block = undefined;
    events.push({ type: 'error', id: open.id, lines: [`control block ${reason}`] });
  }

  /** Одна завершённая строка протокола, без перевода строки. */
  private line(line: Uint8Array, events: ControlEvent[]): void {
    const firstSpace = spaceAt(line, 0);
    const head = decoder.decode(firstSpace === -1 ? line : line.subarray(0, firstSpace));
    const open = this.block;
    if (open) {
      // Внутри блока закрывает только строка с тем же номером команды: тело ответа
      // (например вывод capture-pane) само может начинаться с `%`.
      if ((head === '%end' || head === '%error') && commandId(line, firstSpace) === open.id) {
        this.block = undefined;
        const type = head === '%end' ? 'block' : 'error';
        events.push({ type, id: open.id, lines: open.lines });
        return;
      }
      if (open.lines.length < MAX_BLOCK_LINES) {
        open.lines.push(decoder.decode(line));
        return;
      }
      // Предел пройден: закрытия уже не будет. Блок бракуем и разбираем эту же строку
      // как поток — иначе один рассинхрон номеров запирает вывод панели навсегда.
      this.abort(open, `discarded: no %end within ${MAX_BLOCK_LINES} lines`, events);
    }
    if (head === '%output') {
      if (firstSpace === -1) return; // в строке нет ни панели, ни данных
      const paneEnd = spaceAt(line, firstSpace + 1);
      const pane = decoder.decode(line.subarray(firstSpace + 1, paneEnd === -1 ? line.length : paneEnd));
      if (pane.length === 0) return; // вывод без панели отдавать некому
      const data = paneEnd === -1 ? EMPTY : unescapeOutput(line.subarray(paneEnd + 1));
      events.push({ type: 'output', pane, data });
      return;
    }
    if (head === '%begin') {
      const id = commandId(line, firstSpace);
      if (id !== undefined) this.block = { id, lines: [] };
      return; // заголовок с нечитаемым номером уведомлением не притворяется
    }
    // Закрытие без своего блока — обломок рассинхрона, а не уведомление tmux.
    if (head === '%end' || head === '%error') return;
    // Вне блока у протокола одна форма строки — `%имя поля`. Строку без `%` привязать
    // не к чему: в ней нет ни панели, ни номера команды.
    if (!head.startsWith('%')) return;
    // Незнакомое уведомление отдаём как есть: это может быть новая версия tmux.
    events.push({ type: 'notification', name: head.slice(1), args: fields(line, firstSpace) });
  }
}

/** Кодирует байты ввода в аргументы `send-keys -H`: по два шестнадцатеричных разряда
 *  на байт через пробел. В таком виде уходит всё — управляющие байты, пробелы,
 *  кавычки, многобайтовый UTF-8, — и tmux не примет ни один байт за синтаксис. */
export function escapeInput(bytes: Uint8Array): string {
  const args = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) args[i] = bytes[i].toString(16).padStart(2, '0');
  return args.join(' ');
}
