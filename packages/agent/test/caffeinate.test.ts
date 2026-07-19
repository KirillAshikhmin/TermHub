import { describe, it, expect, vi } from 'vitest';

import { Caffeinate } from '../src/caffeinate.js';

/** Фейковый дочерний процесс: копит слушатели, умеет «умереть» и посчитать kill. */
function fakeProc() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  return {
    killed: 0,
    on(ev: string, cb: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(cb);
    },
    kill() {
      this.killed += 1;
    },
    emit(ev: string) {
      for (const cb of handlers[ev] ?? []) cb();
    },
  };
}

describe('Caffeinate', () => {
  it('set(true) спавнит ровно один процесс и активен; повторный set(true) не плодит', () => {
    const spawn = vi.fn(() => fakeProc());
    const caf = new Caffeinate({ spawn, supported: true });
    expect(caf.isActive()).toBe(false);
    caf.set(true);
    expect(caf.isActive()).toBe(true);
    caf.set(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('set(false) убивает процесс и снимает активность', () => {
    const proc = fakeProc();
    const caf = new Caffeinate({ spawn: () => proc, supported: true });
    caf.set(true);
    caf.set(false);
    expect(caf.isActive()).toBe(false);
    expect(proc.killed).toBe(1);
  });

  it('внезапный exit процесса сбрасывает активность', () => {
    const proc = fakeProc();
    const caf = new Caffeinate({ spawn: () => proc, supported: true });
    caf.set(true);
    proc.emit('exit');
    expect(caf.isActive()).toBe(false);
  });

  it('ошибка запуска (error) сбрасывает активность', () => {
    const proc = fakeProc();
    const caf = new Caffeinate({ spawn: () => proc, supported: true });
    caf.set(true);
    proc.emit('error');
    expect(caf.isActive()).toBe(false);
  });

  it('на неподдерживаемой платформе set(true) не спавнит и не активен', () => {
    const spawn = vi.fn(() => fakeProc());
    const caf = new Caffeinate({ spawn, supported: false });
    caf.set(true);
    expect(caf.isActive()).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(caf.supported).toBe(false);
  });

  it('stop() при неактивном — безопасен (не бросает)', () => {
    const caf = new Caffeinate({ spawn: () => fakeProc(), supported: true });
    expect(() => caf.set(false)).not.toThrow();
    expect(caf.isActive()).toBe(false);
  });
});
