/** Системный запас PTY должен оставаться для Terminal.app, ssh и tmux. */
export const DEFAULT_MAX_PTY = 64;

/** Нет свободного слота TermHub: это штатный отказ, а не падение агента. */
export class PtyUnavailableError extends Error {
  constructor() {
    super('TermHub has reached its pseudo-terminal limit');
    this.name = 'PtyUnavailableError';
  }
}

/** Один слот, возвращаемый ровно один раз при dispose или exit дочернего pty. */
export interface PtyLease {
  release(): void;
}

/** Общий счётчик живых terminal bridges для LAN и relay. */
export class PtyPool {
  private active = 0;

  constructor(private readonly limit = DEFAULT_MAX_PTY) {}

  acquire(): PtyLease {
    if (this.active >= this.limit) throw new PtyUnavailableError();
    this.active += 1;
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.active -= 1;
      },
    };
  }
}

/** Единственный production-пул: один budget на LAN и relay одновременно. */
export const defaultPtyPool = new PtyPool();
