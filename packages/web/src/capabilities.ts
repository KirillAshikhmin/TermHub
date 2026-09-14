// Клиентская сторона объявления возможностей (ADR 0018): на подключении клиент
// называет агенту свои имена, агент отвечает своими, и дальше надстройки живут по
// пересечению. Пересечение принадлежит транспорту: обрыв и смена агента его гасят
// (forgetCaps), иначе экран отвечал бы за прежнего агента. Список — данные, а не
// тип: новое имя добавляется в CLIENT_CAPS, разбор не меняется.

import { CLIENT_CAPS, intersect } from '@termhub/protocol/capabilities';

import type { Transport } from './transport';

type CapsSource = Pick<Transport, 'capabilities'>;

/** Пересечение с текущим агентом; до обмена — пусто, то есть «ничего сверх базового». */
let negotiated: string[] = [];
/** Транспорт, которому принадлежит состояние: чужой ответ его не переписывает. */
let owner: CapsSource | null = null;
/** Обмен этого транспорта — идущий или уже завершённый: он один на транспорт. */
let exchange: Promise<string[]> | null = null;

/** Объявить свои возможности и запомнить пересечение. Обмен один на транспорт:
 *  повторный вызов отдаёт тот же результат, не беспокоя агента. Исключение —
 *  отказ авторизации: он про вход, а не про возможности, и обмен повторяется. */
export function negotiateCaps(transport: CapsSource): Promise<string[]> {
  if (owner !== transport) forgetCaps(); // сменился агент/транспорт — прежнее не действует
  if (exchange) return exchange;
  owner = transport;
  exchange = run(transport);
  return exchange;
}

async function run(transport: CapsSource): Promise<string[]> {
  let agentCaps: string[];
  try {
    agentCaps = await transport.capabilities([...CLIENT_CAPS]);
  } catch (err) {
    // 401 — мы ещё не вошли: про умения агента это не говорит ничего. Обмена не было,
    // следующий вызов (после входа) повторит его.
    if (unauthorized(err)) {
      exchange = null;
      return [];
    }
    // 404 (агент старше маршрута) или молчание — возможностей у агента нет.
    agentCaps = [];
  }
  // Пока ходили, транспорт сменился или соединение оборвалось: ответ уже ничей.
  if (owner !== transport) return [];
  negotiated = intersect(CLIENT_CAPS, agentCaps);
  return [...negotiated];
}

/** Отказ авторизации: `status` несёт ApiError (api.ts). */
function unauthorized(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === 401;
}

/** Забыть пересечение: соединение оборвалось или сменился агент — до нового обмена
 *  возможностей нет. */
export function forgetCaps(): void {
  negotiated = [];
  owner = null;
  exchange = null;
}

/** Понимают ли названную возможность ОБЕ стороны. */
export function hasCap(name: string): boolean {
  return negotiated.includes(name);
}

/** Понимают ли возможность обе стороны — с ожиданием обмена, если он ещё в пути.
 *  Единственный ответ на этот вопрос в вебе: и вкладка, и роутер спрашивают здесь,
 *  иначе каждый заводил бы свою ветку отказа (а третий вызывающий — третью).
 *  Обмен не состоялся — возможности нет. */
export function whenCap(name: string, transport: CapsSource): Promise<boolean> {
  if (hasCap(name)) return Promise.resolve(true);
  return negotiateCaps(transport).then(
    (caps) => caps.includes(name),
    () => false,
  );
}

/** Пересечение текущего обмена (копия — список клиента менять некому). */
export function negotiatedCaps(): string[] {
  return [...negotiated];
}
