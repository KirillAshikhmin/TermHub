// Wire-формат: фрейм = [type:u8][channel:u16 BE][payload:bytes], один фрейм — одно WS-сообщение.

export enum FrameType {
  Data = 0,
  Resize = 1,
  Open = 2,
  OpenOk = 3,
  Close = 4,
  List = 5,
  ListResult = 6,
  Bell = 7,
  Ping = 8,
  Pong = 9,
  Error = 10,
  Create = 11,
  Kill = 12,
  Caffeinate = 13,
  CaffeinateResult = 14,
  PushKey = 15,
  PushKeyResult = 16,
  PushSubscribe = 17,
  Dirs = 18,
  DirsResult = 19,
  FilesList = 20,
  FilesListResult = 21,
  FileRead = 22,
  FileReadResult = 23,
  Share = 24,
  ShareResult = 25,
  Devices = 26,
  DevicesResult = 27,
  Revoke = 28,
  FileStat = 29,
  FileStatResult = 30,
  FileChunk = 31,
  FileChunkData = 32,
  Repo = 33,
  RepoResult = 34,
  FileOp = 35,
  FileOpResult = 36,
  RenameSession = 37,
  CreateOk = 38,
  /** Запрос адресов, по которым агент доступен напрямую (минуя relay). */
  Addresses = 39,
  AddressesResult = 40,
}

export interface Frame {
  type: FrameType;
  channel: number;
  payload: Uint8Array;
}

export interface SessionInfo {
  name: string;
  path: string;
  command: string;
  activityTs: number;
  attached: number;
  /** Звонок: BEL в сессии ИЛИ Claude ждёт реакции (✳ в заголовке) — аналог звонка. */
  bell: boolean;
  /** Заголовок активной панели (tmux pane_title). Claude Code кодирует состояние:
   *  брайлевый спиннер (⠂/⠐/…) = работает, ✳ = ждёт реакции. Веб выводит индикатор
   *  активности из него; не-Claude сессии — fallback по activityTs. */
  title: string;
}

/** Элемент листинга директории для файлового браузера. */
export interface FileEntry {
  name: string;
  kind: 'dir' | 'file';
  size: number;
  /** mtime в мс (Unix epoch). */
  mtime: number;
  hidden: boolean;
}

/** Содержимое файла для просмотра. `data`: для text — UTF-8 строка, для image/binary — base64.
 *  `truncated` — файл превысил лимит инлайн-просмотра (data пуст, только скачивание). */
export interface FileContent {
  kind: 'text' | 'image' | 'binary';
  mime: string;
  data: string;
  size: number;
  truncated: boolean;
}

/** Полные метаданные файла/папки (для «Свойства»). Времена — мс (Unix epoch). */
export interface FileInfo {
  name: string;
  /** Абсолютный путь. */
  path: string;
  kind: 'dir' | 'file' | 'other';
  size: number;
  mtime: number;
  /** Изменение метаданных (ctime). */
  ctime: number;
  /** Создание (birthtime). */
  birthtime: number;
  atime: number;
  /** Права в виде rwxr-xr-x. */
  mode: string;
}

/** Система контроля версий, определённая в папке. */
export type VcsKind = 'git' | 'svn' | 'hg';

/** Строка лога — один коммит (метаданные без диффа). */
export interface RepoCommitRef {
  /** Полный идентификатор ревизии (git — hash, svn — номер, hg — node). */
  rev: string;
  /** Краткий id для показа. */
  short: string;
  author: string;
  /** Дата коммита, Unix epoch, мс. */
  date: number;
  /** Первая строка сообщения. */
  subject: string;
  /** Родительские ревизии. Два и больше — это слияние; по ним рисуется граф.
   *  Пусто у систем, где родителей не запрашиваем (svn) — тогда лента линейная. */
  parents?: string[];
  /** Метки, указывающие на коммит: имена веток и тегов (git — из %D, без «HEAD ->»). */
  refs?: string[];
}

/** Изменённый файл: путь + односимвольный статус (M/A/D/R/C/?). */
export interface RepoFileChange {
  path: string;
  status: string;
}

/** Ответ на «лог»: тип VCS, текущая ревизия (HEAD) и список коммитов (vcs=null — не
 *  репозиторий). `head` — на каком коммите сейчас рабочая копия (для подсветки). */
export interface RepoLog {
  vcs: VcsKind | null;
  head: string;
  commits: RepoCommitRef[];
  /** Текущая ветка — лог идёт по всем веткам сразу, и без этого непонятно, где ты. */
  branch?: string;
  /** Насколько текущая ветка впереди/позади своего upstream (git). null — upstream нет. */
  ahead?: number | null;
  behind?: number | null;
}

/** Детали коммита: метаданные, полное сообщение, список изменённых файлов. */
export interface RepoCommitDetail {
  rev: string;
  short: string;
  author: string;
  date: number;
  message: string;
  files: RepoFileChange[];
}

/** Рабочие изменения (для диалога коммита). */
export interface RepoStatus {
  vcs: VcsKind | null;
  files: RepoFileChange[];
}

/** Ветки репозитория: текущая + список (git — локальные+удалённые по коротким именам;
 *  hg — именованные ветки; svn — best-effort по layout). */
export interface RepoBranches {
  vcs: VcsKind | null;
  current: string;
  branches: string[];
}

const HEADER_SIZE = 3;

export function encodeFrame(f: Frame): Uint8Array {
  if (f.channel < 0 || f.channel > 0xffff) throw new RangeError(`channel out of range 0..65535: ${f.channel}`);
  const buf = new Uint8Array(HEADER_SIZE + f.payload.length);
  buf[0] = f.type;
  buf[1] = (f.channel >>> 8) & 0xff;
  buf[2] = f.channel & 0xff;
  buf.set(f.payload, HEADER_SIZE);
  return buf;
}

/**
 * Декодирует заголовок + payload. `type`-байт НЕ валидируется против enum
 * `FrameType` (0..12): значение 13..255 форвардится как есть — фрейм может
 * прийти от более новой версии протокола. Верхний слой обязан обрабатывать
 * неизвестный `type` (`default`/`else` в своём switch), а не полагаться на то,
 * что каст в `FrameType` гарантирует принадлежность enum'у.
 */
export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.length < HEADER_SIZE) throw new Error(`Frame too short: ${buf.length} bytes, need at least ${HEADER_SIZE}`);
  return {
    type: buf[0] as FrameType,
    channel: (buf[1] << 8) | buf[2],
    payload: buf.subarray(HEADER_SIZE),
  };
}

export function jsonFrame(type: FrameType, channel: number, obj: unknown): Uint8Array {
  return encodeFrame({ type, channel, payload: new TextEncoder().encode(JSON.stringify(obj)) });
}

/**
 * Декодирует payload фрейма как JSON. Бросает `Error` с внятным сообщением на
 * невалидном JSON (например, битый payload от недоверенного источника) — это
 * документированное поведение, вызывающий обязан обернуть в try/catch.
 */
export function frameJson<T>(f: Frame): T {
  try {
    return JSON.parse(new TextDecoder().decode(f.payload)) as T;
  } catch {
    throw new Error('невалидный JSON во фрейме');
  }
}
