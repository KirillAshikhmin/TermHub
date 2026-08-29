// Общая обвязка тестов экрана терминала (term.ts): поддельный xterm и транспорт с
// журналом кадров. Тест подменяет '@xterm/xterm' через vi.mock на FakeTerminal —
// тогда проверяется поведение экрана (очередь ввода, Enter, фокус), а не рендер xterm.
import type { TermChannelOpts, Transport } from '../src/transport';

interface Disposable {
  dispose(): void;
}
const disposable = (): Disposable => ({ dispose() {} });

/** Поддельный Terminal: ровно та поверхность xterm, которую трогает term.ts. */
export class FakeTerminal {
  static instances: FakeTerminal[] = [];
  cols = 80;
  rows = 24;
  element = document.createElement('div');
  textarea = document.createElement('textarea');
  buffer = { active: { type: 'normal' as const, getLine: (): undefined => undefined } };
  unicode = { activeVersion: '' };
  options: Record<string, unknown>;
  mouseModeActive = false;
  mouseEvents: MouseEvent[] = [];
  parser = { registerOscHandler: disposable };
  focusCalls = 0;
  disposed = false;
  private dataHandler: ((s: string) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  private selectionHandler: (() => void) | null = null;
  private selection = '';

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    this.element.append(this.textarea);
    FakeTerminal.instances.push(this);
  }
  loadAddon(): void {}
  open(host: HTMLElement): void {
    host.append(this.element);
  }
  write(): void {}
  focus(): void {
    this.focusCalls += 1;
  }
  onData(cb: (s: string) => void): Disposable {
    this.dataHandler = cb;
    return disposable();
  }
  onBinary(): Disposable {
    return disposable();
  }
  onResize(): Disposable {
    return disposable();
  }
  onSelectionChange(cb: () => void): Disposable {
    this.selectionHandler = cb;
    return disposable();
  }
  getSelection(): string {
    return this.selection;
  }
  attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean): void {
    this.keyHandler = cb;
  }
  registerLinkProvider(): Disposable {
    return disposable();
  }
  dispose(): void {
    this.disposed = true;
  }
  /** Ввод пользователя — так xterm отдаёт набранное через onData. */
  type(s: string): void {
    this.dataHandler?.(s);
  }
  /** Событие клавиатуры через custom-обработчик xterm; возвращает его ответ. */
  key(e: KeyboardEvent): boolean {
    if (!this.keyHandler) throw new Error('custom key handler not attached');
    return this.keyHandler(e);
  }
  /** Имитирует selection lifecycle xterm, включая очистку при TUI-redraw. */
  select(text: string): void {
    this.selection = text;
    this.selectionHandler?.();
  }
  /** Моделирует xterm seam: при mouse tracking drag уходит TUI, кроме
   * macOS Option+drag с macOptionClickForcesSelection. */
  drag(text: string, opts: { altKey?: boolean } = {}): 'selection' | 'mouse' {
    const forceSelection = this.mouseModeActive
      && opts.altKey === true
      && this.options.macOptionClickForcesSelection === true;
    const down = new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      altKey: opts.altKey,
    });
    if (forceSelection) down.stopPropagation();
    this.element.dispatchEvent(down);

    if (this.mouseModeActive && !forceSelection) {
      this.mouseEvents.push(down);
    } else {
      this.selection = text;
      this.selectionHandler?.();
    }

    this.element.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 0,
      altKey: opts.altKey,
    }));
    return forceSelection || !this.mouseModeActive ? 'selection' : 'mouse';
  }
}

export interface Frame {
  kind: 'resize' | 'data';
  text: string;
}

export interface OpenedTerm {
  session: string;
  opts: TermChannelOpts;
  closed: boolean;
}

/** Транспорт-заглушка: openTerm отдаёт канал, пишущий кадры (в порядке отправки) в
 *  общий журнал frames; статус/конец сессии тест дёргает через opened[i].opts. */
export function termTransport(): { transport: Transport; frames: Frame[]; opened: OpenedTerm[] } {
  const frames: Frame[] = [];
  const opened: OpenedTerm[] = [];
  const decoder = new TextDecoder();
  const transport = {
    mode: 'lan',
    clientScope: null,
    list: async () => [],
    dirs: async () => [],
    gradle: async () => null,
    openTerm: (session: string, opts: TermChannelOpts) => {
      const entry: OpenedTerm = { session, opts, closed: false };
      opened.push(entry);
      return {
        write: (bytes: Uint8Array): void => {
          frames.push({ kind: 'data', text: decoder.decode(bytes) });
        },
        resize: (cols: number, rows: number): void => {
          frames.push({ kind: 'resize', text: `${cols}x${rows}` });
        },
        close: (): void => {
          entry.closed = true;
        },
      };
    },
    close: () => {},
  } as unknown as Transport;
  return { transport, frames, opened };
}

/** happy-dom без ResizeObserver, а term.ts наблюдает за host'ом — ставим заглушку. */
export function stubResizeObserver(): void {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    disconnect(): void {}
  };
}
