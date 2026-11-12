// @vitest-environment happy-dom
// Отправленное, но ещё не подтверждённое сообщение стоит в переписке локальной записью
// и исчезает, когда в транскрипте появляется запись с тем же текстом.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { forgetCaps } from '../src/capabilities';
import { mountChat } from '../src/chat';
import { setLang, t } from '../src/i18n';
import type { FeedEntry, FeedPage, FeedResult, Transport } from '../src/transport';

function page(entries: FeedEntry[], over: Partial<FeedPage> = {}): FeedPage {
  return { ok: true, agent: 'claude', entries, head: 'h', tail: 'tl', bof: true, eof: true, complete: true, live: false, skipped: 0, ...over };
}
const human = (id: string, text: string): FeedEntry => ({ id, at: 1, kind: 'human', text, cursor: `1:${id}` });

let host: HTMLElement;
let answer: () => FeedResult;
const transport = {
  mode: 'lan',
  clientScope: null,
  capabilities: async () => ['feed', 'chat'],
  list: async () => [{ name: 'work', command: 'claude', path: '/root/a', title: '' }],
  dirs: async () => [],
  gradle: async () => null,
  feed: async () => answer(),
  live: async () => ({ ok: false, reason: 'no-agent', detail: '' }),
} as unknown as Transport;

beforeEach(() => {
  localStorage.clear();
  setLang('ru');
  forgetCaps();
  document.body.replaceChildren();
  host = document.createElement('div');
  document.body.append(host);
  answer = () => page([human('a', 'старое')]);
});
afterEach(() => document.body.replaceChildren());

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
};
const locals = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.th-feed__entry--local')];

describe('локальные записи переписки', () => {
  it('сообщение стоит в переписке с пометкой «отправляется»', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    chat.addLocal('сделай тесты');
    expect(locals()).toHaveLength(1);
    expect(locals()[0]!.textContent).toContain('сделай тесты');
    expect(locals()[0]!.querySelector('.th-feed__local-state')!.textContent).toBe(t('chat.local.sending'));
    chat.teardown();
  });

  it('«в очереди» и ошибка со своими пометками и кнопками', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    const msg = chat.addLocal('в очередь', 'queued');
    expect(locals()[0]!.querySelector('.th-feed__local-state')!.textContent).toBe(t('chat.local.queued'));
    let retried = 0;
    msg.set('failed', { note: 'причина', actions: [{ label: 'Ещё раз', run: () => (retried += 1) }] });
    expect(locals()[0]!.dataset.state).toBe('failed');
    expect(locals()[0]!.textContent).toContain('причина');
    locals()[0]!.querySelector<HTMLButtonElement>('button')!.click();
    expect(retried).toBe(1);
    chat.teardown();
  });

  it('запись транскрипта с тем же текстом заменяет локальную без дубля', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    chat.addLocal('сделай   тесты', 'queued');
    answer = () => page([human('b', 'сделай тесты')]);
    chat.refresh();
    await flush();
    expect(locals()).toHaveLength(0);
    const texts = [...host.querySelectorAll('.th-feed__entry--human')].map((e) => e.textContent);
    expect(texts).toEqual(['старое', 'сделай тесты']);
    chat.teardown();
  });

  it('чужая запись локальную не трогает; ошибочная не заменяется вовсе', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    chat.addLocal('первое', 'queued');
    const bad = chat.addLocal('второе');
    bad.set('failed');
    answer = () => page([human('c', 'совсем другое'), human('d', 'второе')]);
    chat.refresh();
    await flush();
    const left = locals().map((e) => e.dataset.state);
    expect(left).toEqual(['queued', 'failed']);
    chat.teardown();
  });

  it('remove снимает запись; set после снятия ничего не делает', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    const msg = chat.addLocal('x');
    msg.remove();
    msg.set('failed');
    expect(locals()).toHaveLength(0);
    chat.teardown();
  });

  it('доставленное, но записанное иначе (вложение стало «[Image]»), уходит по порядку', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    const msg = chat.addLocal('смотри /tmp/p.png');
    msg.set('sending', { delivered: true });
    answer = () => page([human('e', 'смотри [Image #1]')]);
    chat.refresh();
    await flush();
    expect(locals()).toHaveLength(0);
    chat.teardown();
  });

  it('«отправлено» — пометка без ожидания; запись транскрипта её заменяет', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    const msg = chat.addLocal('сделай тесты');
    msg.set('sent', { delivered: true });
    expect(locals()[0]!.dataset.state).toBe('sent');
    expect(locals()[0]!.querySelector('.th-feed__local-state')!.textContent).toBe(t('chat.local.sent'));
    answer = () => page([human('s', 'сделай тесты')]);
    chat.refresh();
    await flush();
    expect(locals()).toHaveLength(0);
    chat.teardown();
  });

  it('команда — приглушённая строка «команда отправлена: /имя», чужая реплика её не снимает', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    const msg = chat.addLocal('/usage');
    msg.set('command', { delivered: true });
    const row = locals()[0]!;
    expect(row.dataset.state).toBe('command');
    expect(row.classList.contains('is-command')).toBe(true);
    expect(row.textContent).toBe(t('chat.local.command', { name: '/usage' }));
    expect(row.textContent).toBe('команда отправлена: /usage');
    // Реплика, записанная иначе, по порядку снимает сообщения, но не строки команд.
    answer = () => page([human('n', 'совсем другое')]);
    chat.refresh();
    await flush();
    expect(locals().map((e) => e.dataset.state)).toEqual(['command']);
    chat.teardown();
  });

  it('две одинаковые команды подряд — одна строка; запись команды в транскрипте заменяет её', async () => {
    const chat = mountChat(host, 'work', transport);
    await flush();
    chat.addLocal('/model').set('command', { delivered: true });
    chat.addLocal('/model').set('command', { delivered: true });
    chat.addLocal('/usage').set('command', { delivered: true });
    expect(locals().map((e) => e.textContent)).toEqual(['команда отправлена: /model', 'команда отправлена: /usage']);
    answer = () => page([human('m', '/model')]);
    chat.refresh();
    await flush();
    expect(locals().map((e) => e.textContent)).toEqual(['команда отправлена: /usage']);
    chat.teardown();
  });
});
