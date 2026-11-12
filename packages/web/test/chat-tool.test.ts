// @vitest-environment happy-dom
// Раскрытие действия в чате: строка → команда с выводом или diff. Подробности приходят
// отдельным запросом по раскрытию; ожидаемые тексты — по критериям таска (R08.1–R08.3).
import { describe, expect, it, vi } from 'vitest';

import { setLang } from '../src/i18n';
import { mountToolDetail, renderDiff } from '../src/chat-tool';
import type { DetailResult, FeedEntry } from '../src/transport';

setLang('ru');

const ENTRY: FeedEntry = { id: 'u1', at: 0, kind: 'tool', tool: 'Bash', text: 'Bash npm test', detail: true, cursor: '1:2' };

function row(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'th-feed__entry th-feed__entry--tool';
  const name = document.createElement('span');
  name.textContent = 'Bash';
  const what = document.createElement('span');
  what.textContent = 'npm test';
  el.append(name, what);
  document.body.replaceChildren(el);
  return el;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('раскрытие действия', () => {
  it('тап раскрывает команду и вывод, повторный сворачивает; запрос ровно один — по первому раскрытию', async () => {
    const load = vi.fn((): Promise<DetailResult> => Promise.resolve({ ok: true, input: 'npm test', output: 'PASS\n3 tests' }));
    const el = row();
    mountToolDetail(el, ENTRY, load);
    expect(load).not.toHaveBeenCalled();
    const head = el.querySelector<HTMLElement>('.th-tool__head')!;

    head.click();
    expect(el.querySelector('.th-tool__loading')).not.toBeNull(); // индикатор, пока грузится
    await flush();
    expect(el.querySelector('.th-tool__loading')).toBeNull();
    expect(el.querySelector('.th-tool__input')!.textContent).toBe('npm test');
    expect(el.querySelector('.th-tool__output')!.textContent).toBe('PASS\n3 tests');
    expect(head.getAttribute('aria-expanded')).toBe('true');

    head.click();
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector<HTMLElement>('.th-tool__panel')!.hidden).toBe(true);
    head.click(); // снова открыли — из памяти, без сети
    expect(load).toHaveBeenCalledTimes(1);
    expect(el.querySelector<HTMLElement>('.th-tool__panel')!.hidden).toBe(false);
  });

  it('отказ и обрыв — строка ошибки с «Повторить»; повтор перезапрашивает, остальной чат цел', async () => {
    const load = vi
      .fn<() => Promise<DetailResult>>()
      .mockRejectedValueOnce(new Error('relay disconnected'))
      .mockResolvedValueOnce({ ok: false, reason: 'lookup-failed', detail: 'x' })
      .mockResolvedValueOnce({ ok: true, output: 'ok' });
    const el = row();
    mountToolDetail(el, ENTRY, load);
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelector('.th-tool__error')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.th-tool__retry')!.click();
    await flush();
    expect(el.querySelector('.th-tool__error')).not.toBeNull(); // отказ значением — тоже ошибка
    el.querySelector<HTMLButtonElement>('.th-tool__retry')!.click();
    await flush();
    expect(el.querySelector('.th-tool__error')).toBeNull();
    expect(el.querySelector('.th-tool__output')!.textContent).toBe('ok');
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('pending говорит «ещё выполняется», пустой результат — «результата нет»; ещё идущее перезапрашивается', async () => {
    const load = vi
      .fn<() => Promise<DetailResult>>()
      .mockResolvedValueOnce({ ok: true, input: 'sleep 9', pending: true })
      .mockResolvedValueOnce({ ok: true });
    const el = row();
    mountToolDetail(el, ENTRY, load);
    const head = el.querySelector<HTMLElement>('.th-tool__head')!;
    head.click();
    await flush();
    expect(el.querySelector('.th-tool__pending')!.textContent).toBe('Ещё выполняется');
    expect(el.querySelector('.th-tool__input')!.textContent).toBe('sleep 9');
    head.click();
    head.click(); // pending не кэшируется: действие могло закончиться
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(el.querySelector('.th-tool__pending')).toBeNull();
    expect(el.querySelector('.th-tool__none')!.textContent).toBe('Результата нет');
  });

  it('cursor-stale — подробностей больше нет, повтор не предлагается', async () => {
    const el = row();
    mountToolDetail(el, ENTRY, () => Promise.resolve({ ok: false, reason: 'cursor-stale', detail: '' }));
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelector('.th-tool__error')!.textContent).toContain('Подробностей больше нет');
    expect(el.querySelector('.th-tool__retry')).toBeNull();
  });

  it('вывод с пометкой truncated — подпись об обрезке', async () => {
    const el = row();
    mountToolDetail(el, ENTRY, () => Promise.resolve({ ok: true, output: 'abc', truncated: true }));
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelector('.th-tool__truncated')!.textContent).toBe('вывод обрезан');
  });

  it('клавиатура: Enter и пробел на строке раскрывают', async () => {
    const el = row();
    mountToolDetail(el, ENTRY, () => Promise.resolve({ ok: true, output: 'x' }));
    const head = el.querySelector<HTMLElement>('.th-tool__head')!;
    expect(head.getAttribute('role')).toBe('button');
    head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flush();
    expect(head.getAttribute('aria-expanded')).toBe('true');
  });

  it('вывод из чужого транскрипта — только текст, разметка не парсится', async () => {
    const el = row();
    mountToolDetail(el, ENTRY, () => Promise.resolve({ ok: true, output: '<img src=x onerror=alert(1)>' }));
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelector('img')).toBeNull();
  });
});

describe('diff', () => {
  it('добавленные и убранные строки — своими классами, знак отдельно от текста', () => {
    const node = renderDiff({
      diff: [{ path: 'src/a.ts', lines: [{ t: ' ', s: 'ctx' }, { t: '-', s: 'old' }, { t: '+', s: 'new' }] }],
    });
    expect(node.querySelector('.th-diff__path')!.textContent).toBe('src/a.ts');
    const lines = [...node.querySelectorAll<HTMLElement>('.th-diff__line')];
    expect(lines.map((l) => l.className.replace('th-diff__line ', ''))).toEqual(['is-ctx', 'is-del', 'is-add']);
    expect(lines.map((l) => l.querySelector('.th-diff__sign')!.textContent)).toEqual([' ', '-', '+']);
    expect(lines.map((l) => l.querySelector('.th-diff__text')!.textContent)).toEqual(['ctx', 'old', 'new']);
  });

  it('несколько файлов — по блоку на файл; раскрытие правки показывает diff, а не вывод', async () => {
    const detail: DetailResult = {
      ok: true,
      diff: [
        { path: 'a.ts', lines: [{ t: '+', s: '1' }] },
        { path: 'b.ts', lines: [{ t: '-', s: '2' }] },
      ],
    };
    const el = row();
    mountToolDetail(el, { ...ENTRY, tool: 'Edit' }, () => Promise.resolve(detail));
    el.querySelector<HTMLElement>('.th-tool__head')!.click();
    await flush();
    expect(el.querySelectorAll('.th-diff__file').length).toBe(2);
    expect(el.querySelector('.th-tool__output')).toBeNull();
  });
});
