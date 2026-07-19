// Точка активности сессии перед именем: маленький кружок, «гуляющий» между двумя
// позициями (как индикатор в IDE). Рисование и анимацию (CSS transform — надёжно
// везде, без шрифтовых артефактов брайля) задаёт CSS: см.
// .th-tab__activity / .th-card__activity в theme.css.

/** Создаёт узел точки активности. `extraClass` задаёт стиль/позицию/анимацию. */
export function makeActivityDot(extraClass: string, ariaLabel: string): HTMLElement {
  const dot = document.createElement('span');
  dot.className = extraClass;
  dot.setAttribute('aria-label', ariaLabel);
  return dot;
}
