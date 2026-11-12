// @vitest-environment happy-dom
// Миниатюры картинок в чате: какие пути из текста считаются картинками, когда они
// запрашиваются (сообщение на экране), что остаётся текстом, окно просмотра и провод
// (LAN и relay). Транспорт подделан; IntersectionObserver подменён ручным.
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrame, frameJson, FrameType, jsonFrame } from '@termhub/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installRelayHarness, streaming } from './relay-harness';
import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { createChatImages, imagePathsIn } from '../src/chat-images';
import { mountFeed } from '../src/feed';
import { setLang, t } from '../src/i18n';
import { LanTransport } from '../src/transport';
import type { FeedEntry, FeedPage, Transport } from '../src/transport';

installRelayHarness();

/** Ручной IntersectionObserver: «сообщение попало на экран» говорит тест. */
class ManualObserver {
  static all: ManualObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly cb: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void) {
    ManualObserver.all.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  static show(el?: Element): void {
    for (const o of ManualObserver.all) {
      const hit = [...o.targets].filter((x) => !el || x === el);
      if (hit.length) o.cb(hit.map((target) => ({ target, isIntersecting: true })));
    }
  }
}

interface ImageFixture {
  transport: Transport;
  calls: string[];
}

function imageTransport(answer: (path: string) => Blob | Error, clientScope: unknown = null): ImageFixture {
  const calls: string[] = [];
  const transport = {
    mode: 'lan',
    clientScope,
    image: async (_session: string, path: string) => {
      calls.push(path);
      const res = answer(path);
      if (res instanceof Error) throw res;
      return res;
    },
  } as unknown as Transport;
  return { transport, calls };
}

const png = (): Blob => new Blob(['x'], { type: 'image/png' });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
};

let host: HTMLElement;
let created: string[];
let revoked: string[];
beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  document.body.replaceChildren();
  host = document.createElement('main');
  host.className = 'th-chat';
  document.body.append(host);
  ManualObserver.all = [];
  vi.stubGlobal('IntersectionObserver', ManualObserver);
  created = [];
  revoked = [];
  let n = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:test/${++n}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => void revoked.push(url));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function message(text: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'th-feed__entry';
  const body = document.createElement('div');
  body.className = 'th-feed__text';
  body.textContent = text;
  box.append(body);
  host.append(box);
  return box;
}

describe('imagePathsIn — какие пути считаются картинками', () => {
  it('берёт абсолютные пути с расширением растра, без повторов и прилипшей пунктуации', () => {
    const text =
      'Снимки: /tmp/a/shot-1.png, /Users/me/.termhub/paste/paste-1.JPG и (/tmp/a/b.webp). Ещё раз /tmp/a/shot-1.png; анимация /tmp/x.gif, фото /tmp/y.jpeg.';
    expect(imagePathsIn(text)).toEqual([
      '/tmp/a/shot-1.png',
      '/Users/me/.termhub/paste/paste-1.JPG',
      '/tmp/a/b.webp',
      '/tmp/x.gif',
      '/tmp/y.jpeg',
    ]);
  });

  it('не берёт SVG, не картинки, относительные пути, пути от ~ и хвосты ссылок', () => {
    const text =
      'Вектор /tmp/a.svg, код /tmp/a.ts, рядом docs/shot.png и ./shot.png, дома ~/pics/a.png, сайт https://example.com/img/a.png, архив /tmp/a.png.zip';
    expect(imagePathsIn(text)).toEqual([]);
  });

  it('больше дюжины картинок из одного сообщения не берёт', () => {
    const text = Array.from({ length: 20 }, (_, i) => `/tmp/s/${i}.png`).join(' ');
    expect(imagePathsIn(text)).toHaveLength(12);
  });
});

describe('createChatImages — миниатюры под сообщением', () => {
  it('картинка запрашивается, только когда сообщение попало на экран; путь в тексте остаётся', async () => {
    const { transport, calls } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const box = message('Готово: /tmp/a/shot.png');
    images.attach(box, 'Готово: /tmp/a/shot.png');
    await flush();
    expect(calls).toEqual([]);
    expect(box.querySelector('.th-chatimgs')).toBeNull();

    ManualObserver.show(box);
    await flush();
    expect(calls).toEqual(['/tmp/a/shot.png']);
    const img = box.querySelector<HTMLImageElement>('.th-chatimgs .th-chatimg img')!;
    expect(img.getAttribute('src')).toBe('blob:test/1');
    expect(img.alt).toBe('shot.png');
    expect(box.querySelector('.th-feed__text')!.textContent).toBe('Готово: /tmp/a/shot.png');
    // Ряд стоит под текстом сообщения.
    expect(box.lastElementChild!.classList.contains('th-chatimgs')).toBe(true);
    images.teardown();
  });

  it('несколько картинок — один ряд в порядке текста', async () => {
    const { transport } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const text = 'a /tmp/1.png b /tmp/2.jpg c /tmp/3.gif';
    const box = message(text);
    images.attach(box, text);
    ManualObserver.show(box);
    await flush();
    expect(box.querySelectorAll('.th-chatimgs')).toHaveLength(1);
    expect([...box.querySelectorAll<HTMLImageElement>('.th-chatimg img')].map((i) => i.alt)).toEqual(['1.png', '2.jpg', '3.gif']);
    images.teardown();
  });

  it('отказ агента оставляет текст как есть, и тот же путь второй раз не запрашивается', async () => {
    const { transport, calls } = imageTransport((p) => (p.endsWith('bad.png') ? new Error('Path outside allowed directories') : png()));
    const images = createChatImages(host, 'work', transport);
    const first = message('см. /etc/bad.png');
    images.attach(first, 'см. /etc/bad.png');
    ManualObserver.show(first);
    await flush();
    expect(first.querySelector('.th-chatimgs')).toBeNull();
    expect(first.textContent).toBe('см. /etc/bad.png');

    const second = message('снова /etc/bad.png и /tmp/ok.png');
    images.attach(second, 'снова /etc/bad.png и /tmp/ok.png');
    ManualObserver.show(second);
    await flush();
    expect(calls).toEqual(['/etc/bad.png', '/tmp/ok.png']);
    expect(second.querySelectorAll('.th-chatimg')).toHaveLength(1);
    images.teardown();
  });

  it('сетевой сбой отказом не запоминается: при возврате связи миниатюра запрашивается снова', async () => {
    let down = true;
    const net = Object.assign(new Error('network error'), { status: 0 });
    const { transport, calls } = imageTransport((p) => (down ? net : p.endsWith('bad.png') ? new Error('image unavailable') : png()));
    const images = createChatImages(host, 'work', transport);
    const box = message('см. /tmp/a.png и /tmp/bad.png');
    images.attach(box, 'см. /tmp/a.png и /tmp/bad.png');
    ManualObserver.show(box);
    await flush();
    expect(box.querySelector('.th-chatimg')).toBeNull();
    expect(calls).toEqual(['/tmp/a.png', '/tmp/bad.png']);

    // Связь вернулась: оба пути спрашиваются заново; отказ агента теперь запоминается.
    down = false;
    images.retry();
    await flush();
    expect(calls).toEqual(['/tmp/a.png', '/tmp/bad.png', '/tmp/a.png', '/tmp/bad.png']);
    expect([...box.querySelectorAll<HTMLImageElement>('.th-chatimg img')].map((i) => i.alt)).toEqual(['a.png']);
    images.retry();
    await flush();
    expect(calls).toHaveLength(4);
    // То же через relay: обрыв потока и срок ответа — тоже сбой связи, а не отказ.
    const relay = imageTransport(() => new Error('relay not streaming'));
    const images2 = createChatImages(host, 'work', relay.transport);
    const box2 = message('/tmp/b.png');
    images2.attach(box2, '/tmp/b.png');
    ManualObserver.show(box2);
    await flush();
    images2.retry();
    await flush();
    expect(relay.calls).toEqual(['/tmp/b.png', '/tmp/b.png']);
    images.teardown();
    images2.teardown();
  });

  it('ответ не того типа (SVG, документ) картинкой не становится', async () => {
    const { transport } = imageTransport((p) => new Blob(['<svg/>'], { type: p.endsWith('1.png') ? 'image/svg+xml' : 'text/html' }));
    const images = createChatImages(host, 'work', transport);
    const box = message('/tmp/1.png /tmp/2.png');
    images.attach(box, '/tmp/1.png /tmp/2.png');
    ManualObserver.show(box);
    await flush();
    expect(box.querySelector('.th-chatimgs')).toBeNull();
    expect(created).toEqual([]);
    images.teardown();
  });

  it('одна и та же картинка в двух сообщениях грузится один раз', async () => {
    const { transport, calls } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const a = message('/tmp/same.png');
    const b = message('/tmp/same.png');
    images.attach(a, '/tmp/same.png');
    images.attach(b, '/tmp/same.png');
    ManualObserver.show();
    await flush();
    expect(calls).toEqual(['/tmp/same.png']);
    expect(document.querySelectorAll('.th-chatimg')).toHaveLength(2);
    images.teardown();
  });

  it('гостю без права files миниатюр нет и запросов нет', async () => {
    const { transport, calls } = imageTransport(png, { session: 'work', write: true, files: false });
    const images = createChatImages(host, 'work', transport);
    const box = message('/tmp/a.png');
    images.attach(box, '/tmp/a.png');
    ManualObserver.show();
    await flush();
    expect(calls).toEqual([]);
    expect(ManualObserver.all.every((o) => o.targets.size === 0)).toBe(true);
    expect(box.querySelector('.th-chatimgs')).toBeNull();
    images.teardown();
  });

  it('путь из сообщения — данные: разметка в нём не исполняется', async () => {
    const { transport } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const text = '/tmp/a.png <img src=x onerror=alert(1)>';
    const box = message(text);
    images.attach(box, text);
    ManualObserver.show(box);
    await flush();
    expect(box.querySelectorAll('img')).toHaveLength(1);
    expect(box.querySelector('img')!.getAttribute('src')).toBe('blob:test/1');
    images.teardown();
  });

  it('снятие освобождает адреса картинок и закрывает окно', async () => {
    const { transport } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const box = message('/tmp/1.png /tmp/2.png');
    images.attach(box, '/tmp/1.png /tmp/2.png');
    ManualObserver.show(box);
    await flush();
    box.querySelector<HTMLElement>('.th-chatimg')!.click();
    expect(host.querySelector('.th-imgview')).not.toBeNull();
    images.teardown();
    expect(revoked.sort()).toEqual(['blob:test/1', 'blob:test/2']);
    expect(host.querySelector('.th-imgview')).toBeNull();
  });
});

describe('окно просмотра', () => {
  async function opened(): Promise<{ box: HTMLElement; thumb: HTMLElement; teardown: () => void }> {
    const { transport } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const box = message('/tmp/a/shot.png');
    images.attach(box, '/tmp/a/shot.png');
    ManualObserver.show(box);
    await flush();
    const thumb = box.querySelector<HTMLElement>('.th-chatimg')!;
    thumb.click();
    return { box, thumb, teardown: () => images.teardown() };
  }

  it('клик по миниатюре открывает картинку окном внутри области чата', async () => {
    const { thumb, teardown } = await opened();
    expect(thumb.getAttribute('aria-label')).toBe(t('chat.image.open'));
    const view = host.querySelector<HTMLElement>(':scope > .th-imgview')!;
    expect(view.getAttribute('role')).toBe('dialog');
    expect(view.querySelector<HTMLImageElement>('.th-imgview__img')!.getAttribute('src')).toBe('blob:test/1');
    expect(view.querySelector('.th-imgview__title')!.textContent).toBe('shot.png');
    expect(view.querySelector('.th-imgview__close')!.getAttribute('aria-label')).toBe(t('chat.image.close'));
    teardown();
  });

  it('закрывается кнопкой', async () => {
    const { teardown } = await opened();
    host.querySelector<HTMLElement>('.th-imgview__close')!.click();
    expect(host.querySelector('.th-imgview')).toBeNull();
    teardown();
  });

  it('закрывается по Esc, и клавиша дальше не идёт; после закрытия Esc снова свободен', async () => {
    const { teardown } = await opened();
    const seen: string[] = [];
    const listener = (e: KeyboardEvent): void => void seen.push(e.key);
    document.body.addEventListener('keydown', listener);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(host.querySelector('.th-imgview')).toBeNull();
    expect(seen).toEqual([]);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(seen).toEqual(['Escape']);
    document.body.removeEventListener('keydown', listener);
    teardown();
  });

  it('вторая миниатюра заменяет картинку в том же окне', async () => {
    const { transport } = imageTransport(png);
    const images = createChatImages(host, 'work', transport);
    const box = message('/tmp/1.png /tmp/2.png');
    images.attach(box, '/tmp/1.png /tmp/2.png');
    ManualObserver.show(box);
    await flush();
    const thumbs = box.querySelectorAll<HTMLElement>('.th-chatimg');
    thumbs[0]!.click();
    thumbs[1]!.click();
    expect(host.querySelectorAll('.th-imgview')).toHaveLength(1);
    expect(host.querySelector('.th-imgview__title')!.textContent).toBe('2.png');
    images.teardown();
  });
});

describe('стили', () => {
  const css = fs.readFileSync(nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), '../src/theme.css'), 'utf8');

  it('окно просмотра лежит в границах области чата, картинка вписана в него', () => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    const view = document.createElement('div');
    view.className = 'th-imgview';
    const img = document.createElement('img');
    img.className = 'th-imgview__img';
    view.append(img);
    host.append(view);
    expect(getComputedStyle(host).position).toBe('relative');
    expect(getComputedStyle(view).position).toBe('absolute');
    expect(getComputedStyle(img).maxWidth).toBe('100%');
    expect(getComputedStyle(img).maxHeight).toBe('100%');
    expect(getComputedStyle(img).objectFit).toBe('contain');
    style.remove();
  });
});

describe('в переписке', () => {
  function page(entries: FeedEntry[]): FeedPage {
    return { ok: true, agent: 'claude', entries, head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0 };
  }
  const ENTRIES: FeedEntry[] = [
    { id: 'h', at: 1, kind: 'human', text: 'посмотри /root/a/in.png', cursor: '1:0' },
    { id: 'a', at: 2, kind: 'agent', text: 'Снимок: `/tmp/out/shot.png`', cursor: '1:10' },
    { id: 't', at: 3, kind: 'tool', tool: 'Read', text: 'Read /tmp/out/tool.png', cursor: '1:20' },
  ];
  function chatTransport(calls: string[]): Transport {
    return {
      mode: 'lan',
      clientScope: null,
      capabilities: async () => ['feed', 'chat'],
      gradle: async () => null,
      list: async () => [{ name: 'work', command: 'claude', path: '/root/a', title: '' }],
      dirs: async () => [{ root: '/root/a', dirs: [] }],
      feed: async () => page(ENTRIES),
      live: async () => ({ ok: false, reason: 'no-agent', detail: '' }),
      commands: async () => ({ ok: false, reason: 'no-agent', detail: '' }),
      image: async (_s: string, path: string) => {
        calls.push(path);
        return png();
      },
    } as unknown as Transport;
  }

  it('чат: миниатюры под сообщениями человека и агента; строка действия без миниатюры', async () => {
    const calls: string[] = [];
    const mount = document.createElement('div');
    document.body.append(mount);
    const chat = mountChat(mount, 'work', chatTransport(calls));
    await flush();
    ManualObserver.show();
    await flush();
    expect(calls).toEqual(['/root/a/in.png', '/tmp/out/shot.png']);
    expect(mount.querySelectorAll('.th-feed__entry--human .th-chatimg')).toHaveLength(1);
    expect(mount.querySelectorAll('.th-feed__entry--agent .th-chatimg')).toHaveLength(1);
    expect(mount.querySelector('.th-feed__entry--tool .th-chatimg')).toBeNull();
    // Окно открывается внутри области чата.
    mount.querySelector<HTMLElement>('.th-chatimg')!.click();
    expect(mount.querySelector('.th-chat > .th-imgview')).not.toBeNull();
    chat.teardown();
    expect(revoked).toHaveLength(2);
  });

  it('сообщение, отправленное из чата, тоже получает миниатюру', async () => {
    const calls: string[] = [];
    const mount = document.createElement('div');
    document.body.append(mount);
    const chat = mountChat(mount, 'work', chatTransport(calls));
    await flush();
    chat.feed.addLocal('вот /root/a/new.png');
    ManualObserver.show();
    await flush();
    expect(calls).toContain('/root/a/new.png');
    expect(mount.querySelectorAll('.th-feed__entry--local .th-chatimg')).toHaveLength(1);
    chat.teardown();
  });

  it('лента без чата не меняется: картинок не просит', async () => {
    const calls: string[] = [];
    const mount = document.createElement('div');
    document.body.append(mount);
    const feed = mountFeed(mount, 'work', chatTransport(calls));
    await flush();
    ManualObserver.show();
    await flush();
    expect(calls).toEqual([]);
    expect(mount.querySelector('.th-chatimgs')).toBeNull();
    feed.teardown();
  });
});

describe('провод', () => {
  it('LAN: GET /api/files/image с сессией и путём; ответ — Blob', async () => {
    const calls: string[] = [];
    const blob = png();
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url);
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(blob) } as unknown as Response);
    });
    await expect(new LanTransport().image('my work', '/tmp/a b/shot.png')).resolves.toBe(blob);
    expect(calls).toEqual([`/api/files/image?session=my%20work&path=${encodeURIComponent('/tmp/a b/shot.png')}`]);
  });

  it('LAN: отказ агента — исключение, а не пустая картинка', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({ ok: false, status: 400, statusText: 'Bad Request', json: () => Promise.resolve({ error: 'Not an image' }) } as unknown as Response),
    );
    await expect(new LanTransport().image('work', '/tmp/a.png')).rejects.toThrow('Not an image');
  });

  it('relay: действие image кадра FileOp, куски собираются в Blob названного агентом типа', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.image('work', '/tmp/a/shot.png');
    const sent = decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array));
    expect(sent.type).toBe(FrameType.FileOp);
    const first = frameJson<Record<string, unknown>>(sent);
    expect(first).toMatchObject({ action: 'image', session: 'work', path: '/tmp/a/shot.png', offset: 0, len: 262144 });
    const reply = (id: unknown, data: string, eof: boolean): void =>
      ws.deliverBinary(
        agentEnc.push(jsonFrame(FrameType.FileOpResult, 0, { id, result: { mime: 'image/png', size: 5, data: btoa(data), eof } })),
      );
    reply(first.id, 'abc', false);
    await flush();
    const second = frameJson<Record<string, unknown>>(decodeFrame(agentDec.pull(ws.sent[firstEncrypted + 1] as Uint8Array)));
    expect(second).toMatchObject({ action: 'image', path: '/tmp/a/shot.png', offset: 3 });
    reply(second.id, 'de', true);
    const blob = await p;
    expect(blob.type).toBe('image/png');
    expect(await blob.text()).toBe('abcde');
  });

  it('relay: отказ агента (нет права, чужой путь) — исключение', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.image('work', '/etc/x.png');
    const req = frameJson<{ id: number }>(decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array)));
    ws.deliverBinary(agentEnc.push(jsonFrame(FrameType.FileOpResult, 0, { id: req.id, error: 'no files permission' })));
    await expect(p).rejects.toThrow('no files permission');
  });

  it('relay: агент, заявивший больше 20 МиБ или отдающий без конца, обрывается', async () => {
    const { transport, ws, agentEnc, agentDec, firstEncrypted } = streaming();
    const p = transport.image('work', '/tmp/huge.png');
    const req = frameJson<{ id: number }>(decodeFrame(agentDec.pull(ws.sent[firstEncrypted] as Uint8Array)));
    ws.deliverBinary(
      agentEnc.push(
        jsonFrame(FrameType.FileOpResult, 0, { id: req.id, result: { mime: 'image/png', size: 20 * 1024 * 1024 + 1, data: btoa('x'), eof: false } }),
      ),
    );
    await expect(p).rejects.toThrow('image is too large');
  });
});
