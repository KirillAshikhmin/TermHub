// Команды `termhub devices` и `termhub revoke <fingerprint|имя>`.
// Локальные операции над authorized.json ЛОКАЛЬНОГО агента этой машины (не через
// relay): devices печатает список авторизованных устройств, revoke удаляет одно.

import { loadAuthorized, saveAuthorized } from './config.js';
import type { AuthorizedDevice } from './config.js';
import { stripUnsafe } from './safe-text.js';

/** Форматирует момент времени в локальную дату-время. */
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** Печатает список авторизованных устройств и возвращает его.
 *  Имя выбирает удалённая сторона при пейринге, поэтому печатаем его только
 *  обеззараженным: этот список — поверхность принятия решения об отзыве доступа,
 *  и устройство не должно уметь стереть или подделать в нём строку. */
export function runDevices(): AuthorizedDevice[] {
  const devices = loadAuthorized();
  if (devices.length === 0) {
    console.log('No authorized devices. Add one: termhub share');
    return devices;
  }
  console.log('Authorized devices:');
  for (const d of devices) console.log(`  ${stripUnsafe(d.name)}\t${d.fingerprint}\t${formatDate(d.addedAt)}`);
  return devices;
}

/** Удаляет устройство по fingerprint или имени; возвращает true при успехе. */
export function runRevoke(idOrName: string): boolean {
  const devices = loadAuthorized();
  // Сверяем и с обеззараженным именем: в authorized.json могли остаться записи,
  // сделанные до валидации имён, — иначе напечатанное имя нельзя было бы ввести.
  const match = devices.find(
    (d) => d.fingerprint === idOrName || d.name === idOrName || stripUnsafe(d.name) === idOrName,
  );
  if (!match) {
    console.error(`Device "${stripUnsafe(idOrName)}" not found (see termhub devices).`);
    return false;
  }
  saveAuthorized(devices.filter((d) => d !== match));
  console.log(`Device revoked: ${stripUnsafe(match.name)} (${match.fingerprint})`);
  return true;
}
