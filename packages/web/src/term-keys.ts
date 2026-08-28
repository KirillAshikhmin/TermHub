// Правило Enter для терминала — чистая функция без xterm, чтобы таблицу истинности
// можно было проверить напрямую. Custom-обработчик клавиш xterm (term.ts) вызывает
// её на КАЖДОЕ событие клавиатуры (keydown/keypress/keyup) и исполняет ответ.

export type EnterAction = 'send' | 'newline' | 'suppress' | 'pass';

/** Минимум от KeyboardEvent, нужный правилу (сам KeyboardEvent подходит структурно). */
export interface EnterKeyEvent {
  type: string;
  key: string;
  shiftKey: boolean;
}

/** Что делать с клавишей при данном положении тумблера «Отправлять по Enter»:
 *  `send` — отдать xterm (он сам шлёт \r и гасит событие); `newline` — шлём ESC+CR сами
 *  и гасим keydown; `suppress` — погасить keypress Enter; `pass` — не наша клавиша. */
export function enterAction(e: EnterKeyEvent, enterSends: boolean): EnterAction {
  if (e.key !== 'Enter') return 'pass';
  if (e.type === 'keydown') return e.shiftKey || !enterSends ? 'newline' : 'send';
  // keypress Enter: не погашенный keydown порождает его, и xterm в _keyPress отправил бы
  // второй \r, а браузер вставил бы \n в скрытую textarea — подавляем всегда.
  if (e.type === 'keypress') return 'suppress';
  // keyup и прочее: xterm на keyup держит перефокус — не мешаем.
  return 'pass';
}
