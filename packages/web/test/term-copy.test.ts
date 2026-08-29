import { describe, expect, it, vi } from 'vitest';

import { createTerminalCopyController } from '../src/term-copy';

describe('createTerminalCopyController', () => {
  it('сохраняет последний непустой selection после сброса выделения перерисовкой', () => {
    let selection = 'ответ Codex';
    const copy = vi.fn(async () => true);
    const controller = createTerminalCopyController({ getSelection: () => selection, copy });

    controller.selectionChanged();
    selection = '';
    controller.selectionChanged();

    expect(controller.snapshot()).toBe('ответ Codex');
  });

  it('сбрасывает старый snapshot в начале нового жеста выделения', () => {
    let selection = 'старый текст';
    const copy = vi.fn(async () => true);
    const controller = createTerminalCopyController({ getSelection: () => selection, copy });
    controller.selectionChanged();

    selection = '';
    controller.gestureStarted();
    controller.gestureEnded();

    expect(controller.snapshot()).toBe('');
    expect(copy).not.toHaveBeenCalled();
  });

  it('автоматически копирует непустой snapshot в конце жеста', async () => {
    const copy = vi.fn(async () => true);
    const controller = createTerminalCopyController({ getSelection: () => 'выделение', copy });
    controller.selectionChanged();

    controller.gestureEnded();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('выделение'));
  });

  it('после ошибки автокопирования сохраняет snapshot для повтора через Command+C', async () => {
    const copy = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValue(true);
    let selection = 'важный текст';
    const controller = createTerminalCopyController({ getSelection: () => selection, copy });
    controller.selectionChanged();
    controller.gestureEnded();
    await Promise.resolve();
    selection = '';
    const preventDefault = vi.fn();

    const pass = controller.keyEvent({
      type: 'keydown', key: 'c', metaKey: true, ctrlKey: false, altKey: false, preventDefault,
    } as unknown as KeyboardEvent);

    expect(pass).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
    expect(copy).toHaveBeenLastCalledWith('важный текст');
  });

  it('после clipboard-отказа false сохраняет snapshot для повтора через Command+C', async () => {
    const copy = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    let selection = 'важный текст';
    const controller = createTerminalCopyController({ getSelection: () => selection, copy });
    controller.selectionChanged();
    controller.gestureEnded();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    selection = '';
    const preventDefault = vi.fn();

    const pass = controller.keyEvent({
      type: 'keydown', key: 'c', metaKey: true, ctrlKey: false, altKey: false, preventDefault,
    } as unknown as KeyboardEvent);

    expect(controller.snapshot()).toBe('важный текст');
    expect(pass).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(2));
    expect(copy).toHaveBeenLastCalledWith('важный текст');
  });

  it('не перехватывает Ctrl+C, если текущего или сохранённого selection нет', () => {
    const copy = vi.fn(async () => true);
    const controller = createTerminalCopyController({ getSelection: () => '', copy });
    const preventDefault = vi.fn();

    const pass = controller.keyEvent({
      type: 'keydown', key: 'c', metaKey: false, ctrlKey: true, altKey: false, preventDefault,
    } as unknown as KeyboardEvent);

    expect(pass).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('Ctrl+C копирует текущее выделение и не отправляется в терминал', async () => {
    const copy = vi.fn(async () => true);
    const controller = createTerminalCopyController({ getSelection: () => 'current', copy });
    const preventDefault = vi.fn();

    const pass = controller.keyEvent({
      type: 'keydown', key: 'C', metaKey: false, ctrlKey: true, altKey: false, preventDefault,
    } as unknown as KeyboardEvent);

    expect(pass).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('current'));
  });
});
