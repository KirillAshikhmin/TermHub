export interface TerminalCopyController {
  selectionChanged(): void;
  gestureStarted(): void;
  gestureEnded(): void;
  keyEvent(event: KeyboardEvent): boolean;
  snapshot(): string;
}

export function createTerminalCopyController(opts: {
  getSelection(): string;
  copy(text: string): Promise<boolean>;
}): TerminalCopyController {
  let lastSelection = '';

  const capture = (): string => {
    const selection = opts.getSelection();
    if (selection) lastSelection = selection;
    return selection;
  };

  const copySelection = (): void => {
    const text = capture() || lastSelection;
    if (!text) return;
    try {
      void opts.copy(text).catch(() => undefined);
    } catch {
      // Ошибка clipboard не должна ломать ввод терминала; snapshot остаётся для повтора.
    }
  };

  return {
    selectionChanged: () => {
      capture();
    },
    gestureStarted: () => {
      lastSelection = '';
    },
    gestureEnded: copySelection,
    keyEvent: (event) => {
      if (
        event.type !== 'keydown' ||
        event.key.toLowerCase() !== 'c' ||
        (!event.metaKey && !event.ctrlKey) ||
        event.altKey
      ) {
        return true;
      }
      capture();
      if (!lastSelection) return true;
      event.preventDefault();
      copySelection();
      return false;
    },
    snapshot: () => lastSelection,
  };
}
