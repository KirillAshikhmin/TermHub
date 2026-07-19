// Терминальные фрейм-хелперы поверх кодека @termhub/protocol. Кодек НЕ дублируем —
// импортируем из подпути /frames (без крипто-модуля, чтобы libsodium не попадал в
// бандл LAN-терминала). В LAN один WS на терминал, поэтому channel всегда 0.

import { decodeFrame, encodeFrame, frameJson, FrameType, jsonFrame } from '@termhub/protocol/frames';
import type { Frame } from '@termhub/protocol/frames';

export { decodeFrame, frameJson, FrameType };
export type { Frame };

/** В LAN мультиплексирования нет — единственный канал. */
export const LAN_CHANNEL = 0;

/** DATA-фрейм с сырыми байтами терминала (ввод пользователя → pty). */
export function dataFrame(payload: Uint8Array): Uint8Array {
  return encodeFrame({ type: FrameType.Data, channel: LAN_CHANNEL, payload });
}

/** RESIZE-фрейм с размерами окна. Первый кадр после open — обязателен: без него
 *  агент не спавнит pty. */
export function resizeFrame(cols: number, rows: number): Uint8Array {
  return jsonFrame(FrameType.Resize, LAN_CHANNEL, { cols, rows });
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
