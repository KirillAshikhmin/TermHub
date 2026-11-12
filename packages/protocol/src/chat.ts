// Формы провода чата — нативного интерфейса к Claude Code и Codex поверх панели tmux.
// Одни на агент и веб: живое состояние экрана (`Live`), действие (`Act`), список
// команд (`Commands`) и подробности действия из транскрипта.
//
// Модуль намеренно без зависимостей: веб тянет его подпутём `@termhub/protocol/chat`,
// чтобы в LAN-бандл не уехал libsodium, который тянет корневой index.

export type AgentId = 'claude' | 'codex';

/** Что сейчас на экране агента. `unknown` — экран не узнан: кнопок по догадке нет. */
export type ScreenKind = 'idle' | 'working' | 'question' | 'permission' | 'menu' | 'unknown';

export interface ScreenOption {
  /** Клавиша, которой агент принимает этот вариант (цифра, как он её рисует). */
  key: string;
  label: string;
  /** На варианте стоит указатель агента. */
  selected?: boolean;
  /** Отметка в вопросе с несколькими ответами. */
  checked?: boolean;
  /** Вариант «свой ответ»: после его клавиши агент ждёт текст. Его подпись меняется
   *  по мере набора, поэтому в отпечаток вопроса она не входит. */
  free?: boolean;
}

export interface ScreenQuestion {
  /** Отпечаток заголовка и вариантов — `questionStamp`. */
  stamp: string;
  title: string;
  /** Что агент показал над вопросом: команда, правка, пояснение. */
  body?: string;
  options: ScreenOption[];
  /** Несколько отметок и отдельное подтверждение. */
  multi?: boolean;
  /** Среди вариантов есть «свой ответ» (он помечен `free`). */
  freeText?: boolean;
}

export interface ScreenState {
  kind: ScreenKind;
  /** Строка работы, как её рисует агент. */
  status?: string;
  /** Секунды работы, если агент показывает. */
  elapsed?: number;
  /** Для `question` и `permission`. */
  question?: ScreenQuestion;
  /** id режима из профиля. */
  mode?: string;
  /** Текст в строке ввода агента. */
  input?: string;
  /** Сообщений в очереди агента. */
  queued?: number;
  /** id известного меню из профиля — для `menu`. */
  menu?: string;
  /** Модель, как её называет экран (Codex пишет её в подвале; Claude — нет). */
  model?: string;
}

export interface LiveState {
  ok: true;
  agent: AgentId;
  version?: string;
  /** Версия агента входит в проверенный диапазон профиля. */
  tested: boolean;
  model?: string;
  screen: ScreenState;
  modes: { id: string; label: string }[];
  models: { id: string; label: string }[];
}

export type ChatAction =
  /** `over` — отправить поверх текста, который уже набран в строке агента. */
  | { kind: 'prompt'; text: string; over?: boolean }
  | { kind: 'answer'; stamp: string; option?: string; options?: string[]; text?: string }
  | { kind: 'interrupt' }
  | { kind: 'mode'; to: string }
  | { kind: 'model'; to: string }
  | { kind: 'compact' }
  /** Забрать текст из строки агента: вернуть его и стереть строку. */
  | { kind: 'take-input' };

export interface ChatFailure {
  ok: false;
  reason: string;
  detail: string;
}

export type LiveResult = LiveState | ChatFailure;

export type ActResult = { ok: true; screen: ScreenState; taken?: string } | ChatFailure;

export interface ChatCommand {
  /** Имя без ведущего «/». */
  name: string;
  hint?: string;
  source: 'builtin' | 'user' | 'project' | 'skill' | 'screen';
  args?: string;
}

export type CommandsResult =
  | { ok: true; commands: ChatCommand[]; verified: boolean }
  | ChatFailure;

export interface ToolDetail {
  input?: string;
  output?: string;
  diff?: { path: string; lines: { t: '+' | '-' | ' '; s: string }[] }[];
  pending?: boolean;
  truncated?: boolean;
}

/** Отпечаток вопроса: по нему агент TermHub проверяет, что на экране всё ещё тот
 *  вопрос, на который отвечают. Считается по заголовку и по клавишам с подписями
 *  вариантов; пробелы и переносы выброшены целиком — тот же вопрос при другой ширине
 *  панели переносится иначе, а отпечаток обязан совпасть. Отметки, указатель и подпись
 *  свободного варианта не входят: они меняются, пока человек отвечает. */
export function questionStamp(
  title: string,
  options: readonly Pick<ScreenOption, 'key' | 'label' | 'free'>[],
): string {
  const parts = [squeeze(title)];
  for (const option of options) {
    parts.push(option.free ? `${option.key}\u0001` : `${option.key}\u0002${squeeze(option.label)}`);
  }
  const text = parts.join('\u0000');
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01000193);
}

function squeeze(text: string): string {
  return text.replace(/\s+/gu, '');
}

/** FNV-1a на 32 бита по кодам UTF-16: крипта здесь не нужна — отпечаток сверяет
 *  экран с экраном, а не защищает от подделки. Два прогона с разным зерном дают 64 бита. */
function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    hash = Math.imul(hash ^ (code & 0xff), 0x01000193) >>> 0;
    hash = Math.imul(hash ^ (code >>> 8), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
