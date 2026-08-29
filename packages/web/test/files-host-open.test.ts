// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileContent } from '@termhub/protocol/frames';

import { mountFiles } from '../src/files';
import { setLang, t } from '../src/i18n';
import type { FileStat, Transport } from '../src/transport';
import { dismissOverlays, toast } from '../src/ui';

vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return {
    ...actual,
    renderHeader: () => ({ el: document.createElement('header'), teardown: () => {} }),
    renderTabs: () => document.createElement('nav'),
    openModal: (builder: (close: () => void) => HTMLElement) => {
      const el = builder(() => {});
      document.body.append(el);
      return () => el.remove();
    },
    toast: vi.fn(),
  };
});

const toastMock = vi.mocked(toast);
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeTransport(opts?: {
  scope?: { session: string; files: boolean; write: boolean } | null;
  stat?: FileStat;
  content?: FileContent;
  open?: () => Promise<unknown>;
}): { transport: Transport; fileOps: Array<{ action: string; params: Record<string, unknown> }> } {
  const fileOps: Array<{ action: string; params: Record<string, unknown> }> = [];
  const transport = {
    mode: opts?.scope ? 'relay' : 'lan',
    clientScope: opts?.scope ?? null,
    caffeinate: () => Promise.resolve({ active: false, supported: false }),
    dirs: () => Promise.resolve([{ root: '/projects', dirs: [] }]),
    filesList: () =>
      Promise.resolve([{ name: 'report.txt', kind: 'file', size: 5, mtime: 1, hidden: false }]),
    fileStat: () =>
      Promise.resolve(opts?.stat ?? { size: 5, mime: 'text/plain', kind: 'text' }),
    fileRead: () =>
      Promise.resolve(
        opts?.content ?? { kind: 'text', mime: 'text/plain', data: 'hello', size: 5, truncated: false },
      ),
    downloadUrl: () => '/download',
    fileOp: (action: string, params: Record<string, unknown>) => {
      fileOps.push({ action, params });
      return opts?.open?.() ?? Promise.resolve();
    },
  } as unknown as Transport;
  return { transport, fileOps };
}

async function openViewer(transport: Transport): Promise<HTMLButtonElement[]> {
  const root = document.createElement('div');
  document.body.append(root);
  mountFiles(root, transport);
  await flush();
  await flush();
  root.querySelector<HTMLButtonElement>('.th-files__row')!.click();
  await flush();
  await flush();
  return [...document.querySelectorAll<HTMLButtonElement>('.th-fileview .th-modal__foot button')];
}

beforeEach(() => {
  setLang('ru');
  location.hash = '#/files';
  toastMock.mockReset();
});

afterEach(() => {
  dismissOverlays();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('file viewer — «Открыть на хосте»', () => {
  it('показывает действие в текстовом preview и отправляет open-host с root/path', async () => {
    const { transport, fileOps } = fakeTransport();
    const buttons = await openViewer(transport);
    const openHost = buttons.find((button) => button.textContent === t('files.openHost'));

    expect(openHost).toBeDefined();
    openHost!.click();
    await flush();

    expect(fileOps).toEqual([{ action: 'open-host', params: { root: '/projects', path: 'report.txt' } }]);
  });

  it.each([
    ['text', { size: 5, mime: 'text/plain', kind: 'text' }, { kind: 'text', mime: 'text/plain', data: 'hello', size: 5, truncated: false }],
    ['image', { size: 5, mime: 'image/png', kind: 'image' }, { kind: 'image', mime: 'image/png', data: 'AA==', size: 5, truncated: false }],
    ['media', { size: 5, mime: 'video/mp4', kind: 'video' }, undefined],
    ['binary', { size: 5, mime: 'application/octet-stream', kind: 'binary' }, { kind: 'binary', mime: 'application/octet-stream', data: '', size: 5, truncated: false }],
    ['truncated', { size: 500, mime: 'text/plain', kind: 'text' }, { kind: 'text', mime: 'text/plain', data: '', size: 500, truncated: true }],
  ] as const)('показывает действие для %s preview', async (_label, stat, content) => {
    const { transport } = fakeTransport({
      stat: stat as FileStat,
      content: content as FileContent | undefined,
    });
    const buttons = await openViewer(transport);

    expect(buttons.some((button) => button.textContent === t('files.openHost'))).toBe(true);
  });

  it('на время pending блокирует повторный click, затем показывает success и оставляет модалку открытой', async () => {
    let resolveOpen!: () => void;
    const pending = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const { transport, fileOps } = fakeTransport({ open: () => pending });
    const buttons = await openViewer(transport);
    const openHost = buttons.find((button) => button.textContent === t('files.openHost'))!;

    openHost.click();
    openHost.click();
    expect(openHost.disabled).toBe(true);
    expect(fileOps).toHaveLength(1);

    resolveOpen();
    await flush();
    expect(openHost.disabled).toBe(false);
    expect(toastMock).toHaveBeenCalledWith(t('files.openedOnHost'), 'info');
    expect(document.querySelector('.th-fileview')).not.toBeNull();
  });

  it('после ошибки показывает сообщение агента, снова включает кнопку и оставляет модалку открытой', async () => {
    const { transport } = fakeTransport({ open: () => Promise.reject(new Error('host opener failed')) });
    const buttons = await openViewer(transport);
    const openHost = buttons.find((button) => button.textContent === t('files.openHost'))!;

    openHost.click();
    await flush();

    expect(toastMock).toHaveBeenCalledWith('host opener failed', 'error');
    expect(openHost.disabled).toBe(false);
    expect(document.querySelector('.th-fileview')).not.toBeNull();
  });

  it('не показывает действие read-only relay-гостю', async () => {
    const { transport } = fakeTransport({ scope: { session: 'TermHub', files: true, write: false } });
    const buttons = await openViewer(transport);

    expect(buttons.some((button) => button.textContent === t('files.openHost'))).toBe(false);
  });

  it('показывает действие relay-клиенту с write-доступом', async () => {
    const { transport } = fakeTransport({ scope: { session: 'TermHub', files: true, write: true } });
    const buttons = await openViewer(transport);

    expect(buttons.some((button) => button.textContent === t('files.openHost'))).toBe(true);
  });
});
