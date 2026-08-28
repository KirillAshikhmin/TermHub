// @vitest-environment happy-dom
// Модалка создания сессии через транспорт-заглушку (по образцу dashboard-relay.test.ts).
// Проверяется МЕХАНИЗМ ухода в созданную сессию, а не сама гонка R11: в happy-dom
// History.back() синхронный, и баг (отложенный back() возвращает на запись модалки со
// старым URL) здесь не воспроизвести. Утверждаем, что на пути создания history.back()
// не зовётся вовсе, а запись модалки ЗАМЕНЯЕТСЯ маршрутом через location.replace.
// Сам location.replace для hash-URL в happy-dom ведёт себя как assign (пушит запись),
// поэтому подменён верной по спецификации эмуляцией — history.replaceState.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api';
import { openCreateModal } from '../src/dashboard';
import { setLang, t } from '../src/i18n';
import type { CreateSessionInput, DirGroup, Transport } from '../src/transport';
import { dismissOverlays, toast } from '../src/ui';

// vi.mock хоистится над импортами самим vitest — порядок объявления не важен.
vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return { ...actual, toast: vi.fn() };
});

const toastMock = vi.mocked(toast);

const GROUPS: DirGroup[] = [{ root: '/Users/me/projects', dirs: ['MyProject', 'Other'] }];

/** Модалка трогает у транспорта только dirs() и create(); create записывает запросы. */
function fakeTransport(opts: {
  groups: DirGroup[];
  create: (req: CreateSessionInput) => Promise<string>;
}): { transport: Transport; calls: CreateSessionInput[] } {
  const calls: CreateSessionInput[] = [];
  const transport = {
    mode: 'lan',
    clientScope: null,
    dirs: () => Promise.resolve(opts.groups),
    create: (req: CreateSessionInput) => {
      calls.push(req);
      return opts.create(req);
    },
  } as unknown as Transport;
  return { transport, calls };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function form(): HTMLFormElement {
  const el = document.querySelector<HTMLFormElement>('form.th-create');
  if (!el) throw new Error('модалка создания не смонтирована');
  return el;
}

/** Контрол поля по его подписи (label.th-field > .th-field__label). */
function control<T extends HTMLElement>(label: string): T {
  for (const field of form().querySelectorAll('label.th-field')) {
    if (field.querySelector('.th-field__label')?.textContent !== label) continue;
    const el = field.querySelector<T>('input, select');
    if (el) return el;
  }
  throw new Error(`нет поля «${label}»`);
}

function button(label: string): HTMLButtonElement {
  for (const btn of form().querySelectorAll('button')) if (btn.textContent === label) return btn;
  throw new Error(`нет кнопки «${label}»`);
}

function submit(): void {
  form().dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

let back: ReturnType<typeof vi.spyOn>;
let replace: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setLang('ru');
  toastMock.mockReset();
  location.hash = '#/'; // экран, откуда нажали «+»
  back = vi.spyOn(history, 'back');
  // Настоящий location.replace для hash-URL: текущая запись заменяется, ничего не пушится.
  replace = vi.spyOn(location, 'replace').mockImplementation((url: string | URL) => {
    history.replaceState(history.state, '', String(url));
  });
});

afterEach(() => {
  dismissOverlays();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('openCreateModal — уход в созданную сессию (R07i, R11, R11.1)', () => {
  it('после «Создать» запись модалки заменяется маршрутом созданной сессии: без history.back(), hash = #/term/<имя из ответа>', async () => {
    const { transport } = fakeTransport({ groups: GROUPS, create: () => Promise.resolve('MyProject1') });
    const lengthBefore = history.length;
    openCreateModal(transport);
    await flush();
    expect(history.length).toBe(lengthBefore + 1); // запись модалки — её снимает «Назад»

    submit();
    await flush();

    expect(back).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith('#/term/MyProject1');
    // Имя — из ответа транспорта (MyProject1), а не запрошенное (MyProject).
    expect(location.hash).toBe('#/term/MyProject1');
    // История — [откуда пришли, новая сессия]: запись модалки заменена, не добавлена.
    expect(history.length).toBe(lengthBefore + 1);
  });
});

describe('openCreateModal — признак autoName, форма из списка каталогов (R02, R06i)', () => {
  it('поле «Имя» пустое (подсказка — имя папки) → create получает имя каталога и autoName: true', async () => {
    const { transport, calls } = fakeTransport({ groups: GROUPS, create: (req) => Promise.resolve(req.name) });
    openCreateModal(transport);
    await flush();
    const name = control<HTMLInputElement>(t('create.name'));
    expect(name.value).toBe('');
    expect(name.placeholder).toBe('MyProject');
    control<HTMLSelectElement>(t('create.directory')).value = 'Other';

    submit();
    await flush();

    expect(calls).toEqual([{ name: 'Other', root: '/Users/me/projects', dir: 'Other', preset: 'zsh', autoName: true }]);
  });

  it('имя введено руками → уходит санитизированным и БЕЗ признака autoName', async () => {
    const { transport, calls } = fakeTransport({ groups: GROUPS, create: (req) => Promise.resolve(req.name) });
    openCreateModal(transport);
    await flush();
    control<HTMLInputElement>(t('create.name')).value = '  custom.name ';

    submit();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'custom_name', root: '/Users/me/projects', dir: 'MyProject' });
    expect(calls[0]).not.toHaveProperty('autoName');
  });
});

describe('openCreateModal — признак autoName, ручная форма (relay: каталогов нет) (R06i)', () => {
  it('пустое имя → name = введённый каталог, autoName: true', async () => {
    const { transport, calls } = fakeTransport({ groups: [], create: (req) => Promise.resolve(req.name) });
    openCreateModal(transport);
    await flush();
    control<HTMLInputElement>(t('create.root')).value = ' /srv/projects ';
    control<HTMLInputElement>(t('create.directory')).value = 'MyProject';
    expect(control<HTMLInputElement>(t('create.name')).value).toBe('');

    submit();
    await flush();

    expect(calls).toEqual([{ name: 'MyProject', root: '/srv/projects', dir: 'MyProject', preset: 'zsh', autoName: true }]);
  });

  it('введённое имя → без признака autoName', async () => {
    const { transport, calls } = fakeTransport({ groups: [], create: (req) => Promise.resolve(req.name) });
    openCreateModal(transport);
    await flush();
    control<HTMLInputElement>(t('create.root')).value = '/srv/projects';
    control<HTMLInputElement>(t('create.directory')).value = 'MyProject';
    control<HTMLInputElement>(t('create.name')).value = 'mine';

    submit();
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'mine', root: '/srv/projects', dir: 'MyProject' });
    expect(calls[0]).not.toHaveProperty('autoName');
  });
});

describe('openCreateModal — закрытие без создания (R11.2) и ошибка создания', () => {
  it('«Отмена» снимает запись модалки через history.back(); маршрут и транспорт не трогаются', async () => {
    const { transport, calls } = fakeTransport({ groups: GROUPS, create: () => Promise.resolve('x') });
    openCreateModal(transport);
    await flush();

    button(t('common.cancel')).click();

    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/');
    expect(calls).toEqual([]);
  });

  it('крестик в шапке — тоже history.back()', async () => {
    const { transport } = fakeTransport({ groups: GROUPS, create: () => Promise.resolve('x') });
    openCreateModal(transport);
    await flush();

    form().querySelector<HTMLButtonElement>('.th-modal__head button')!.click();

    expect(back).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it('ошибка создания → тост с сообщением агента, кнопка снова активна, навигации нет', async () => {
    const { transport } = fakeTransport({
      groups: GROUPS,
      create: () => Promise.reject(new ApiError(409, 'duplicate session: MyProject')),
    });
    openCreateModal(transport);
    await flush();

    submit();
    await flush();

    expect(toastMock).toHaveBeenCalledWith('duplicate session: MyProject', 'error');
    expect(button(t('create.submit')).disabled).toBe(false);
    expect(back).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/');
  });
});
