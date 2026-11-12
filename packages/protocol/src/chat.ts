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
  /** Пояснение варианта, когда агент его рисует. В отпечаток вопроса не входит. */
  hint?: string;
  /** На варианте стоит указатель агента. */
  selected?: boolean;
  /** Отметка в вопросе с несколькими ответами. */
  checked?: boolean;
  /** Вариант «свой ответ»: после его клавиши агент ждёт текст. Его подпись меняется
   *  по мере набора, поэтому в отпечаток вопроса она не входит. */
  free?: boolean;
}

/** Шаг полосы над вопросом (серия вопросов Claude): вопрос серии или шаг отправки. */
export interface ScreenStep {
  /** Название шага, как его рисует агент. */
  label: string;
  /** Вопрос уже отвечен. */
  done?: boolean;
  /** Шаг, который сейчас на экране. */
  current?: boolean;
  /** Последний шаг — отправка ответов, а не вопрос. */
  submit?: boolean;
}

export interface ScreenQuestion {
  /** Отпечаток заголовка, вариантов и тела — `questionStamp`. */
  stamp: string;
  title: string;
  /** Что агент показал над вопросом: команда, правка, пояснение. */
  body?: string;
  options: ScreenOption[];
  /** Несколько отметок и отдельное подтверждение. */
  multi?: boolean;
  /** Вопрос принимает свой ответ текстом: среди вариантов есть «свой ответ» (он помечен
   *  `free`) либо у вопроса есть поле заметки (Codex). */
  freeText?: boolean;
  /** Поле заметки открыто, и это его текст (пустое поле — пустая строка). Закрытого поля
   *  в ответе нет. */
  notes?: string;
  /** Полоса шагов над вопросом, когда агент её рисует. */
  steps?: ScreenStep[];
  /** Номер текущего шага в `steps`, с единицы. Нет — экран текущий шаг не выделил. */
  step?: number;
}

/** Фоновый агент из списка, который рисует сам агент. Заполнено только нарисованное. */
export interface BackgroundAgent {
  /** Тип агента, как он назван в списке («general-purpose»). */
  type?: string;
  /** Описание задачи. */
  task?: string;
  /** Сколько работает, секунды. */
  elapsed?: number;
  tokens?: number;
}

export interface ScreenState {
  kind: ScreenKind;
  /** Строка работы, как её рисует агент. */
  status?: string;
  /** Секунды работы, если агент показывает. */
  elapsed?: number;
  /** Токены из строки работы, если агент их рисует («↓ 2.1k tokens» → 2100). */
  tokens?: number;
  /** Сколько фоновых агентов ждёт агент («Waiting for 2 background agents to finish»). */
  waiting?: number;
  /** Фоновых команд оболочки («1 shell» в подвале). Агент не рисует — поля нет. */
  shells?: number;
  /** Фоновые агенты списком, когда агент рисует сам список. */
  agents?: BackgroundAgent[];
  /** Число фоновых агентов из подвала («← 2 agents») — только когда списка на экране нет. */
  agentCount?: number;
  /** Для `question` и `permission`. */
  question?: ScreenQuestion;
  /** Вопрос ждёт, но на экране его нет: агент говорит о нём и показывает по клавише
   *  (действие `show-question`). Бывает только при `idle` и `working`. */
  pending?: boolean;
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
  /** Только для `unknown`: какое правило распознавания не сошлось — короткая английская
   *  фраза для диагностики. Текста с экрана в ней нет. */
  why?: string;
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
  /** `over` — отправить поверх текста, который уже набран в строке агента. `key` — ключ
   *  идемпотентности (до 128 знаков): повтор запроса с тем же ключом и текстом в течение
   *  двух минут клавиш не шлёт и получает прежний успешный ответ. Агент, который ключа не
   *  знает, поле отбрасывает. */
  | { kind: 'prompt'; text: string; over?: boolean; key?: string }
  | { kind: 'answer'; stamp: string; option?: string; options?: string[]; text?: string }
  /** Показать ожидающий вопрос (`ScreenState.pending`): клавиша открытия из профиля. */
  | { kind: 'show-question' }
  /** Перейти к шагу `to` (с единицы) полосы над вопросом `stamp`. */
  | { kind: 'step'; stamp: string; to: number }
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
 *  вопрос, на который отвечают. Считается по заголовку, по клавишам с подписями
 *  вариантов и по телу — тому, что агент показал над вопросом (команда, правка):
 *  у запросов разрешения заголовок и варианты типовые, и отличает один запрос от
 *  другого только тело. Любая серия пробельных знаков — пробелы, перенос, отступ — это
 *  один пробел, по краям пробелов нет: тот же вопрос при другой ширине панели переносится
 *  по пробелу иначе, а отпечаток обязан совпасть; пробел внутри строки при этом значим
 *  (`rm -rf / tmp/x` и `rm -rf /tmp/x` — разные запросы). Слово длиннее строки агент рвёт
 *  посередине — такой запрос при другой ширине даёт другой отпечаток, и ответ получит
 *  отказ `stale`. Отметки, указатель и подпись свободного варианта не входят: они
 *  меняются, пока человек отвечает. */
export function questionStamp(
  title: string,
  options: readonly Pick<ScreenOption, 'key' | 'label' | 'free'>[],
  body?: string,
): string {
  const parts = [squeeze(title)];
  for (const option of options) {
    parts.push(option.free ? `${option.key}\u0001` : `${option.key}\u0002${squeeze(option.label)}`);
  }
  const text = `${parts.join('\u0000')}\u0003${squeeze(body ?? '')}`;
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01000193);
}

function squeeze(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
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
