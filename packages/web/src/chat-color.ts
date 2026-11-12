// Цвет в чате: подсветка команды оболочки, метка исхода действия и цвета ANSI в выводе.
// Всё из чужого транскрипта попадает в DOM только узлами с textContent — разметка не
// собирается строкой. Краски — переменные темы (theme.css), своих цветов здесь нет.

import { highlightCode } from './markdown';
import { t } from './i18n';
import type { ToolResult } from './transport';

/** Инструменты, чей аргумент — команда оболочки: `Bash` у Claude, у Codex — `shell`,
 *  `exec_command` и родня. */
const SHELL_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'shell_command', 'local_shell']);

export const isShellTool = (tool: string | undefined): boolean => tool !== undefined && SHELL_TOOLS.has(tool);

// --- команда оболочки ----------------------------------------------------------------

/** Что highlight.js в оболочке не размечает: ключи, перенаправления и операторы, имя
 *  команды в начале и после оператора. Ловится только в тексте вне его собственных узлов
 *  (строки, переменные, комментарии уже разобраны). */
const SH_TOKEN = /(\s+)|(\d*(?:>>?|<)&?\d*|&&|\|\||[|;&])|(--?[A-Za-z0-9][\w-]*(?:=\S*)?)|(\S+)/g;

function shellTokens(node: Text, cmdNext: { v: boolean }): void {
  const text = node.data;
  const parts: Array<string | HTMLSpanElement> = [];
  const span = (cls: string, s: string): HTMLSpanElement => {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = s;
    return el;
  };
  SH_TOKEN.lastIndex = 0;
  for (let m = SH_TOKEN.exec(text); m; m = SH_TOKEN.exec(text)) {
    if (m[1] !== undefined) {
      parts.push(m[1]);
    } else if (m[2] !== undefined) {
      parts.push(span('th-sh-op', m[2]));
      // После конвейера и «;» начинается новая команда; после перенаправления — файл.
      cmdNext.v = /^(?:&&|\|\||[|;&])$/.test(m[2]);
    } else if (m[3] !== undefined) {
      parts.push(span('th-sh-flag', m[3]));
    } else {
      const word = m[4]!;
      parts.push(cmdNext.v ? span('th-sh-cmd', word) : word);
      cmdNext.v = false;
    }
  }
  node.replaceWith(...parts);
}

/** Подсвечивает команду в `el` (там уже лежит её текст): highlight.js даёт строки,
 *  переменные и комментарии, остальное — имя команды, ключи, перенаправления — докрашивает
 *  второй проход по несмеченному тексту. Сбой подсветки оставляет простой текст. */
export async function highlightShell(el: HTMLElement, code: string): Promise<void> {
  await highlightCode(el, code, 'bash');
  if (!el.classList.contains('hljs')) return;
  const cmdNext = { v: true };
  // Обходим прямых потомков: текст внутри размеченных узлов уже окрашен.
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) shellTokens(child as Text, cmdNext);
    else cmdNext.v = false;
  }
  el.classList.add('th-sh');
}

// --- исход действия ------------------------------------------------------------------

export type MarkState = 'done' | 'running' | 'failed' | 'stopped';

/** Ставит метку исхода: точка цветом состояния, у ошибки — ещё код выхода. Нет исхода
 *  (старый агент, результат за краем окна) — метка скрыта. */
export function paintMark(mark: HTMLElement, result: ToolResult | null): void {
  mark.className = 'th-tool__mark';
  mark.textContent = '';
  mark.hidden = result === null;
  if (!result) return;
  mark.classList.add(`is-${result.state}`);
  const label = t(`chat.tool.state.${result.state}`);
  const code = result.state === 'failed' && result.exit !== undefined ? t('chat.tool.exit', { code: result.exit }) : '';
  mark.title = code ? `${label}: ${code}` : label;
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', mark.title);
  if (code) mark.textContent = code;
}

export function createMark(result: ToolResult | null): HTMLSpanElement {
  const mark = document.createElement('span');
  paintMark(mark, result);
  return mark;
}

// --- цвета ANSI ----------------------------------------------------------------------

/** Цветовые SGR → узлы с классами `th-ansi-<0..7>` и `th-ansi-bold`; остальные управляющие
 *  последовательности (курсор, очистка, OSC, 256 цветов и truecolor) отбрасываются, цвет
 *  из них не берётся. Текст — только textContent. Нет ни одной последовательности —
 *  один текстовый узел, как было. */
// eslint-disable-next-line no-control-regex
const ESC = /\x1b(?:\[([0-9;:?<=>]*)([ -/]*[@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function ansiNodes(text: string): DocumentFragment {
  const out = document.createDocumentFragment();
  let color = -1;
  let bold = false;
  let at = 0;
  const put = (chunk: string): void => {
    if (!chunk) return;
    if (color < 0 && !bold) {
      out.append(document.createTextNode(chunk));
      return;
    }
    const span = document.createElement('span');
    span.className = [color >= 0 ? `th-ansi-${color}` : '', bold ? 'th-ansi-bold' : ''].filter(Boolean).join(' ');
    span.textContent = chunk;
    out.append(span);
  };
  ESC.lastIndex = 0;
  for (let m = ESC.exec(text); m; m = ESC.exec(text)) {
    put(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[2] !== 'm') continue;
    const codes = (m[1] ?? '').split(/[;:]/).map((c) => (c === '' ? 0 : Number(c)));
    for (let i = 0; i < codes.length; i += 1) {
      const c = codes[i]!;
      if (c === 0) {
        color = -1;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) color = c - 30;
      else if (c >= 90 && c <= 97) color = c - 90;
      else if (c === 39) color = -1;
      else if (c === 38 || c === 48) i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0; // 256/truecolor не берём
    }
  }
  put(text.slice(at));
  return out;
}
