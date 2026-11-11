// Мышь в зеркале. Пока размер панели держит другой клиент, экран терминала вписан в
// контейнер масштабом (CSS transform). xterm о масштабе не знает: ячейку под указателем
// он считает как (clientX − левый край экрана) / ширина ячейки, где край уже
// масштабирован, а ширина ячейки — нет. Выделение и клик по пути попадали бы в ячейку,
// умноженную на масштаб. Поэтому события мыши над зеркалом перехватываются до xterm и
// повторяются с координатами, пересчитанными в систему немасштабированного экрана.

const TYPES = ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'wheel'] as const;

/** Координата в немасштабированной системе: расстояние от края экрана делится на масштаб. */
export function unscale(client: number, edge: number, scale: number): number {
  return edge + (client - edge) / scale;
}

/** Включает пересчёт. `screen` — элемент экрана xterm (или undefined, пока его нет),
 *  `scale` — текущий масштаб (1 — зеркала нет, пересчёт не нужен). Возвращает выключение. */
export function correctMirrorMouse(screen: () => HTMLElement | null | undefined, scale: () => number): () => void {
  const mine = new WeakSet<Event>();
  // Протяжка, начатая над зеркалом, продолжается и за его пределами: xterm слушает
  // движение и отпускание на документе.
  let dragging = false;

  const handler = (event: Event): void => {
    if (mine.has(event) || !(event instanceof MouseEvent)) return;
    const k = scale();
    const el = screen();
    if (!el || !(k > 0) || k >= 1) {
      dragging = false;
      return;
    }
    const target = event.target;
    const inside = target instanceof Node && el.contains(target);
    if (event.type === 'mousedown') dragging = inside;
    if (!inside && !dragging) return;
    if (event.type === 'mouseup') dragging = false;
    // Цель без dispatchEvent повторить некуда. Проверка по методу, а не по классу:
    // у окна и у узлов из другого контекста класс EventTarget свой.
    if (!target || typeof target.dispatchEvent !== 'function') return;

    const rect = el.getBoundingClientRect();
    const init: MouseEventInit & WheelEventInit = {
      bubbles: event.bubbles,
      cancelable: event.cancelable,
      composed: event.composed,
      view: event.view,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: unscale(event.clientX, rect.left, k),
      clientY: unscale(event.clientY, rect.top, k),
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons,
      relatedTarget: event.relatedTarget,
    };
    let copy: MouseEvent;
    if (typeof WheelEvent !== 'undefined' && event instanceof WheelEvent) {
      copy = new WheelEvent(event.type, {
        ...init,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaZ: event.deltaZ,
        deltaMode: event.deltaMode,
      });
    } else copy = new MouseEvent(event.type, init);
    mine.add(copy);
    event.stopImmediatePropagation();
    // Что решил обработчик о действии по умолчанию, то и остаётся у настоящего события.
    if (!target.dispatchEvent(copy)) event.preventDefault();
  };

  for (const type of TYPES) document.addEventListener(type, handler, { capture: true, passive: false });
  return () => {
    for (const type of TYPES) document.removeEventListener(type, handler, { capture: true });
  };
}
