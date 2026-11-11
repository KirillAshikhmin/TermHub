// @vitest-environment happy-dom
// Кнопка «не давать засыпать»: нажатие — обычное удержание сна, удержание — режим
// «не спать при закрытой крышке» (хост на macOS). Оба переключения говорят тостом.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CaffeinateState } from '../src/api';
import { setLang, t } from '../src/i18n';
import type { Transport } from '../src/transport';
import { LID_HOLD_MS, renderMenu } from '../src/ui';

/** Хост-заглушка: состояние сна и крышки, как у агента. */
function host(init: Partial<CaffeinateState> = {}) {
  const state: CaffeinateState = { active: false, supported: true, lidSupported: true, lidReady: true, lid: false, ...init };
  const transport = {
    mode: 'lan',
    clientScope: null,
    capabilities: async () => [],
    caffeinate: vi.fn(async () => ({ ...state })),
    setCaffeinate: vi.fn(async (active: boolean) => {
      state.active = active;
      return { ...state };
    }),
    setLidAwake: vi.fn(async (on: boolean) => {
      if (state.lidReady) state.lid = on;
      return { ...state };
    }),
  } as unknown as Transport;
  return { state, transport };
}

const coffee = (menu: HTMLElement): HTMLButtonElement =>
  [...menu.querySelectorAll<HTMLButtonElement>('.th-menu__item')].find((b) => b.querySelector('.th-menu__label')?.textContent?.includes('Mac'))!;
const toasts = (): string[] => [...document.querySelectorAll('.th-toast')].map((n) => n.textContent ?? '');
const hold = async (btn: HTMLElement): Promise<void> => {
  btn.dispatchEvent(new Event('pointerdown'));
  await vi.advanceTimersByTimeAsync(LID_HOLD_MS + 1);
  btn.dispatchEvent(new Event('pointerup'));
  btn.click(); // хвост удержания: клик приходит следом и нажатием не считается
  await vi.advanceTimersByTimeAsync(0);
};

describe('не давать засыпать: нажатие и удержание', () => {
  beforeEach(() => {
    setLang('ru');
    vi.useFakeTimers();
    document.body.replaceChildren();
  });
  afterEach(() => vi.useRealTimers());

  it('нажатие переключает обычный режим и говорит об этом тостом', async () => {
    const { transport } = host();
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.setCaffeinate).toHaveBeenCalledWith(true);
    expect(btn.classList.contains('is-on')).toBe(true);
    expect(toasts()).toContain(t('header.keepAwakeOnToast'));
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(toasts()).toContain(t('header.keepAwakeOffToast'));
    menu.teardown();
  });

  it('удержание включает режим закрытой крышки: кнопка мигает, обычный режим не трогается', async () => {
    const { transport } = host();
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    expect(btn.title).toContain(t('header.lidAwakeHint'));
    await hold(btn);
    expect(transport.setLidAwake).toHaveBeenCalledWith(true);
    expect(transport.setCaffeinate).not.toHaveBeenCalled();
    expect(btn.classList.contains('is-lid')).toBe(true);
    expect(toasts()).toContain(t('header.lidAwakeOnToast'));
    await hold(btn); // повторное удержание выключает
    expect(btn.classList.contains('is-lid')).toBe(false);
    expect(toasts()).toContain(t('header.lidAwakeOffToast'));
    menu.teardown();
  });

  it('пока режим крышки включён, обычное нажатие выключает его, а не переключает другой режим', async () => {
    const { state, transport } = host();
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    await hold(btn);
    expect(btn.classList.contains('is-lid')).toBe(true);
    btn.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.setLidAwake).toHaveBeenLastCalledWith(false);
    expect(transport.setCaffeinate).not.toHaveBeenCalled();
    expect(state.lid).toBe(false);
    expect(btn.classList.contains('is-lid')).toBe(false);
    expect(toasts()).toContain(t('header.lidAwakeOffToast'));
    menu.teardown();
  });

  it('хост сам снял режим (крышку открыли) — мигание гаснет и приходит тост', async () => {
    const { state, transport } = host();
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    await hold(btn);
    state.lid = false; // агент: крышку закрыли и открыли
    await vi.advanceTimersByTimeAsync(5000);
    expect(btn.classList.contains('is-lid')).toBe(false);
    expect(toasts()).toContain(t('header.lidAwakeAuto'));
    menu.teardown();
  });

  it('на хосте нет разрешения — режим не включается, тост говорит про настройку', async () => {
    const { transport } = host({ lidReady: false });
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    await hold(btn);
    expect(btn.classList.contains('is-lid')).toBe(false);
    expect(toasts()).toContain(t('header.lidAwakeSetup'));
    menu.teardown();
  });

  it('хост не на macOS — удержания нет: это обычное нажатие', async () => {
    const { transport } = host({ lidSupported: false, lidReady: false });
    const menu = renderMenu(transport);
    await vi.advanceTimersByTimeAsync(0);
    const btn = coffee(menu.el);
    expect(btn.title).not.toContain(t('header.lidAwakeHint'));
    await hold(btn);
    expect(transport.setLidAwake).not.toHaveBeenCalled();
    expect(transport.setCaffeinate).toHaveBeenCalledWith(true);
    menu.teardown();
  });
});
