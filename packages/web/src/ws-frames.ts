// Терминальные фрейм-хелперы поверх кодека @termhub/protocol. Кодек НЕ дублируем —
// импортируем из подпути /frames (без крипто-модуля, чтобы libsodium не попадал в
// бандл LAN-терминала). В LAN один WS на терминал, поэтому channel всегда 0.

import { decodeFrame, encodeFrame, frameJson, FrameType, jsonFrame } from '@termhub/protocol/frames';
import type { Frame, TerminalMode, TerminalState } from '@termhub/protocol/frames';

export { decodeFrame, frameJson, FrameType };
export type { Frame, TerminalMode, TerminalState };

/** В LAN мультиплексирования нет — единственный канал. */
export const LAN_CHANNEL = 0;

/** DATA-фрейм с сырыми байтами терминала (ввод пользователя → pty). */
export function dataFrame(payload: Uint8Array): Uint8Array {
  return encodeFrame({ type: FrameType.Data, channel: LAN_CHANNEL, payload });
}

/** RESIZE-фрейм с размерами окна. Первый кадр после open — обязателен: без него
 *  агент не спавнит pty. На нём же едет просьба о способе подключения (`mode`):
 *  в LAN это первый кадр, которым клиент открывает терминал, и к следующим
 *  ресайзам решение агентом уже принято. */
export function resizeFrame(cols: number, rows: number, mode?: TerminalMode, claim?: boolean): Uint8Array {
  return jsonFrame(FrameType.Resize, LAN_CHANNEL, resizePayload(cols, rows, mode, claim));
}

/** Тело RESIZE — одно на оба провода. `claim: false` — «размер пересчитался сам, человек
 *  здесь сейчас не работает»: агент запомнит просьбу, но размер окна у другого клиента не
 *  отберёт. Поле не названо вовсе — как у старого клиента: заявка есть. */
export function resizePayload(
  cols: number,
  rows: number,
  mode?: TerminalMode,
  claim?: boolean,
): { cols: number; rows: number; mode?: TerminalMode; claim?: boolean } {
  return { cols, rows, ...(mode ? { mode } : {}), ...(claim === undefined ? {} : { claim }) };
}

/** Полезная нагрузка ERROR-фрейма — причина, по которой сервер рвёт сессию. */
export interface ErrorPayload {
  code?: string;
  message?: string;
}

/** Разбирает ERROR-фрейм в {code, message}; битый payload → пустой объект
 *  (не роняем клиента на невалидном JSON от сервера). */
export function parseError(frame: Frame): ErrorPayload {
  try {
    return frameJson<ErrorPayload>(frame);
  } catch {
    return {};
  }
}

/** Разбирает кадр состояния терминала. Поля независимы: приходит то, что стало
 *  известно, поэтому чужое значение отбрасывается по отдельности, а не вместе с
 *  кадром. Битый payload → пустой объект: клиент обновляет только пришедшее.
 *  Общий для обеих дорог — relay разбирает свои кадры этой же функцией. */
export function parseTerminalState(frame: Frame): TerminalState {
  let raw: { mode?: unknown; altScreen?: unknown; cols?: unknown; rows?: unknown };
  try {
    raw = frameJson<typeof raw>(frame);
  } catch {
    return {};
  }
  const state: TerminalState = {};
  if (raw.mode === 'control' || raw.mode === 'attach') state.mode = raw.mode;
  if (typeof raw.altScreen === 'boolean') state.altScreen = raw.altScreen;
  // Размер панели — только парой и только правдоподобный: по нему клиент меняет размер экрана.
  const size = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000;
  if (size(raw.cols) && size(raw.rows)) {
    state.cols = raw.cols;
    state.rows = raw.rows;
  }
  return state;
}
