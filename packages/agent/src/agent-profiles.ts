// Профили агентов — данные, по которым чат читает экран и нажимает клавиши: что
// считать строкой ввода, вопросом, меню; чем отправить, прервать, сменить режим.
// Всё здесь снято замерами на живых агентах (docs/native-agent-ui.ru.md); новая версия
// агента чинится правкой этих данных и снимка в test/fixtures/screens, а не логики
// разбора в agent-screen.ts.

import type { AgentId, ChatCommand } from '@termhub/protocol/chat';

/** Режим агента и чем он виден в подвале экрана. Режим без `sign` — тот, что подвал
 *  не называет вовсе (у Codex так выглядит обычный режим). */
export interface ModeSign {
  id: string;
  label: string;
  sign?: RegExp;
}

export interface ModelEntry {
  /** Имя, которым модель называют команде смены модели. */
  id: string;
  /** Как модель названа в меню агента и на экране. */
  label: string;
  /** Чем узнать её в идентификаторе модели из транскрипта. */
  match: RegExp;
  /** Окно контекста в токенах — только то, что измерено; нет значения — предел неизвестен. */
  context?: number;
}

/** Диалог с вариантами: вопрос агента или запрос разрешения. */
export interface DialogSign {
  kind: 'question' | 'permission';
  /** Строка-подсказка под вариантами. Без неё диалог узнаётся только по `title`. */
  footer?: RegExp;
  /** Строка, с которой начинается заголовок. Задана — заголовок обязан найтись. */
  title?: RegExp;
  /** Что значит строка под вариантом с отступом ровно до его подписи: продолжение
   *  подписи (перенос) или пояснение к варианту. Строка с большим отступом — всегда
   *  пояснение. */
  below: 'label' | 'description';
  /** Свободный ответ — последний вариант перед внутренней линейкой: его подпись
   *  меняется по мере набора, и по тексту его не узнать. */
  freeBeforeRule?: boolean;
  /** Заголовок блока, под которым стоит диалог (с начала строки): шапка читается только
   *  до него, и без него диалог этим диалогом не считается. */
  under?: RegExp;
  /** Счётчик над заголовком («1 of 2»): группа 1 — номер вопроса, группа 2 — сколько их.
   *  Узнаётся только в этом диалоге. Когда вопросов больше одного, счётчик входит в
   *  отпечаток: одинаковые вопросы подряд иначе неотличимы, и ответ на первый достался
   *  бы второму. */
  counter?: RegExp;
  /** Свободный ответ — всегда последний вариант (его дописывает сам агент); значение —
   *  его подпись, пока в ней ничего не набрано. */
  freeLast?: RegExp;
  /** Строка счётчика над заголовком, с которой диалог этим диалогом не считается
   *  («Field 1/3» — форма из нескольких полей, а не запрос разрешения). */
  notCounter?: RegExp;
  /** Свой ответ — заметка к варианту (Codex): поле открывается клавишей `keys.notes`,
   *  текст набирается в нём, клавиша отправки отвечает. */
  notes?: NotesSign;
  /** Над заголовком обязана стоять строка `chip` (полоса шагов): без неё экран с тем же
   *  подвалом — не этот диалог, а меню агента с похожей подсказкой. */
  strip?: true;
  /** Над вопросом, под заголовком `under`, бывают строки очереди сообщений
   *  (`screen.queue.rows`): в шапку вопроса они не входят. */
  skipQueue?: true;
  /** Строка под вариантами вопроса с отметками, которая вариантом не является (кнопка
   *  отправки): стоит левее пояснений и в пояснение последнего варианта не входит. */
  submitRow?: RegExp;
  /** Отметка в конце подписи варианта, которым на вопрос уже ответили (серия вопросов,
   *  возврат на отвеченный): в подпись и в отпечаток не входит — вопрос тот же. */
  answered?: RegExp;
  /** Клавиша прерывания на этом диалоге его не закрывает, а делает другое (прерывает ход
   *  агента): действие `interrupt` здесь клавишу не шлёт. */
  noInterrupt?: true;
}

/** Поле заметки в диалоге. Подсказки сверяются целиком: свой ответ измерен только на
 *  одиночном вопросе, и другой состав подсказок (вопросов несколько) его не предлагает. */
export interface NotesSign {
  /** Подсказка под вариантами, пока поле закрыто (вся, одной строкой). */
  closed: RegExp;
  /** Подсказка при открытом поле. */
  open: RegExp;
  /** Строка самого поля над подсказкой: группа 1 — текст. */
  line: RegExp;
  /** Подпись варианта, к которому идёт свой ответ; он обязан быть последним. */
  other: RegExp;
}

/** Известное меню: чат его не разбирает, а показывает окошком терминала. */
export interface MenuSign {
  id: string;
  /** Строка-заголовок меню (без отступов). */
  sign: RegExp;
  /** Последняя строка экрана. Нет — последней обязана быть строка варианта. */
  footer?: RegExp;
}

/** Приглашение «вопрос ждёт»: вопроса на экране нет, агент говорит о нём и называет
 *  клавишу. Узнаётся либо по подвалу строки ввода, либо по блоку прямо над ней. */
export interface PendingSign {
  /** Какая клавиша профиля названа этим приглашением. */
  key: 'showPending' | 'answerPending';
  /** Признак в подвале строки ввода. */
  footer?: RegExp;
  /** Блок прямо над строкой ввода: заголовок `head` с начала строки, под ним строки с
   *  отступом, среди них `count` (группа 1 — число вопросов) и сразу под ней `hint`.
   *  Строка `hint` обязана быть нарисована тусклым — так агент рисует подсказки, а
   *  текст переписки так не выглядит. */
  block?: { head: RegExp; count: RegExp; hint: RegExp };
  /** После клавиши годится любой изменившийся экран, а не только вопрос: в том же блоке
   *  агент держит и другой отложенный ввод, и что откроется, заранее не известно. */
  anyScreen?: true;
}

/** Очередь сообщений агента на экране. */
export interface QueueSign {
  /** Первая строка сообщения в очереди. */
  item: RegExp;
  /** Подпись, над которой стоят сообщения (тогда считаются только строки прямо над ней).
   *  Между подписью и строкой работы бывает сколько угодно пустых строк: беседа короткая,
   *  панель высокая. */
  under?: RegExp;
  /** Тексты сообщений: `text` — первая строка сообщения (группа 1 — текст), `more` —
   *  следующая его строка (группа 1 — текст), `cut` — строка «дальше не показано», `flat` —
   *  первая строка сообщения нарисована одним цветом (реплика беседы над очередью
   *  начинается тем же знаком, но меняет цвет после него). Нет — сообщения только считаются. */
  rows?: { text: RegExp; more: RegExp; cut?: RegExp; flat?: true };
  /** Чем агент называет клавишу возврата из очереди (`keys.unqueue`) и что она вернёт:
   *  `sign` — заглушка пустой строки ввода (`where: 'placeholder'`) либо строка сразу под
   *  последним сообщением очереди (`where: 'below'`). Без этой подписи на экране клавиша
   *  не шлётся: в том же блоке Codex держит вопросы, и та же клавиша открывает их. */
  edit?: { where: 'placeholder' | 'below'; sign: RegExp; scope: 'last' | 'all' };
}

export interface ScreenSigns {
  /** Знак строки ввода и указателя в списках. */
  prompt: string;
  /** Как устроена строка ввода: `ruled` — между двумя линейками, подвал под нижней;
   *  `open` — строка, пустая строка, подвал. */
  box: 'ruled' | 'open';
  /** Линейка рамки (вся строка). В верхнюю линейку Claude вписывает подпись сессии. */
  rule: RegExp;
  /** `open`: какой бывает последняя строка подвала при строке ввода… */
  footer?: RegExp;
  /** …и какой не бывает ни одна его строка: подсказки меню выглядят так же, как подвал. */
  notFooter?: RegExp;
  /** `open`: сколько строк занимает подвал (строка состояния и строка подсказок под
   *  ней). Строки над последней — любые с отступом: строку состояния собирает
   *  пользователь, и узнавать её по содержимому нельзя. */
  footerLines?: number;
  /** Строка состояния в подвале: пункты разделены `sep`. Пункт, целиком совпавший с
   *  `working` или `idle`, называет состояние агента; модель ищется среди пунктов по
   *  `models` и `efforts` профиля. Остальные пункты пропускаются. */
  statusLine?: { sep: RegExp; working: RegExp; idle: RegExp };
  /** Список под подвалом, который к строке ввода не относится (фоновые агенты Claude):
   *  пустая строка, `head`, затем от одной до `max` строк `item` — до конца экрана. */
  tray?: {
    head: RegExp;
    item: RegExp;
    max: number;
    /** Строка агента в списке: группа 1 — тип, группа 2 — всё остальное (задача, а за
     *  колонкой пробелов — время и токены). */
    entry: RegExp;
  };
  /** Счётчики фоновой работы среди пунктов подвала (пункты разделены `sep`): группа 1 —
   *  число. Пункт обязан совпасть целиком. */
  background?: { sep: RegExp; shells: RegExp; agents: RegExp };
  /** Вопрос ждёт, но на экране его нет: приглашения, какими агент об этом говорит.
   *  Клавишу действия `show-question` называет то приглашение, что сейчас на экране. */
  pending?: PendingSign[];
  /** Строка переписки агента (реплика, вызов инструмента). Нужна только причине отказа:
   *  отличает оборванный экран агента от экрана, где агента нет вовсе. */
  talk: RegExp;
  /** Признак работы в подвале. */
  working?: RegExp;
  /** Строка работы над строкой ввода: группа 1 — текст, группа 2 — время и прочее. */
  status: RegExp;
  /** Строка ожидания фоновых агентов на месте строки работы: группа 1 — их число. */
  waiting?: RegExp;
  /** Очередь: строка сообщения в очереди; `under` — подпись, над которой эти строки
   *  стоят (тогда считаются только строки прямо над ней). */
  queue: QueueSign;
  /** Строки над заголовком вопроса, которые в заголовок не входят (вкладки, счётчик). */
  chip: RegExp;
  /** Полоса шагов в строке `chip` («←  ☒ Название  ☐ Название  ✔ Submit  →»): `item` —
   *  глобальный признак шага (группа 1 — знак, группа 2 — название), `done` и `submit` —
   *  знаки отвеченного вопроса и шага отправки. Текущий шаг нарисован с фоном. */
  steps?: { item: RegExp; done: string; submit: string };
  /** Подпись варианта «свой ответ». */
  free: RegExp;
  dialogs: DialogSign[];
  menus: MenuSign[];
  /** Строка списка команд по «/»: группа 1 — имя без «/», группа 2 — подсказка. */
  popup: RegExp;
  /** Продолжение подсказки на следующей строке: группа 1 — текст. */
  popupMore?: RegExp;
  /** Подсказка списка подстановки прямо над строкой ввода (упоминания по «@»): пока он
   *  открыт, клавиши отправки и очереди вставляют выбранное, а не отправляют. */
  picker?: RegExp;
  /** Конец текста, на котором агент открывает список упоминаний. */
  mention?: RegExp;
  /** Заглушка большой вставки в строке ввода («[Pasted text #1 +4 lines]») — вся строка. */
  pasted?: RegExp;
  /** Как подвал называет режим: группа 1 — название, каким его рисует агент. Нужен, чтобы
   *  назвать режим, которого в `modes` нет. */
  modeLine?: RegExp;
}

export interface AgentProfile {
  agent: AgentId;
  name: string;
  /** Версии, на которых профиль проверен снимками, включительно. */
  tested: { min: string; max: string };
  /** Команда панели (`pane_current_command`), под которой идёт агент. Другая — в панели
   *  не агент (оболочка после его выхода), каким бы ни был кадр на экране. */
  command: RegExp;
  keys: {
    submit: string;
    interrupt: string;
    /** Следующий режим по кругу, в порядке `modes`. */
    modeCycle: string;
    /** Перенос строки внутри запроса (одной посылкой). */
    newline: string;
    /** Стереть строку ввода: нажатия по порядку, каждое — отдельной посылкой.
     *  ТОЛЬКО при непустой строке: на пустой те же клавиши у Claude открывают меню
     *  отката, а Codex закрывают. */
    clearInput: string[];
    /** Поставить набранное в очередь работающего агента. Нет — работающему запрос уходит
     *  клавишей `submit` (Claude сам ставит его в очередь). */
    queue?: string;
    /** Стереть текущую строку ввода у работающего агента, не трогая его работу; строк
     *  несколько — нажатие повторяется. Нет — безопасного способа у агента не измерено. */
    clearBusy?: string;
    /** Вернуть сообщение из очереди в строку ввода (`screen.queue.edit` говорит, какое).
     *  ТОЛЬКО при пустой строке ввода: Codex заменяет набранное возвращённым сообщением,
     *  Claude приписывает очередь перед набранным. Без очереди та же клавиша у Claude —
     *  история запросов. */
    unqueue?: string;
    /** Показать ожидающий вопрос (`screen.pending`). Нет — агент такого не рисует. */
    showPending?: string;
    /** Ответить на вопрос из очереди отложенного ввода (`screen.pending` с блоком). */
    answerPending?: string;
    /** Указатель диалога на вариант ниже — для своего ответа заметкой (`DialogSign.notes`). */
    optionDown?: string;
    /** Открыть поле заметки в диалоге. */
    notes?: string;
    /** Следующий и предыдущий шаг полосы над вопросом (`screen.steps`). */
    stepNext?: string;
    stepPrev?: string;
  };
  modes: ModeSign[];
  models: ModelEntry[];
  /** Уровни рассуждений, которые экран дописывает к имени модели. */
  efforts: string[];
  /** Имена команд без «/». */
  commands: { model: string; compact: string };
  builtins: ChatCommand[];
  screen: ScreenSigns;
}

function builtins(rows: [name: string, hint: string, args?: string][]): ChatCommand[] {
  return rows.map(([name, hint, args]) => ({
    name,
    hint,
    source: 'builtin' as const,
    ...(args ? { args } : {}),
  }));
}

/** Claude Code 2.1.322. */
const CLAUDE: AgentProfile = {
  agent: 'claude',
  name: 'Claude Code',
  tested: { min: '2.1.322', max: '2.1.322' },
  // Claude зовёт свой процесс номером версии (замер: и пока идёт команда оболочки);
  // установка через npm идёт под node.
  command: /^(?:\d+\.\d+\.\d+|claude|node)$/,
  keys: {
    submit: '\r',
    interrupt: '\x1b',
    modeCycle: '\x1b[Z',
    newline: '\x1b\r',
    clearInput: ['\x1b', '\x1b'],
    // Ctrl+U: стирает строку ввода (у многострочного текста — по строке и по переносу за
    // нажатие), работу не прерывает; на ожидании ввода стирает так же (замер 12.11.2026).
    clearBusy: '\x15',
    // Стрелка вверх — так её называет заглушка строки ввода: «Press up to edit queued
    // messages». Возвращает в строку всю очередь разом, по сообщению на строку.
    unqueue: '\x1b[A',
    // Стрелка вправо измерена (переход к подтверждению ответов); влево — по стрелке «←»
    // самой полосы и подсказке «Tab/Arrow keys to navigate», живьём не измерена.
    stepNext: '\x1b[C',
    stepPrev: '\x1b[D',
  },
  modes: [
    { id: 'manual', label: 'Manual', sign: /\bmanual mode on\b/ },
    { id: 'accept', label: 'Accept edits', sign: /\baccept edits on\b/ },
    { id: 'plan', label: 'Plan', sign: /\bplan mode on\b/ },
    { id: 'auto', label: 'Auto', sign: /\bauto mode on\b/ },
  ],
  models: [
    { id: 'opus', label: 'Opus 5.5', match: /opus/i },
    { id: 'fable', label: 'Fable 5.2', match: /fable/i },
    { id: 'sonnet', label: 'Sonnet 5.5', match: /sonnet/i },
    { id: 'haiku', label: 'Haiku 5.5', match: /haiku/i },
  ],
  efforts: [],
  commands: { model: 'model', compact: 'compact' },
  builtins: builtins([
    ['add-dir', 'Add a new working directory', '<path>'],
    ['advisor', 'Let Claude consult a stronger model at key moments'],
    ['artifacts', 'Browse your published and shared artifacts'],
    ['autocompact', 'Set how full the context gets before auto-summarizing'],
    ['autofix-pr', 'Monitor and autofix any issues with the current PR'],
    ['background', 'Send this session to the background'],
    ['branch', 'Create a branch of the current conversation'],
    ['btw', 'Ask a quick side question', '<question>'],
    ['bug', 'Report a bug or share your conversation'],
    ['cd', 'Move this session to a new working directory', '<path>'],
    ['chrome', 'Open Claude in Chrome settings'],
    ['clear', 'Start a new session with empty context'],
    ['color', 'Set the prompt bar color for this session'],
    ['compact', 'Free up context by summarizing the conversation so far'],
    ['config', 'Open settings'],
    ['context', 'Visualize current context usage as a colored grid'],
    ['copy', "Copy Claude's last response to clipboard"],
    ['desktop', 'Continue the current session in Claude Desktop'],
    ['diff', 'Toggle the diff panel showing uncommitted changes'],
    ['effort', 'Set effort level for model usage'],
    ['exit', 'Exit the CLI'],
    ['export', 'Export the current conversation to a file or clipboard'],
    ['fast', 'Toggle fast mode'],
    ['feedback', 'Send feedback to Anthropic or report a bug'],
    ['focus', 'Toggle focus view'],
    ['fork', 'Copy this conversation into a new background session'],
    ['goal', 'Set a goal Claude checks before stopping'],
    ['help', 'Show help and available commands'],
    ['hooks', 'View hook configurations for tool events'],
    ['ide', 'Manage IDE integrations and show status'],
    ['import', 'Import config from another AI coding agent'],
    ['install-github-app', 'Set up Claude GitHub Actions for a repository'],
    ['install-slack-app', 'Install the Claude Slack app'],
    ['keybindings', 'Open your keyboard shortcuts file'],
    ['list-agents', 'List subagents, teammates, and other Claude sessions'],
    ['login', 'Sign in with your Anthropic account'],
    ['logout', 'Sign out from your Anthropic account'],
    ['mcp', 'Manage MCP servers'],
    ['memory', 'Edit CLAUDE.md files and memory settings'],
    ['mobile', 'Show QR code to download the Claude mobile app'],
    ['model', 'Set the AI model for Claude Code'],
    ['output-style', 'List output styles or switch to one'],
    ['permissions', 'Manage allow and deny tool permission rules'],
    ['plan', 'Enable plan mode or view the current session plan'],
    ['plugin', 'Manage Claude Code plugins'],
    ['privacy-settings', 'View and update your privacy settings'],
    ['rate-limit-options', 'Manage usage limits and upgrade options'],
    ['recap', 'Generate a one-line session recap now'],
    ['release-notes', 'View release notes'],
    ['reload-plugins', 'Activate pending plugin changes in the current session'],
    ['reload-skills', 'Pick up skills added or changed on disk'],
    ['remote-control', 'Control this session from your phone or claude.ai/code'],
    ['remote-env', 'Choose the default environment for cloud agents'],
    ['rename', 'Rename the current conversation'],
    ['restart', 'Restart Claude Code and keep this session'],
    ['resume', 'Resume a previous conversation'],
    ['rewind', 'Restore the code and/or conversation to a previous point'],
    ['scroll-speed', 'Adjust mouse wheel scroll speed'],
    ['skills', 'List available skills'],
    ['status', 'Show Claude Code status'],
    ['subtask', 'Send a subagent off with your full context'],
    ['tasks', 'View and manage everything running in the background'],
    ['teleport', 'Send this session to the cloud'],
    ['terminal-setup', 'Install Shift+Enter key binding for newlines'],
    ['theme', 'Change the theme'],
    ['tui', 'Set the terminal UI renderer (default | fullscreen)'],
    ['usage', 'Show session cost, plan usage, and activity stats'],
    ['voice', 'Toggle voice mode'],
    ['web-setup', 'Set up cloud sessions with your GitHub account'],
    ['workflows', 'Browse running and completed workflows'],
  ]),
  screen: {
    prompt: '❯',
    box: 'ruled',
    // «──────── имя ─»: подпись сессии стоит в конце верхней линейки.
    rule: /^─{8,}(?: \S(?:.*\S)? ─+)?$/,
    // Указатель списка («⏺») переходит со строки на строку, первой всегда стоит «main».
    tray: {
      head: /^\s{2}[⏺◯] main$/,
      item: /^\s{2}[⏺◯] \S/,
      max: 20,
      entry: /^\s{2}[⏺◯] (\S+(?: \S+)*)(?:\s{2,}(\S.*))?$/,
    },
    background: { sep: /\s·\s/, shells: /^(\d+) shells?$/, agents: /^← (\d+) agents?$/ },
    talk: /^[❯⏺]\s/,
    working: /\besc to interrupt\b/,
    // Спиннер меняет глиф на каждом кадре, поэтому глиф не перечислен: любой знак,
    // кроме тех, с которых начинаются реплики и вывод инструментов.
    status: /^[^\s\p{L}\p{N}⏺❯⎿●]\s(\S.*?…)(?:\s+\((.+)\))?$/u,
    waiting: /^[^\s\p{L}\p{N}⏺❯⎿●]\sWaiting for (\d+) background agents? to finish$/u,
    queue: {
      item: /^❯\s/,
      under: /^\s+ctrl\+x ctrl\+s to send now$/,
      rows: { text: /^❯[ \u00a0](.*)$/, more: /^\s{2}(.*)$/, flat: true },
      edit: { where: 'placeholder', sign: /^Press up to edit queued messages$/, scope: 'all' },
    },
    chip: /^[←\s]*[☐☒✔]\s/,
    steps: { item: /([☐☒✔])\s+(\S(?:.*?\S)?)(?=\s+[☐☒✔→]|\s*$)/gu, done: '☒', submit: '✔' },
    free: /^Type something\.?$/,
    dialogs: [
      // Подвал «Enter to select» стоит и под меню Claude (тема, настройки): вопрос отличает
      // полоса шагов над заголовком — она есть и у одиночного вопроса («☐ Название»).
      {
        kind: 'question',
        footer: /^Enter to select\b/,
        below: 'description',
        freeBeforeRule: true,
        strip: true,
        submitRow: /^\s+Submit$/,
        answered: /\s✔$/,
      },
      // Заголовок измерен один — «Do you want to create hello.txt?»; под тем же подвалом
      // Claude спрашивает и другое (подтверждение плана), и это не запрос разрешения.
      { kind: 'permission', footer: /^Esc to cancel\b/, title: /^Do you want to\b/, below: 'label' },
      { kind: 'question', title: /^Ready to submit your answers\?$/, below: 'label' },
    ],
    menus: [
      { id: 'trust', sign: /^Accessing workspace:$/, footer: /^Enter to confirm · Esc to cancel$/ },
      { id: 'model', sign: /^Select model$/, footer: /^Enter to set as default\b/ },
      { id: 'model-confirm', sign: /^Switch model\?$/ },
      { id: 'rewind', sign: /^Rewind$/, footer: /^Enter to continue · Esc to cancel$/ },
      // Окно справки (/help): вкладки в первой строке окна, внизу одна подсказка.
      { id: 'help', sign: /^Help\s+General\s+Commands\s+Custom commands$/, footer: /^Esc to cancel$/ },
    ],
    popup: /^\s{2}[❯ ]\s\/(\S+)(?:\s{2,}(\S.*))?$/,
    popupMore: /^\s{12,}(\S.*)$/,
    pasted: /^\[Pasted text #\d+ \+\d+ lines\]$/,
    // «⏵⏵ accept edits on (shift+tab to cycle)», «⏸ plan mode on (shift+tab to cycle)».
    modeLine: /(\p{L}[\p{L} ]*? on) \(shift\+tab to cycle\)/u,
  },
};

/** Codex CLI 0.167.0–0.167.2, запущенный пресетом TermHub (`tui.animations=false`,
 *  `--no-alt-screen`). */
const CODEX: AgentProfile = {
  agent: 'codex',
  name: 'Codex',
  tested: { min: '0.167.0', max: '0.167.2' },
  // «codex» (замер 0.167.2: и пока идёт команда оболочки); обёртка npm идёт под node.
  command: /^(?:codex|node)$/,
  keys: {
    submit: '\r',
    interrupt: '\x1b',
    modeCycle: '\x1b[Z',
    newline: '\x1b\r',
    clearInput: ['\x03'],
    // Tab — так его называет подвал работающего Codex с текстом в строке: «tab to queue
    // message». Enter там отправляет текст сразу в идущий ход, а не в очередь; на ожидании
    // ввода Tab отправляет, как Enter (замер).
    queue: '\t',
    // Ctrl+U: стирает строку ввода, на пустой ничего не делает, работу не прерывает (замер).
    clearBusy: '\x15',
    // Ctrl+/ — так его называет сам подвал: «main needs input · ⌃/ to switch».
    // Shift+← — так его называет блок очереди: «⇧← edit last queued message». Возвращает
    // в строку последнее сообщение, прочие остаются в очереди (замер 12.11.2026).
    unqueue: '\x1b[1;2D',
    showPending: '\x1f',
    // Shift+← (CSI 1;2 D) — так его называет блок очереди: «⇧← to answer».
    answerPending: '\x1b[1;2D',
    optionDown: '\x1b[B',
    notes: '\t',
  },
  modes: [
    { id: 'default', label: 'Default' },
    { id: 'plan', label: 'Plan', sign: /\bPlan mode\b/ },
  ],
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', match: /^gpt-6\.1-sol$/i },
    { id: 'gpt-6-astra', label: 'GPT-6-Astra', match: /^gpt-6-astra$/i, context: 258400 },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', match: /^gpt-6\.1[- ]terra$/i },
    { id: 'gpt-6-sol', label: 'GPT-6-Sol', match: /^gpt-6-sol$/i },
    { id: 'gpt-6-luna', label: 'GPT-6-Luna', match: /^gpt-6-luna$/i },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', match: /^gpt-5\.6-sol$/i },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', match: /^gpt-5\.6-terra$/i },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', match: /^gpt-5\.6-luna$/i },
  ],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  commands: { model: 'model', compact: 'compact' },
  builtins: builtins([
    ['model', 'choose what model and reasoning effort to use'],
    ['fast', '2x speed, increased usage'],
    ['presets', 'run or save reusable prompts and slash commands'],
    ['ide', 'include current selection, open files, and other context from your IDE'],
    ['permissions', 'choose what Codex is allowed to do'],
    ['keymap', 'remap TUI shortcuts'],
    ['vim', 'toggle Vim mode for the composer'],
    ['experimental', 'toggle experimental features'],
    ['approve', 'approve one retry of a recent auto-review denial'],
    ['memories', 'configure memory use and generation'],
    ['skills', 'use skills to improve how Codex performs specific tasks'],
    ['import', 'import setup, this project, and recent chats from Claude Code'],
    ['hooks', 'view and manage lifecycle hooks'],
    ['review', 'review my current changes and find issues'],
    ['rename', 'rename the current thread'],
    ['new', 'start a new chat during a conversation'],
    ['archive', 'archive this session'],
    ['delete', 'permanently delete this session'],
    ['resume', 'resume a saved chat'],
    ['fork', 'fork the current chat'],
    ['worktree', 'start or continue a conversation in a new worktree'],
    ['app', 'continue this session in the Desktop app'],
    ['init', 'create an AGENTS.md file with instructions for Codex'],
    ['compact', 'summarize conversation to prevent hitting the context limit'],
    ['config', 'configure Codex preferences'],
    ['recap', 'summarize the current conversation now'],
    ['plan', 'switch to Plan mode'],
    ['voice', 'start or stop voice; use /voice settings to choose a voice'],
    ['goal', 'set or view the goal for a long-running task'],
    ['agents', 'open the agent command center'],
    ['side', 'start a side conversation in an ephemeral fork'],
    ['copy', 'copy the last response or part of it'],
    ['export', 'export the conversation as markdown'],
    ['raw', 'toggle raw scrollback mode for copy-friendly terminal selection'],
    ['tui', 'choose the TUI mode for the next launch'],
    ['diff', 'show git diff (including untracked files)'],
    ['mention', 'mention a file'],
    ['status', 'show current session configuration and token usage'],
    ['daemon', 'Manage the local background server'],
    ['warnings', 'view retained warnings and diagnostic details'],
    ['cd', 'change the current working directory'],
    ['pwd', 'show the current working directory'],
    ['usage', 'view account usage or use a usage limit reset'],
    ['title', 'configure which items appear in the terminal title'],
    ['statusline', 'configure which items appear in the status line'],
    ['theme', 'choose a syntax highlighting theme'],
    ['mcp', 'list MCP tools; use /mcp verbose or /mcp login <name>'],
    ['plugins', 'browse plugins'],
    ['logout', 'log out of Codex'],
    ['exit', 'exit Codex'],
    ['feedback', 'send logs to maintainers'],
    ['ps', 'list background terminals'],
    ['stop', 'stop all background terminals'],
    ['clear', 'clear the terminal and start a new chat'],
    ['subagents', "switch between this session's subagents"],
  ]),
  screen: {
    prompt: '›',
    box: 'open',
    rule: /^─{8,}$/,
    // Последней строкой бывает и одна подсказка очереди — у работающего Codex с текстом в
    // строке ввода, когда строка состояния собрана пользователем.
    footer: /^\s{2}\S.* · \S|\bcontext left$|^\s{2}tab to queue message$/,
    // Подсказку очереди Codex рисует только во время хода: она называет работу и тогда,
    // когда строку работы вытеснил за пределы поиска высокий список над строкой ввода.
    working: /\btab to queue message\b/,
    notFooter: /\b(?:enter|esc)\b/i,
    footerLines: 3,
    statusLine: { sep: /\s{2,}|\s·\s/, working: /^Working$/, idle: /^Ready$/ },
    // Побочная беседа (/side), пока главный поток ждёт ответа на вопрос. Клавиша названа в
    // том же пункте подвала — без неё признака нет («main finished» вопросом не является).
    pending: [
      { key: 'showPending', footer: /\bmain needs input · ⌃\/ to switch\b/ },
      // Очередь отложенного ввода, пока Codex работает: вопрос стоит в ней строкой
      // «? N question(s)». Прочий отложенный ввод в той же очереди вопросом не является.
      // Вопрос попадает туда из request_user_input_async — он хода не останавливает.
      {
        key: 'answerPending',
        block: {
          head: /^• Queued follow-up inputs$/,
          // За числом бывает таймер: «? 1 question · 20s».
          count: /^\s{2}\? (\d+) questions?(?: · \d[\dhms ]*)?$/,
          hint: /^\s{4}⇧← to answer$/,
        },
        anyScreen: true,
      },
    ],
    talk: /^[›•]\s/,
    // За скобкой бывает приписка: «· 1 background terminal running · /ps to view · …».
    // Пока ход ждёт фоновую команду, строка работы зовётся иначе, скобка та же.
    // Сжатие контекста (/compact) — третье название с той же скобкой.
    status: /^(?:\S\s)?(Working|Waiting for background terminal|Compacting context)\s*\((.+?)\s•\sesc to interrupt\)(?:\s·\s.*)?$/,
    queue: {
      item: /^\s+↳\s/,
      // Сообщение рисуется не больше чем тремя строками, дальше — строка «…».
      rows: { text: /^\s{2}↳ (.*)$/, more: /^\s{4}(.*)$/, cut: /^\s{4}…$/ },
      edit: { where: 'below', sign: /^\s{4}⇧← edit last queued message$/, scope: 'last' },
    },
    // «Question 1/1 (1 unanswered)» у вопроса, «Field 1/1» у запроса на инструмент MCP.
    chip: /^(?:Question|Field) \d+\/\d+\b/,
    free: /^$/,
    dialogs: [
      // «enter to submit all» — у последнего из нескольких вопросов. Свой ответ — заметка
      // к «None of the above» — измерен только на одиночном вопросе («Question 1/1»).
      {
        kind: 'question',
        footer: /\benter to submit (?:answer|all)\b/,
        below: 'label',
        notes: {
          closed: /^tab to add notes \| enter to submit answer \| esc to interrupt$/,
          open: /^tab or esc to clear notes \| enter to submit answer$/,
          line: /^\s{2}› (.*)$/,
          other: /^None of the above$/,
        },
      },
      // Вопрос, открытый из очереди отложенного ввода клавишей `answerPending`: стоит под
      // заголовком блока, последним вариантом клиент дописывает «Other» — свой ответ
      // (цифра ставит на него указатель, текст набирается в его строке). Цифра прочих
      // вариантов отвечает сама. В подвале — переходы между вопросами очереди.
      {
        kind: 'question',
        // Измерены пункты «⇧→ main prompt», «⇧→ prev question», «⇧← next question» и
        // «⇧← queued messages» (в очереди есть ещё сообщения). Вопрос узнают два первых
        // пункта; что стоит за ними через три пробела, его неузнанным не делает.
        footer: /^enter submit\s{3}⌃\] skip(?:\s{3}\S(?:.*\S)?)?$/,
        // Сообщения очереди стоят между заголовком блока и вопросом — в вопрос не входят.
        skipQueue: true,
        under: /^• Queued follow-up inputs$/,
        counter: /^(\d+) of (\d+)$/,
        below: 'label',
        freeLast: /^Other$/,
        // Esc в подвале этого диалога нет, а у работающего Codex он прерывает ход (замер:
        // на этом экране не нажимался). Вопрос снимают ответом или «⌃] skip».
        noInterrupt: true,
      },
      {
        kind: 'permission',
        // Вид диалога называет начало подсказки; что агент допишет за ней, его не меняет.
        footer: /^Press enter to confirm or esc to cancel(?:\s.*)?$/,
        title: /^Would you like to\b/,
        below: 'label',
      },
      // Запрос на вызов инструмента MCP: «Allow <сервер> to run "<инструмент>"?» (про
      // приложение — «to use»), под ним строка аргументов. Заголовок обязателен: подвал
      // у диалога короткий, и одного его мало, чтобы нажимать клавиши. Конец вопроса в
      // признак не входит — в узкой панели заголовок переносится.
      {
        kind: 'permission',
        footer: /^enter to submit \| esc to cancel(?:\s.*)?$/,
        title: /^Allow \S.* to (?:run|use)\b/,
        below: 'label',
        // Цифра варианта отвечает сама (замер на 0.167.2), как и в прочих диалогах.
        // После движения указателя счётчик дописывает «(1 required unanswered)».
        notCounter: /^Field (?!1\/1\b)/,
      },
    ],
    menus: [
      { id: 'trust', sign: /^Folder access$/, footer: /^enter continue · esc back$/ },
      { id: 'update', sign: /^Update available\b/, footer: /^enter continue · esc skip$/ },
      { id: 'model', sign: /^Select Model and Effort$/, footer: /^enter select · esc back$/ },
      { id: 'permissions', sign: /^Update Model Permissions$/, footer: /^enter select · esc back$/ },
    ],
    popup: /^[› ]\s\/(\S+)(?:\s{2,}(\S.*))?$/,
    picker: /^\s{2}enter\/tab insert · esc close\b/,
    mention: /(?:^|\s)@\S*$/,
  },
};

const PROFILES: Record<AgentId, AgentProfile> = { claude: CLAUDE, codex: CODEX };

export function profileOf(agent: AgentId): AgentProfile {
  return PROFILES[agent];
}

/** Версия агента лежит в диапазоне, на котором профиль проверен снимками. Нет версии
 *  или она не разобралась — «не проверено»: чат тогда предупреждает, а не молчит. */
export function isTested(agent: AgentId, version: string | undefined): boolean {
  const got = parseVersion(version);
  if (!got) return false;
  const { min, max } = PROFILES[agent].tested;
  return compare(got, parseVersion(min)!) >= 0 && compare(got, parseVersion(max)!) <= 0;
}

function parseVersion(text: string | undefined): number[] | null {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '');
  return found ? [Number(found[1]), Number(found[2]), Number(found[3])] : null;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = a[i]! - b[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}
