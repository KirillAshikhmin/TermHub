// Разметка ответа агента — узлами DOM, без единого innerHTML.
//
// Текст беседы приходит из чужого транскрипта, поэтому здесь нет ни одного места,
// где строка превращается в разметку парсером браузера: всё, что видно на экране,
// собрано из createElement и createTextNode. Строка `<img onerror=…>` остаётся
// строкой — это единственное, что отделяет ленту от дыры, и на это есть тест.
//
// Подмножество markdown выбрано по тому, что реально пишут агенты: заголовки,
// жирный/курсив/зачёркнутый, код в строке и блоком, списки (в том числе вложенные
// и нумерованные), таблицы, ссылки, цитаты, горизонтальные линии. Всё остальное
// (HTML, ссылки-сноски, изображения) осознанно остаётся текстом.
//
// Подсветку блока кода тянет тот же ленивый чанк, что и просмотр файлов
// (`import('./highlight')`), — в LAN-бандл она не попадает.

/** Схемы, которым можно дать href. Остальное (`javascript:`, `data:`) — текст. */
const SAFE_SCHEME = /^(?:https?:\/\/|mailto:)/i;
/** Заголовок ATX: `## Готово`, хвостовые решётки не считаются текстом. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
/** Горизонтальная линия: три и больше одинаковых знака, между ними только пробелы. */
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** Огораживание блока кода: три и больше backtick или тильд плюс язык. */
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*$/;
/** Строка цитаты: `> текст`, один пробел после скобки съедается. */
const QUOTE = /^ {0,3}> ?(.*)$/;
/** Пункт списка: отступ, маркер, текст. Нумерованный — `1.` или `1)`. */
const ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})[.)])[ \t]+(.*)$/;
/** Строка-разделитель таблицы: `| --- | :--: |`. */
const TABLE_SEP = /^[ \t]*\|?(?:[ \t]*:?-+:?[ \t]*\|)+[ \t]*:?-*:?[ \t]*\|?[ \t]*$/;
/** Сущности, которые ставит highlight.js, — только они и разворачиваются обратно. */
const ENTITY = /&(amp|lt|gt|quot|#x27);/g;
const ENTITY_TEXT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'" };
/** Разметка, которую выдаёт highlight.js: только открытие и закрытие span. */
const HLJS_TAG = /<span class="([^"<>]*)">|<\/span>/g;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K): HTMLElementTagNameMap[K] => document.createElement(tag);
const isWord = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** Рисует markdown-текст узлами DOM. Единственный вход модуля. */
export function renderMarkdown(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of blocks(text.split('\n'))) frag.append(node);
  return frag;
}

/** Блоки одного уровня. Рекурсия сюда же приходит из цитат и пунктов списка. */
function blocks(lines: string[]): Node[] {
  const out: Node[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1]![0]!;
      const body: string[] = [];
      let j = i + 1;
      // Незакрытый блок дочитывается до конца текста: ответ агента бывает обрезан
      // по 64 КиБ прямо посреди кода, и терять остаток нельзя.
      while (j < lines.length && !new RegExp(`^ {0,3}${close === '`' ? '`' : '~'}{3,}[ \\t]*$`).test(lines[j]!)) {
        body.push(lines[j]!);
        j += 1;
      }
      out.push(codeBlock(body.join('\n') + (j < lines.length ? '\n' : ''), fence[2] ?? ''));
      i = j + 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const h = el(`h${heading[1]!.length}` as 'h1');
      inline(h, heading[2]!);
      out.push(h);
      i += 1;
      continue;
    }

    if (HR.test(line)) {
      out.push(el('hr'));
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      const quote = el('blockquote');
      for (const node of blocks(body)) quote.append(node);
      out.push(quote);
      continue;
    }

    const table = tableAt(lines, i);
    if (table) {
      out.push(table.el);
      i = table.next;
      continue;
    }

    if (ITEM.test(line)) {
      const list = listAt(lines, i);
      out.push(list.el);
      i = list.next;
      continue;
    }

    // Абзац: до пустой строки или до начала другого блока. Перевод строки внутри
    // абзаца — часть сообщения (у агента это отдельная мысль), поэтому сохраняем.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && !startsBlock(lines, i)) {
      para.push(lines[i]!.trim());
      i += 1;
    }
    if (para.length === 0) {
      // Строка-начало блока, до которой не дошла ни одна ветка выше, — текстом.
      para.push(lines[i]!.trim());
      i += 1;
    }
    const p = el('p');
    inline(p, para.join('\n'));
    out.push(p);
  }
  return out;
}

/** Начинает ли строка новый блок — чтобы абзац на ней остановился. */
function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i]!;
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    tableAt(lines, i) !== null
  );
}

/** Блок кода: сразу текстом, подсветка приезжает лениво отдельным чанком. */
function codeBlock(code: string, lang: string): HTMLElement {
  const pre = el('pre');
  pre.className = 'th-md__pre';
  const codeEl = el('code');
  codeEl.className = lang ? `th-md__code language-${lang.toLowerCase().replace(/[^a-z0-9+#-]/g, '')}` : 'th-md__code';
  codeEl.textContent = code;
  pre.append(codeEl);
  if (lang) void highlightCode(codeEl, code, lang);
  return pre;
}

/** Подсветка кода ленивым чанком highlight.js, узлами и без innerHTML: текст уже
 *  лежит в codeEl, подсветка лишь заменяет его на разобранное дерево. Общая для
 *  ленты и просмотра файлов — доверие к выводу hljs в приложении одно, и оно строгое
 *  (см. hljsNodes). Не тот язык, нет чанка, неожиданный вывод — остаётся текст. */
export async function highlightCode(codeEl: HTMLElement, code: string, lang: string): Promise<void> {
  try {
    const { default: hljs } = await import('./highlight');
    if (!hljs.getLanguage(lang)) return;
    const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    const tree = hljsNodes(html);
    if (!tree) return;
    codeEl.replaceChildren(tree);
    codeEl.classList.add('hljs');
  } catch {
    // Подсветка недоступна — остаётся простой текст, он уже на месте.
  }
}

/** Разметку highlight.js разбираем сами: он экранирует `<`, `>` и `&`, поэтому в
 *  его выводе бывают ровно два тега — открытие и закрытие span. Всё, что на них не
 *  похоже, означает неожиданный вывод: тогда возвращаем null и остаёмся с текстом,
 *  а не пытаемся угадать. */
function hljsNodes(html: string): DocumentFragment | null {
  const root = document.createDocumentFragment();
  const stack: (DocumentFragment | HTMLElement)[] = [root];
  let at = 0;
  const text = (chunk: string): boolean => {
    if (chunk === '') return true;
    // Сырой `<` в тексте означает, что вывод не тот, за который мы его приняли.
    if (chunk.includes('<') || chunk.includes('>')) return false;
    stack[stack.length - 1]!.append(document.createTextNode(chunk.replace(ENTITY, (_m, k: string) => ENTITY_TEXT[k]!)));
    return true;
  };
  HLJS_TAG.lastIndex = 0;
  for (let m = HLJS_TAG.exec(html); m; m = HLJS_TAG.exec(html)) {
    if (!text(html.slice(at, m.index))) return null;
    at = m.index + m[0].length;
    if (m[0] === '</span>') {
      if (stack.length === 1) return null;
      stack.pop();
    } else {
      const span = el('span');
      span.className = m[1]!;
      stack[stack.length - 1]!.append(span);
      stack.push(span);
    }
  }
  if (!text(html.slice(at))) return null;
  return stack.length === 1 ? root : null;
}

/** Таблица GFM: строка шапки, под ней строка-разделитель, дальше — строки данных.
 *  Без разделителя это просто текст с палками, и таблицей он не становится. */
function tableAt(lines: string[], start: number): { el: HTMLElement; next: number } | null {
  const head = lines[start];
  if (head === undefined || !head.includes('|')) return null;
  const sep = lines[start + 1];
  if (sep === undefined || !sep.includes('|') || !TABLE_SEP.test(sep)) return null;
  const align = cells(sep).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
  const table = el('table');
  table.className = 'th-md__table';
  const thead = el('thead');
  const hrow = el('tr');
  cells(head).forEach((c, n) => {
    const th = el('th');
    if (align[n]) th.style.textAlign = align[n]!;
    inline(th, c);
    hrow.append(th);
  });
  thead.append(hrow);
  const tbody = el('tbody');
  let i = start + 2;
  while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
    const row = el('tr');
    cells(lines[i]!).forEach((c, n) => {
      const td = el('td');
      if (align[n]) td.style.textAlign = align[n]!;
      inline(td, c);
      row.append(td);
    });
    tbody.append(row);
    i += 1;
  }
  table.append(thead, tbody);
  // Широкая таблица прокручивается в своей обёртке: иначе она растягивает ленту
  // вбок, и на телефоне уезжает вся беседа, а не одна таблица.
  const wrap = el('div');
  wrap.className = 'th-md__tablewrap';
  wrap.append(table);
  return { el: wrap, next: i };
}

/** Ячейки строки таблицы: крайние палки не считаются, экранированная `\|` — текст. */
function cells(line: string): string[] {
  const out: string[] = [];
  let buf = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === '\\' && body[i + 1] === '|') {
      buf += '|';
      i += 1;
    } else if (ch === '|') {
      out.push(buf.trim());
      buf = '';
    } else buf += ch;
  }
  out.push(buf.trim());
  return out;
}

/** Список от строки start до конца своего уровня. Вложенные разбирает рекурсия
 *  через содержимое пункта: у вложенного отступ глубже, и он уезжает внутрь li. */
function listAt(lines: string[], start: number): { el: HTMLElement; next: number } {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = first[3] !== undefined;
  const indent = width(first[1]!);
  const list = el(ordered ? 'ol' : 'ul');
  list.className = 'th-md__list';
  if (ordered && first[3] !== '1') (list as HTMLOListElement).start = Number(first[3]);
  let i = start;
  while (i < lines.length) {
    if (lines[i]!.trim() === '') {
      // Пустая строка между пунктами список не заканчивает — заканчивает её
      // отсутствие продолжения на том же уровне.
      const next = ITEM.exec(lines[i + 1] ?? '');
      if (!next || width(next[1]!) !== indent) break;
      i += 1;
      continue;
    }
    const m = ITEM.exec(lines[i]!);
    if (!m || width(m[1]!) !== indent || (m[3] !== undefined) !== ordered) break;
    const item = itemAt(lines, i, m);
    const li = el('li');
    const inner = blocks(item.text.split('\n'));
    // Пункт из одного абзаца показываем без <p>: столбик из абзацев в списке
    // расползается зазорами, а пункт — одна строка, а не статья.
    if (inner.length === 1 && inner[0]! instanceof HTMLParagraphElement) li.append(...inner[0]!.childNodes);
    else for (const node of inner) li.append(node);
    list.append(li);
    i = item.next;
  }
  return { el: list, next: i };
}

/** Содержимое пункта: его собственный текст и всё, что отбито глубже маркера. */
function itemAt(lines: string[], start: number, m: RegExpExecArray): { text: string; next: number } {
  const marker = (m[2] ?? `${m[3]}.`).length + 1;
  const content = width(m[1]!) + marker;
  const body = [m[4]!];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      if (width(leading(lines[i + 1] ?? '')) < content || (lines[i + 1] ?? '').trim() === '') break;
      body.push('');
      i += 1;
      continue;
    }
    if (width(leading(line)) < content) break;
    body.push(line.slice(indexAtWidth(line, content)));
    i += 1;
  }
  return { text: body.join('\n'), next: i };
}

const leading = (line: string): string => /^[ \t]*/.exec(line)![0];
/** Ширина отступа: табуляция считается за четыре знака, как её и видят глазами. */
const width = (space: string): number => [...space].reduce((n, ch) => n + (ch === '\t' ? 4 : 1), 0);
/** Сколько знаков строки занимает отступ заданной ширины. */
function indexAtWidth(line: string, target: number): number {
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (n >= target) return i;
    n += line[i] === '\t' ? 4 : 1;
  }
  return line.length;
}

// ── Строка ────────────────────────────────────────────────────────────

/** Разбирает строку и складывает её узлы в parent. Порядок разбора важен:
 *  код в строке гасит всё внутри себя, ссылка — своё содержимое не гасит. */
function inline(parent: ParentNode, text: string): void {
  let buf = '';
  const flush = (): void => {
    if (buf !== '') parent.append(document.createTextNode(buf));
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '`') {
      const code = codeSpan(text, i);
      if (code) {
        flush();
        const node = el('code');
        node.className = 'th-md__inlinecode';
        node.textContent = code.text;
        parent.append(node);
        i = code.next;
        continue;
      }
    }

    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const link = linkAt(text, i);
      if (link) {
        flush();
        parent.append(link.el);
        i = link.next;
        continue;
      }
    }

    if (ch === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^>\s]+)>/.exec(text.slice(i));
      if (auto) {
        flush();
        parent.append(anchor(auto[1]!, auto[1]!));
        i += auto[0].length;
        continue;
      }
    }

    if (ch === 'h' && !isWord(text[i - 1])) {
      const bare = bareUrl(text, i);
      if (bare) {
        flush();
        parent.append(anchor(bare.url, bare.url));
        i = bare.next;
        continue;
      }
    }

    if (ch === '~' && text[i + 1] === '~') {
      const span = emphasisAt(text, i, '~~');
      if (span) {
        flush();
        const node = el('s');
        inline(node, span.text);
        parent.append(node);
        i = span.next;
        continue;
      }
    }

    if (ch === '*' || ch === '_') {
      const double = text[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      if (opens(text, i, marker)) {
        const span = emphasisAt(text, i, marker);
        if (span) {
          flush();
          const node = el(double ? 'strong' : 'em');
          inline(node, span.text);
          parent.append(node);
          i = span.next;
          continue;
        }
      }
    }

    buf += ch;
    i += 1;
  }
  flush();
}

/** Код в строке: сколько backtick открыло, столько же и закрывает. */
function codeSpan(text: string, at: number): { text: string; next: number } | null {
  const open = /^`+/.exec(text.slice(at))![0];
  const rest = text.slice(at + open.length);
  const close = new RegExp(`(?<!\`)${open}(?!\`)`).exec(rest);
  if (!close) return null;
  let body = rest.slice(0, close.index);
  if (body.startsWith(' ') && body.endsWith(' ') && body.trim() !== '') body = body.slice(1, -1);
  return { text: body, next: at + open.length + close.index + open.length };
}

/** Может ли маркер здесь открывать выделение: `2*3*4` — арифметика, а не курсив,
 *  и `foo_bar_baz` — имя, а не курсив; поэтому слева от маркера не должно быть
 *  буквы или цифры, а справа — пробела. */
function opens(text: string, at: number, marker: string): boolean {
  const after = text[at + marker.length];
  if (after === undefined || /\s/.test(after) || after === marker[0]) return false;
  return !isWord(text[at - 1]);
}

/** Парный маркер: закрывающий не может стоять после пробела и не может слипаться
 *  с буквой справа (иначе `_` внутри имени закрыл бы чужой курсив). */
function emphasisAt(text: string, at: number, marker: string): { text: string; next: number } | null {
  let i = at + marker.length;
  while (i < text.length) {
    const found = text.indexOf(marker, i);
    if (found < 0) return null;
    const before = text[found - 1]!;
    const after = text[found + marker.length];
    if (!/\s/.test(before) && !(marker[0] === '_' && isWord(after))) {
      return { text: text.slice(at + marker.length, found), next: found + marker.length };
    }
    i = found + marker.length;
  }
  return null;
}

/** `[текст](адрес)` и `![подпись](адрес)`. Картинку из чужого транскрипта мы не
 *  грузим — она становится ссылкой с подписью: адрес виден, запроса наружу нет. */
function linkAt(text: string, at: number): { el: Node; next: number } | null {
  const image = text[at] === '!';
  const open = at + (image ? 1 : 0);
  const close = text.indexOf(']', open + 1);
  if (close < 0 || text[close + 1] !== '(') return null;
  let depth = 1;
  let i = close + 2;
  for (; i < text.length && depth > 0; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
  }
  if (depth > 0) return null;
  const label = text.slice(open + 1, close);
  const dest = text
    .slice(close + 2, i - 1)
    .trim()
    .replace(/\s+["'(].*$/, '');
  if (!SAFE_SCHEME.test(dest)) return null;
  const a = anchor(dest, label.trim() === '' ? dest : label);
  if (image) a.classList.add('th-md__image');
  return { el: a, next: i };
}

/** Голый адрес в тексте: до пробела, без хвостовой пунктуации и без непарной скобки. */
function bareUrl(text: string, at: number): { url: string; next: number } | null {
  const m = /^https?:\/\/[^\s<>]+/.exec(text.slice(at));
  if (!m) return null;
  let url = m[0];
  for (;;) {
    if (/[.,;:!?»"'’]$/.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(')') && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) url = url.slice(0, -1);
    else break;
  }
  if (url.length <= 'https://'.length) return null;
  return { url, next: at + url.length };
}

/** Ссылка наружу: чужая вкладка и без доступа к нашей странице. */
function anchor(href: string, label: string): HTMLAnchorElement {
  const a = el('a');
  a.className = 'th-md__link';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  if (label.includes('`') || label.includes('*')) inline(a, label);
  else a.textContent = label;
  return a;
}
