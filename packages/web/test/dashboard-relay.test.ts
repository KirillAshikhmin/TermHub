// @vitest-environment happy-dom
// Регрессия на дашборд + relay-обрыв: transport.list() валится, пока связь не
// streaming — не должно быть тоста на каждый 3с-полл (см. relay-transport.test.ts
// для проверки самого RelayTransport). Транспорт здесь — простая заглушка
// Transport (не RelayTransport), чтобы не тянуть крипто/WS в этот файл.
import type { SessionInfo } from '@termhub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mountDashboard } from '../src/dashboard';
import { setLang } from '../src/i18n';
import type { CaffeinateState, CreateSessionInput, DeviceInfo, DeviceScope, DirGroup, FileContent, FileEntry, FileStat, ShareInfo, TermChannel, TermChannelOpts, Transport } from '../src/transport';
import { toast } from '../src/ui';

// vi.mock хоистится над импортами самим vitest — порядок объявления не важен.
vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return { ...actual, toast: vi.fn() };
});

const toastMock = vi.mocked(toast);

const noopTermChannel: TermChannel = { write: () => {}, resize: () => {}, close: () => {} };

/** Transport-заглушка: list() либо отдаёт сессии, либо валится — управляется тестом. */
class ScriptedTransport implements Transport {
  readonly mode: 'lan' | 'relay';
  /** `false` — эмулирует relay-обрыв (транспорт знает, что не готов). `undefined` — как LAN. */
  isStreaming: boolean | undefined;
  private failing = false;

  constructor(mode: 'lan' | 'relay', isStreaming?: boolean) {
    this.mode = mode;
    this.isStreaming = isStreaming;
  }

  setFailing(v: boolean): void {
    this.failing = v;
  }

  list(): Promise<SessionInfo[]> {
    return this.failing ? Promise.reject(new Error('boom')) : Promise.resolve([]);
  }

  create(_req: CreateSessionInput): Promise<void> {
    return Promise.resolve();
  }

  kill(_name: string): Promise<void> {
    return Promise.resolve();
  }

  rename(_from: string, _to: string): Promise<void> {
    return Promise.resolve();
  }

  dirs(): Promise<DirGroup[]> {
    return Promise.resolve([]);
  }

  caffeinate(): Promise<CaffeinateState> {
    return Promise.resolve({ active: false, supported: false });
  }

  setCaffeinate(_active: boolean): Promise<CaffeinateState> {
    return Promise.resolve({ active: false, supported: false });
  }

  vapidKey(): Promise<string> {
    return Promise.resolve('');
  }

  subscribePush(_subscription: unknown): Promise<void> {
    return Promise.resolve();
  }

  filesList(_root: string, _subpath: string): Promise<FileEntry[]> {
    return Promise.resolve([]);
  }

  fileRead(_root: string, _subpath: string): Promise<FileContent> {
    return Promise.resolve({ kind: 'text', mime: 'text/plain', data: '', size: 0, truncated: false });
  }

  fileStat(_root: string, _subpath: string): Promise<FileStat> {
    return Promise.resolve({ size: 0, mime: 'application/octet-stream', kind: 'binary' });
  }

  downloadUrl(_root: string, _subpath: string): string | null {
    return null;
  }

  fileBlob(_root: string, _subpath: string): Promise<Blob> {
    return Promise.resolve(new Blob());
  }

  uploadFile(_root: string, _subpath: string, _file: File): Promise<void> {
    return Promise.resolve();
  }

  repo<T = unknown>(_action: string, _params: Record<string, unknown>): Promise<T> {
    return Promise.reject(new Error('repo not scripted'));
  }

  fileOp<T = unknown>(_action: string, _params: Record<string, unknown>): Promise<T> {
    return Promise.reject(new Error('fileOp not scripted'));
  }

  share(_scope?: DeviceScope): Promise<ShareInfo> {
    return Promise.resolve({ code: 'XXXX-YYYY-ZZZZ-WWWW', expiresAt: 0 });
  }

  devices(): Promise<DeviceInfo[]> {
    return Promise.resolve([]);
  }

  revoke(_fingerprint: string): Promise<void> {
    return Promise.resolve();
  }

  openTerm(_session: string, _opts: TermChannelOpts): TermChannel {
    return noopTermChannel;
  }

  close(): void {}
}

describe('mountDashboard — тост при недоступности relay', () => {
  let root: HTMLElement;
  let teardown: (() => void) | undefined;

  beforeEach(() => {
    setLang('ru');
    vi.useFakeTimers();
    root = document.createElement('div');
    toastMock.mockClear();
  });

  afterEach(() => {
    teardown?.();
    teardown = undefined;
    vi.useRealTimers();
  });

  it('не дублирует тост на каждый 3с-полл во время одного обрыва relay, но сигналит заново после следующего обрыва', async () => {
    const transport = new ScriptedTransport('relay', true);
    teardown = mountDashboard(root, transport);

    await vi.advanceTimersByTimeAsync(0); // первый refresh() из mount — успех, loadedOnce=true
    expect(toastMock).toHaveBeenCalledTimes(0);

    transport.isStreaming = false;
    transport.setFailing(true);
    await vi.advanceTimersByTimeAsync(3000); // полл #2: обрыв — один тост
    expect(toastMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000); // полл #3: тот же обрыв — подавлен
    await vi.advanceTimersByTimeAsync(3000); // полл #4: тот же обрыв — подавлен
    expect(toastMock).toHaveBeenCalledTimes(1);

    transport.isStreaming = true;
    transport.setFailing(false);
    await vi.advanceTimersByTimeAsync(3000); // полл #5: восстановились — успех, счётчик обрыва сброшен
    expect(toastMock).toHaveBeenCalledTimes(1);

    transport.isStreaming = false;
    transport.setFailing(true);
    await vi.advanceTimersByTimeAsync(3000); // полл #6: НОВЫЙ обрыв — свой тост
    expect(toastMock).toHaveBeenCalledTimes(2);
  });

  it('настоящую (не relay-обрыв) ошибку тостит на каждый неудачный полл — LAN-путь не сломан', async () => {
    const transport = new ScriptedTransport('lan', undefined); // isStreaming не объявлено, как у LanTransport
    teardown = mountDashboard(root, transport);

    await vi.advanceTimersByTimeAsync(0); // первый refresh — успех, loadedOnce=true
    expect(toastMock).toHaveBeenCalledTimes(0);

    transport.setFailing(true);
    await vi.advanceTimersByTimeAsync(3000); // полл #2: настоящая ошибка — тост
    await vi.advanceTimersByTimeAsync(3000); // полл #3: настоящая ошибка — тост (не подавляется)
    expect(toastMock).toHaveBeenCalledTimes(2);
  });
});
