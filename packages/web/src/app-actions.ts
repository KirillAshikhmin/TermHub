// Действия приложения, вызываемые снаружи: пункты меню иконки установленного PWA (поле
// `shortcuts` манифеста) открывают адрес вида `#/do/<действие>`. Это не экран, а просьба
// открыть окно поверх текущего — поэтому адрес после разбора возвращается на прежний.

export type AppAction = 'new' | 'usage' | 'settings';

const ACTIONS: readonly AppAction[] = ['new', 'usage', 'settings'];

/** Действие из hash (`#/do/new`); null — hash не про действие или действие незнакомо. */
export function parseAction(hash: string): AppAction | null {
  const found = /^#\/do\/([a-z]+)$/.exec(hash);
  if (!found) return null;
  return ACTIONS.find((a) => a === found[1]) ?? null;
}

/** Действие из полного адреса запуска (launchQueue отдаёт `targetURL`). */
export function actionOfUrl(url: string): AppAction | null {
  try {
    return parseAction(new URL(url).hash);
  } catch {
    return null;
  }
}

/** Сколько ждёт действие, которому пока не на чем выполниться (нет связи, экран входа). */
export const ACTION_WAIT_MS = 15_000;
