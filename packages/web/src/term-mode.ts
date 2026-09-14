// Способ подключения терминала со стороны клиента: что просить у агента и что агент
// в ответ назвал. Два значения хранятся раздельно, потому что настройка агента старше
// просьбы: попросить control там, где агент его запретил, нельзя, и интерфейс обязан
// показывать режим из кадра состояния, а не собственную просьбу.

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

/** Второй из двух способов — им переключает интерфейс. */
export function otherTerminalMode(mode: TerminalMode): TerminalMode {
  return mode === 'control' ? 'attach' : 'control';
}

/** Режим из последнего кадра состояния; undefined — терминал ещё не открывали. */
export function lastTerminalMode(): TerminalMode | undefined {
  return read(LAST_KEY);
}

/** Запомнить ответ агента: диагностика открывается отдельным экраном и берёт режим
 *  отсюда, а не из живого терминала. */
export function noteTerminalMode(mode: TerminalMode): void {
  write(LAST_KEY, mode);
}

/** Человеческое имя режима для интерфейса. */
export function terminalModeName(mode: TerminalMode): string {
  return mode === 'control' ? t('term.modeControl') : t('term.modeAttach');
}

/** Однобуквенный вид режима для чипа в шапке: место в шапке дорогое, а слово
 *  целиком остаётся в подсказке кнопки. */
export function terminalModeLetter(mode: TerminalMode): string {
  return mode === 'control' ? t('term.modeShortControl') : t('term.modeShortAttach');
}
