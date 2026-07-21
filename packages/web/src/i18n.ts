// Локализация: словари ru/en с идентичным набором ключей, t(key, params?),
// автоопределение языка (localStorage → navigator.language), переключатель.
// Смена языка перерисовывает интерфейс через подписчиков onLangChange.

export type Lang = 'ru' | 'en';

/** Значение словаря — строка или вложенная секция. */
interface Dict {
  [key: string]: string | Dict;
}

const ru: Dict = {
  app: {
    name: 'TermHub',
  },
  common: {
    cancel: 'Отмена',
    close: 'Закрыть',
    retry: 'Повторить',
  },
  login: {
    title: 'Вход',
    subtitle: 'Введите пароль доступа',
    password: 'Пароль',
    submit: 'Войти',
    wrongPassword: 'Неверный пароль',
    rateLimited: 'Слишком много попыток. Подождите минуту',
    networkError: 'Не удалось связаться с агентом',
  },
  header: {
    language: 'Язык',
    theme: 'Тема',
    themeToDark: 'Тёмная тема',
    themeToLight: 'Светлая тема',
    enableNotifications: 'Разрешить уведомления',
    notificationsOn: 'Уведомления включены',
    keepAwake: 'Не давать Mac засыпать',
    keepAwakeOn: 'Mac не засыпает',
    keepAwakeError: 'Не удалось переключить режим сна',
    menu: 'Меню',
    devices: 'Устройства',
    share: 'Поделиться доступом',
    soon: 'скоро',
  },
  dashboard: {
    newSession: 'Новая сессия',
    connecting: 'Подключение к агенту…',
    reloadError: 'Не удалось обновить список сессий',
    emptyTitle: 'Пока нет ни одной сессии',
    emptyHint: 'Запустите команду tm в терминале IDEA — сессия появится здесь.',
  },
  card: {
    open: 'Открыть сессию',
    menu: 'Действия',
    kill: 'Завершить',
    confirmKill: 'Завершить сессию «{name}»?',
    attached: '{n} подключено',
    bell: 'Есть звонок',
    activity: 'Есть активность',
    killError: 'Не удалось завершить сессию',
    rename: 'Переименовать',
    renameError: 'Не удалось переименовать сессию',
  },
  rename: {
    title: 'Переименовать сессию',
    name: 'Новое имя',
    submit: 'Переименовать',
  },
  create: {
    title: 'Новая сессия',
    name: 'Имя',
    root: 'Корень',
    directory: 'Каталог',
    preset: 'Запустить',
    presetZsh: 'Оболочку',
    presetClaude: 'Claude',
    submit: 'Создать',
    noDirs: 'Нет доступных каталогов',
    needDir: 'Укажите корень и каталог',
    error: 'Не удалось создать сессию',
  },
  remote: {
    pickTitle: 'Выбор агента',
    pickSubtitle: 'Выберите агент или добавьте новый по коду',
    pickEmpty: 'Пока нет агентов. Добавьте первый по коду сопряжения.',
    addByCode: 'Добавить по коду',
    removeAgent: 'Удалить агент',
    unauthorized: 'Агент отклонил устройство. Выполните сопряжение заново.',
  },
  pair: {
    title: 'Сопряжение по коду',
    subtitle: 'Введите одноразовый код, показанный агентом',
    code: 'Код сопряжения',
    name: 'Название агента',
    namePlaceholder: 'Например, Домашний ПК',
    submit: 'Подключить',
    errorCode: 'Неверный код сопряжения',
    errorTimeout: 'Время ожидания истекло. Попробуйте снова',
    errorNoRoom: 'Код не найден или уже использован',
    errorGeneric: 'Не удалось выполнить сопряжение',
  },
  time: {
    justNow: 'только что',
    minutes: '{n} мин назад',
    hours: '{n} ч назад',
    days: '{n} дн назад',
  },
  notify: {
    granted: 'Уведомления включены',
    denied: 'Уведомления отклонены. Разрешите их в настройках браузера',
    unsupported: 'Уведомления не поддерживаются этим браузером',
    bellBody: 'Терминал ждёт ответа',
  },
  term: {
    back: 'Назад',
    tabs: 'Сессии',
    reconnecting: 'Переподключение…',
    sessionEnded: 'Сессия завершена',
    sessionError: 'Ошибка сессии: {message}',
    sessionEndedHint: 'Терминал закрыт. Вернитесь к списку сессий.',
    statusConnected: 'Соединение установлено',
    statusReconnecting: 'Переподключение',
    statusClosed: 'Соединение закрыто',
    fontDecrease: 'Мельче шрифт',
    fontIncrease: 'Крупнее шрифт',
    copied: 'Скопировано',
    copyEmpty: 'Нечего копировать — выделите текст',
    copyFail: 'Не удалось скопировать',
    toolbarShow: 'Показать панель',
    toolbarHide: 'Скрыть панель',
    searchPlaceholder: 'Поиск…',
    searchNotFound: 'Не найдено',
    shareSession: 'Поделиться сессией',
    readOnly: 'Только просмотр',
  },
  quickkeys: {
    title: 'Быстрые клавиши',
    left: 'Влево',
    up: 'Вверх',
    down: 'Вниз',
    right: 'Вправо',
    keyboard: 'Экранная клавиатура',
    select: 'Режим выделения',
    enterSends: 'Отправлять по Enter',
    search: 'Поиск по терминалу',
    compose: 'Строка ввода',
  },
  compose: {
    placeholder: 'Ввод…',
    send: 'Отправить',
  },
  files: {
    toDashboard: '← К сессиям',
    empty: 'Пусто',
    error: 'Не удалось открыть',
    noRoots: 'Нет доступных корней',
    download: 'Скачать',
    downloading: 'Скачивание {name}…',
    binary: 'Бинарный файл — доступно только скачивание',
    tooLarge: 'Файл слишком большой для просмотра ({size})',
    loading: 'Загрузка…',
    actions: 'Действия',
    copyTo: 'Копировать в…',
    moveTo: 'Переместить в…',
    rename: 'Переименовать',
    delete: 'Удалить',
    properties: 'Свойства',
    confirmDelete: 'Удалить «{name}»?',
    deleted: 'Удалено',
    renamed: 'Переименовано',
    badName: 'Недопустимое имя',
    copied: 'Скопировано',
    moved: 'Перемещено',
    pickHere: 'Выбрать эту папку',
    propName: 'Имя',
    propKind: 'Тип',
    propPath: 'Путь',
    propSize: 'Размер',
    propMode: 'Права',
    propCreated: 'Создан',
    propModified: 'Изменён',
    propChanged: 'Метаданные',
    propAccessed: 'Открыт',
    kindDir: 'Папка',
    kindFile: 'Файл',
    edit: 'Редактировать',
    save: 'Сохранить',
    saved: 'Сохранено',
    openNota: 'Открыть в NotAText',
    notaOnlyText: 'Только текстовые файлы (не бинарные/большие)',
  },
  repo: {
    error: 'Не удалось выполнить операцию',
    refresh: 'Обновить',
    commit: 'Закоммитить',
    commitTitle: 'Новый коммит',
    doCommit: 'Закоммитить',
    messagePlaceholder: 'Сообщение коммита…',
    committed: 'Коммит создан',
    clean: 'Нет изменений для коммита',
    noCommits: 'Пока нет коммитов',
    noFiles: 'Нет изменённых файлов',
    noDiff: '(нет изменений)',
    pickFolder: 'Это не репозиторий. Откройте папку с git / svn / mercurial.',
    viewFile: 'Показать файл',
    pull: 'Стянуть (pull)',
    push: 'Отправить (push)',
    pulled: 'Изменения стянуты',
    pushed: 'Отправлено',
    head: 'сейчас здесь',
    refreshHint: 'Обновить список коммитов с сервера (fetch)',
    branches: 'Ветки',
    createBranch: 'Создать ветку',
    branchName: 'Имя новой ветки',
    branchCreated: 'Ветка создана',
    switched: 'Переключено',
    branchDeleted: 'Ветка удалена',
    confirmDeleteBranch: 'Удалить ветку «{name}»?',
    noBranches: 'Веток нет',
    status: {
      M: 'Изменён',
      A: 'Добавлен',
      D: 'Удалён',
      R: 'Переименован',
      C: 'Скопирован',
      '?': 'Новый',
    },
  },
  nav: {
    sessions: 'Сессии',
    files: 'Проводник',
    repo: 'Репозиторий',
  },
  holo: {
    session: 'Терминал',
  },
  diag: {
    title: 'Диагностика',
    relayOff: 'Relay не настроен',
    relayOk: 'Связь с relay установлена',
    relayBad: 'Нет связи с relay',
    version: 'Версия',
    host: 'Хост',
    uptime: 'Аптайм',
    sessions: 'Сессий',
    relayUrl: 'Relay URL',
    agentId: 'ID агента',
    clients: 'Клиентов',
    roots: 'Корни',
    unavailable: 'Диагностика доступна только на LAN-адресе агента (не через relay)',
  },
  share: {
    title: 'Поделиться',
    allSessions: 'Все сессии (полный доступ)',
    oneSession: 'Одну сессию',
    allowWrite: 'Разрешить ввод',
    allowFiles: 'Разрешить файлы',
    generate: 'Создать код',
    hint: 'Введите этот код на другом устройстве («Добавить по коду»). Действует ~5 минут.',
    copy: 'Скопировать код',
    copied: 'Скопировано',
  },
  devices: {
    title: 'Устройства',
    empty: 'Нет допущенных устройств',
    revoke: 'Отозвать',
    fullAccess: 'полный доступ',
    write: 'ввод',
    files: 'файлы',
  },
};

const en: Dict = {
  app: {
    name: 'TermHub',
  },
  common: {
    cancel: 'Cancel',
    close: 'Close',
    retry: 'Retry',
  },
  login: {
    title: 'Sign in',
    subtitle: 'Enter your access password',
    password: 'Password',
    submit: 'Sign in',
    wrongPassword: 'Wrong password',
    rateLimited: 'Too many attempts. Wait a minute',
    networkError: 'Could not reach the agent',
  },
  header: {
    language: 'Language',
    theme: 'Theme',
    themeToDark: 'Dark theme',
    themeToLight: 'Light theme',
    enableNotifications: 'Enable notifications',
    notificationsOn: 'Notifications on',
    keepAwake: 'Keep Mac awake',
    keepAwakeOn: 'Mac stays awake',
    keepAwakeError: 'Could not toggle sleep mode',
    menu: 'Menu',
    devices: 'Devices',
    share: 'Share access',
    soon: 'soon',
  },
  dashboard: {
    newSession: 'New session',
    connecting: 'Connecting to the agent…',
    reloadError: 'Could not refresh the session list',
    emptyTitle: 'No sessions yet',
    emptyHint: 'Run the tm command in the IDEA terminal — the session will show up here.',
  },
  card: {
    open: 'Open session',
    menu: 'Actions',
    kill: 'Kill',
    confirmKill: 'Kill session “{name}”?',
    attached: '{n} attached',
    bell: 'Bell pending',
    activity: 'Activity',
    killError: 'Could not kill the session',
    rename: 'Rename',
    renameError: 'Could not rename the session',
  },
  rename: {
    title: 'Rename session',
    name: 'New name',
    submit: 'Rename',
  },
  create: {
    title: 'New session',
    name: 'Name',
    root: 'Root',
    directory: 'Directory',
    preset: 'Launch',
    presetZsh: 'Shell',
    presetClaude: 'Claude',
    submit: 'Create',
    noDirs: 'No directories available',
    needDir: 'Enter a root and a directory',
    error: 'Could not create the session',
  },
  remote: {
    pickTitle: 'Choose an agent',
    pickSubtitle: 'Pick an agent or add a new one by code',
    pickEmpty: 'No agents yet. Add your first one with a pairing code.',
    addByCode: 'Add by code',
    removeAgent: 'Remove agent',
    unauthorized: 'The agent rejected this device. Pair again.',
  },
  pair: {
    title: 'Pair by code',
    subtitle: 'Enter the one-time code shown by the agent',
    code: 'Pairing code',
    name: 'Agent name',
    namePlaceholder: 'e.g. Home PC',
    submit: 'Connect',
    errorCode: 'Invalid pairing code',
    errorTimeout: 'Timed out. Try again',
    errorNoRoom: 'Code not found or already used',
    errorGeneric: 'Pairing failed',
  },
  time: {
    justNow: 'just now',
    minutes: '{n} min ago',
    hours: '{n} h ago',
    days: '{n} d ago',
  },
  notify: {
    granted: 'Notifications enabled',
    denied: 'Notifications blocked. Allow them in browser settings',
    unsupported: 'Notifications are not supported by this browser',
    bellBody: 'A terminal is waiting for input',
  },
  term: {
    back: 'Back',
    tabs: 'Sessions',
    reconnecting: 'Reconnecting…',
    sessionEnded: 'Session ended',
    sessionError: 'Session error: {message}',
    sessionEndedHint: 'The terminal was closed. Go back to the session list.',
    statusConnected: 'Connected',
    statusReconnecting: 'Reconnecting',
    statusClosed: 'Disconnected',
    fontDecrease: 'Smaller font',
    fontIncrease: 'Larger font',
    copied: 'Copied',
    copyEmpty: 'Nothing to copy — select some text',
    copyFail: 'Copy failed',
    toolbarShow: 'Show toolbar',
    toolbarHide: 'Hide toolbar',
    searchPlaceholder: 'Search…',
    searchNotFound: 'Not found',
    shareSession: 'Share session',
    readOnly: 'Read-only',
  },
  quickkeys: {
    title: 'Quick keys',
    left: 'Left',
    up: 'Up',
    down: 'Down',
    right: 'Right',
    keyboard: 'On-screen keyboard',
    select: 'Selection mode',
    enterSends: 'Send on Enter',
    search: 'Search terminal',
    compose: 'Compose bar',
  },
  compose: {
    placeholder: 'Type…',
    send: 'Send',
  },
  files: {
    toDashboard: '← To sessions',
    empty: 'Empty',
    error: 'Could not open',
    noRoots: 'No available roots',
    download: 'Download',
    downloading: 'Downloading {name}…',
    binary: 'Binary file — download only',
    tooLarge: 'File too large to preview ({size})',
    loading: 'Loading…',
    actions: 'Actions',
    copyTo: 'Copy to…',
    moveTo: 'Move to…',
    rename: 'Rename',
    delete: 'Delete',
    properties: 'Properties',
    confirmDelete: 'Delete “{name}”?',
    deleted: 'Deleted',
    renamed: 'Renamed',
    badName: 'Invalid name',
    copied: 'Copied',
    moved: 'Moved',
    pickHere: 'Select this folder',
    propName: 'Name',
    propKind: 'Type',
    propPath: 'Path',
    propSize: 'Size',
    propMode: 'Permissions',
    propCreated: 'Created',
    propModified: 'Modified',
    propChanged: 'Metadata',
    propAccessed: 'Accessed',
    kindDir: 'Folder',
    kindFile: 'File',
    edit: 'Edit',
    save: 'Save',
    saved: 'Saved',
    openNota: 'Open in NotAText',
    notaOnlyText: 'Text files only (not binary/large)',
  },
  repo: {
    error: 'Operation failed',
    refresh: 'Refresh',
    commit: 'Commit',
    commitTitle: 'New commit',
    doCommit: 'Commit',
    messagePlaceholder: 'Commit message…',
    committed: 'Commit created',
    clean: 'No changes to commit',
    noCommits: 'No commits yet',
    noFiles: 'No changed files',
    noDiff: '(no changes)',
    pickFolder: 'Not a repository. Open a git / svn / mercurial folder.',
    viewFile: 'View file',
    pull: 'Pull',
    push: 'Push',
    pulled: 'Pulled changes',
    pushed: 'Pushed',
    head: 'current',
    refreshHint: 'Fetch commits from the server',
    branches: 'Branches',
    createBranch: 'Create branch',
    branchName: 'New branch name',
    branchCreated: 'Branch created',
    switched: 'Switched',
    branchDeleted: 'Branch deleted',
    confirmDeleteBranch: 'Delete branch “{name}”?',
    noBranches: 'No branches',
    status: {
      M: 'Modified',
      A: 'Added',
      D: 'Deleted',
      R: 'Renamed',
      C: 'Copied',
      '?': 'New',
    },
  },
  nav: {
    sessions: 'Sessions',
    files: 'Files',
    repo: 'Repository',
  },
  holo: {
    session: 'Terminal',
  },
  diag: {
    title: 'Diagnostics',
    relayOff: 'Relay not configured',
    relayOk: 'Connected to relay',
    relayBad: 'Not connected to relay',
    version: 'Version',
    host: 'Host',
    uptime: 'Uptime',
    sessions: 'Sessions',
    relayUrl: 'Relay URL',
    agentId: 'Agent ID',
    clients: 'Clients',
    roots: 'Roots',
    unavailable: 'Diagnostics available only on the agent LAN address (not via relay)',
  },
  share: {
    title: 'Share',
    allSessions: 'All sessions (full access)',
    oneSession: 'One session',
    allowWrite: 'Allow input',
    allowFiles: 'Allow files',
    generate: 'Generate code',
    hint: 'Enter this code on another device (“Add by code”). Valid ~5 minutes.',
    copy: 'Copy code',
    copied: 'Copied',
  },
  devices: {
    title: 'Devices',
    empty: 'No authorized devices',
    revoke: 'Revoke',
    fullAccess: 'full access',
    write: 'input',
    files: 'files',
  },
};

export const dictionaries: Record<Lang, Dict> = { ru, en };

/** Функция перевода: путь-ключ + необязательные параметры-подстановки {name}. */
export type TFn = (key: string, params?: Record<string, string | number>) => string;

const LS_KEY = 'termhub-lang';
let current: Lang = detectLang();
const listeners = new Set<() => void>();

/** localStorage → navigator.language (ru* → ru) → en. */
function detectLang(): Lang {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {
    // localStorage недоступен (тест/приватный режим) — идём дальше.
  }
  try {
    if (navigator.language.toLowerCase().startsWith('ru')) return 'ru';
  } catch {
    // navigator недоступен (node) — язык по умолчанию.
  }
  return 'en';
}

/** Достаёт строку по пути «a.b.c»; при отсутствии возвращает сам ключ. */
function resolve(dict: Dict, key: string): string {
  let node: string | Dict | undefined = dict;
  for (const part of key.split('.')) {
    if (node === undefined || typeof node === 'string') return key;
    node = node[part];
  }
  return typeof node === 'string' ? node : key;
}

export const t: TFn = (key, params) => {
  let str = resolve(dictionaries[current], key);
  if (params) for (const [name, value] of Object.entries(params)) str = str.replaceAll(`{${name}}`, String(value));
  return str;
};

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try {
    localStorage.setItem(LS_KEY, lang);
  } catch {
    // Персист необязателен — молча продолжаем.
  }
  try {
    document.documentElement.lang = lang;
  } catch {
    // Вне браузера document нет.
  }
  for (const listener of listeners) listener();
}

/** Подписка на смену языка (для перерисовки). Возвращает отписку. */
export function onLangChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
