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
  /** Цифра варианта может только переставить указатель, а отвечает клавиша отправки
   *  (подвал «enter to submit»). Требует `title`: по нему диалог узнаётся при ответе. */
  confirm?: boolean;
}

/** Известное меню: чат его не разбирает, а показывает окошком терминала. */
export interface MenuSign {
  id: string;
  /** Строка-заголовок меню (без отступов). */
  sign: RegExp;
  /** Последняя строка экрана. Нет — последней обязана быть строка варианта. */
  footer?: RegExp;
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
  queue: { item: RegExp; under?: RegExp };
  /** Строки над заголовком вопроса, которые в заголовок не входят (вкладки, счётчик). */
  chip: RegExp;
  /** Подпись варианта «свой ответ». */
  free: RegExp;
  dialogs: DialogSign[];
  menus: MenuSign[];
  /** Строка списка команд по «/»: группа 1 — имя без «/», группа 2 — подсказка. */
  popup: RegExp;
  /** Продолжение подсказки на следующей строке: группа 1 — текст. */
  popupMore?: RegExp;
}

export interface AgentProfile {
  agent: AgentId;
  name: string;
  /** Версии, на которых профиль проверен снимками, включительно. */
  tested: { min: string; max: string };
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
  keys: {
    submit: '\r',
    interrupt: '\x1b',
    modeCycle: '\x1b[Z',
    newline: '\x1b\r',
    clearInput: ['\x1b', '\x1b'],
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
    queue: { item: /^❯\s/, under: /^\s+ctrl\+x ctrl\+s to send now$/ },
    chip: /^[←\s]*[☐☒✔]\s/,
    free: /^Type something\.?$/,
    dialogs: [
      {
        kind: 'question',
        footer: /^Enter to select\b/,
        below: 'description',
        freeBeforeRule: true,
      },
      { kind: 'permission', footer: /^Esc to cancel\b/, below: 'label' },
      { kind: 'question', title: /^Ready to submit your answers\?$/, below: 'label' },
    ],
    menus: [
      { id: 'trust', sign: /^Accessing workspace:$/, footer: /^Enter to confirm · Esc to cancel$/ },
      { id: 'model', sign: /^Select model$/, footer: /^Enter to set as default\b/ },
      { id: 'model-confirm', sign: /^Switch model\?$/ },
      { id: 'rewind', sign: /^Rewind$/, footer: /^Enter to continue · Esc to cancel$/ },
    ],
    popup: /^\s{2}[❯ ]\s\/(\S+)(?:\s{2,}(\S.*))?$/,
    popupMore: /^\s{12,}(\S.*)$/,
  },
};

/** Codex CLI 0.167.0, запущенный пресетом TermHub (`tui.animations=false`,
 *  `--no-alt-screen`). */
const CODEX: AgentProfile = {
  agent: 'codex',
  name: 'Codex',
  tested: { min: '0.167.0', max: '0.167.0' },
  keys: {
    submit: '\r',
    interrupt: '\x1b',
    modeCycle: '\x1b[Z',
    newline: '\x1b\r',
    clearInput: ['\x03'],
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
    footer: /^\s{2}\S.* · \S|\bcontext left$/,
    notFooter: /\b(?:enter|esc)\b/i,
    footerLines: 3,
    statusLine: { sep: /\s{2,}|\s·\s/, working: /^Working$/, idle: /^Ready$/ },
    talk: /^[›•]\s/,
    status: /^(?:\S\s)?(Working)\s*\((.+?)\s•\sesc to interrupt\)$/,
    queue: { item: /^\s+↳\s/ },
    // «Question 1/1 (1 unanswered)» у вопроса, «Field 1/1» у запроса на инструмент MCP.
    chip: /^(?:Question|Field) \d+\/\d+\b/,
    free: /^$/,
    dialogs: [
      { kind: 'question', footer: /\benter to submit answer\b/, below: 'label' },
      {
        kind: 'permission',
        footer: /^Press enter to confirm or esc to cancel$/,
        title: /^Would you like to\b/,
        below: 'label',
      },
      // Запрос на вызов инструмента MCP: «Allow <сервер> to run "<инструмент>"?» (про
      // приложение — «to use»), под ним строка аргументов. Заголовок обязателен: подвал
      // у диалога короткий, и одного его мало, чтобы нажимать клавиши. Конец вопроса в
      // признак не входит — в узкой панели заголовок переносится.
      {
        kind: 'permission',
        footer: /^enter to submit \| esc to cancel$/,
        title: /^Allow \S.* to (?:run|use)\b/,
        below: 'label',
        confirm: true,
      },
    ],
    menus: [
      { id: 'trust', sign: /^Folder access$/, footer: /^enter continue · esc back$/ },
      { id: 'update', sign: /^Update available\b/, footer: /^enter continue · esc skip$/ },
      { id: 'model', sign: /^Select Model and Effort$/, footer: /^enter select · esc back$/ },
      { id: 'permissions', sign: /^Update Model Permissions$/, footer: /^enter select · esc back$/ },
    ],
    popup: /^[› ]\s\/(\S+)(?:\s{2,}(\S.*))?$/,
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
