// Одно событие «окно поверх экрана закрылось» на всё приложение: его испускают общий
// помощник модальных окон и окна со своим закрытием (просмотр картинки, окно сессий, лист
// фоновых агентов, меню «⋯»). Экран под окном решает сам, что с этим делать: чат возвращает
// фокус в поле ввода. Модуль без зависимостей — его тянут и окна, и экраны.

const EVENT = 'termhub:overlay-closed';

/** Окно поверх экрана только что закрылось. */
export function noteOverlayClosed(): void {
  document.dispatchEvent(new Event(EVENT));
}

/** Подписка на закрытие окон; возвращает отписку. */
export function onOverlayClosed(fn: () => void): () => void {
  document.addEventListener(EVENT, fn);
  return () => document.removeEventListener(EVENT, fn);
}
