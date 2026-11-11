// Способ подключения терминала со стороны клиента: что просить у агента и что агент
// в ответ назвал. Два значения хранятся раздельно, потому что настройка агента старше
// просьбы: попросить control там, где агент его запретил, нельзя, и интерфейс обязан
// показывать режим из кадра состояния, а не собственную просьбу. Ответ агента помнится
// по сессиям: у двух открытых терминалов он бывает разным (один откатился на attach).

import type { TerminalMode } from '@termhub/protocol/frames';

import { t } from './i18n';

/** Просьба клиента (переключатель в интерфейсе). */
const REQUEST_KEY = 'termhub.terminalMode';
/** Последний режим, который назвал агент, — его показывает страница диагностики. */
const LAST_KEY = 'termhub.terminalModeLast';

/** По умолчанию просим control mode — тот же режим, что у агента без настройки. */
const DEFAULT_MODE: TerminalMode = 'control';

function read(key: string): TerminalMode | undefined {
  try {
    const value = localStorage.getItem(key);
    return value === 'control' || value === 'attach' ? value : undefined;
  } catch {
    return undefined; // приватный режим браузера — просто нет сохранённого значения
  }
}

function write(key: string, mode: TerminalMode): void {
  try {
    localStorage.setItem(key, mode);
  } catch {
    // Персист необязателен: просьба доживёт хотя бы до конца этого экрана.
  }
}

/** Просьба клиента: едет первым кадром, которым открывается терминал (LAN — RESIZE,
 *  relay — OPEN). Снимается один раз на открытие, живой терминал не трогает. */
export function terminalModeRequest(): TerminalMode {
  return read(REQUEST_KEY) ?? DEFAULT_MODE;
}

/** Запомнить просьбу — она применится к следующему открытию терминала. */
export function setTerminalModeRequest(mode: TerminalMode): void {
  write(REQUEST_KEY, mode);
}

/** Режим из последнего кадра состояния; undefined — терминал ещё не открывали. */
export function lastTerminalMode(): TerminalMode | undefined {
  return read(LAST_KEY);
}

/** Ответы агента по сессиям — живут, пока жива страница. */
const bySession = new Map<string, TerminalMode>();

/** Запомнить ответ агента: диагностика открывается отдельным экраном и берёт режим
 *  отсюда, а не из живого терминала. С именем сессии ответ помнится ещё и за ней. */
export function noteTerminalMode(mode: TerminalMode, session?: string): void {
  write(LAST_KEY, mode);
  if (session !== undefined) bySession.set(session, mode);
}

/** Каким способом агент подключил именно эту сессию; undefined — в этой вкладке её
 *  терминал ещё не называл режим. */
export function sessionTerminalMode(session: string): TerminalMode | undefined {
  return bySession.get(session);
}

/** Человеческое имя режима для интерфейса. */
export function terminalModeName(mode: TerminalMode): string {
  return mode === 'control' ? t('term.modeControl') : t('term.modeAttach');
}
