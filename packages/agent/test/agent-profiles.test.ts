import type { AgentId } from '@termhub/protocol/chat';
import { describe, expect, it } from 'vitest';

import { isTested, profileOf } from '../src/agent-profiles.js';

// Ожидания — из замеров на живых агентах (docs/native-agent-ui.ru.md), не из кода.

describe('профиль Claude Code', () => {
  const profile = profileOf('claude');

  it('клавиши', () => {
    expect(profile.keys.submit).toBe('\r');
    expect(profile.keys.interrupt).toBe('\x1b');
    expect(profile.keys.modeCycle).toBe('\x1b[Z');
    expect(profile.keys.newline).toBe('\x1b\r');
    expect(profile.keys.clearInput).toEqual(['\x1b', '\x1b']);
  });

  it('режимы — в порядке, в каком их листает Shift+Tab', () => {
    expect(profile.modes.map((m) => m.id)).toEqual(['manual', 'accept', 'plan', 'auto']);
  });

  it('модели — из меню /model', () => {
    expect(profile.models.map((m) => m.label)).toEqual([
      'Opus 5.5',
      'Fable 5.2',
      'Sonnet 5.5',
      'Haiku 5.5',
    ]);
  });

  it('команды модели и сжатия', () => {
    expect(profile.commands).toEqual({ model: 'model', compact: 'compact' });
  });

  it('проверенная версия', () => {
    expect(profile.tested).toEqual({ min: '2.1.322', max: '2.1.322' });
  });

  it('список фоновых агентов под подвалом — данные профиля', () => {
    // Строки — с живого экрана: первой стоит «main», указатель «⏺» — на выбранной.
    const tray = profile.screen.tray!;
    expect(tray.head.test('  ⏺ main')).toBe(true);
    expect(tray.head.test('  ◯ main')).toBe(true);
    expect(tray.item.test('  ◯ general-purpose  Run the tests      2m 2s · ↓ 94.3k tokens')).toBe(true);
    expect(tray.head.test('  ◯ general-purpose  Run the tests')).toBe(false);
    expect(tray.item.test('  ⏵⏵ auto mode on · 1 shell · ← 2 agents · ↓ to manage')).toBe(false);
    expect(tray.item.test('  2. No')).toBe(false);
    expect(tray.max).toBeGreaterThanOrEqual(10);
    expect(profileOf('codex').screen.tray).toBeUndefined();
  });
});

describe('профиль Codex', () => {
  const profile = profileOf('codex');

  it('клавиши', () => {
    expect(profile.keys.submit).toBe('\r');
    expect(profile.keys.interrupt).toBe('\x1b');
    expect(profile.keys.modeCycle).toBe('\x1b[Z');
    expect(profile.keys.newline).toBe('\x1b\r');
    expect(profile.keys.clearInput).toEqual(['\x03']);
  });

  it('режимы', () => {
    expect(profile.modes.map((m) => m.id)).toEqual(['default', 'plan']);
  });

  it('модели — из меню /model', () => {
    expect(profile.models.map((m) => m.label)).toContain('GPT-6-Astra');
    expect(profile.models).toHaveLength(8);
  });

  it('команды модели и сжатия', () => {
    expect(profile.commands).toEqual({ model: 'model', compact: 'compact' });
  });

  it('проверенная версия', () => {
    expect(profile.tested).toEqual({ min: '0.167.0', max: '0.167.2' });
  });

  it('запрос работающему агенту: клавиша очереди и безопасное стирание строки — данные профиля', () => {
    // Замер таска 19 на Codex 0.167.2: Tab ставит набранное в очередь («tab to queue
    // message»), Enter отправляет сразу в идущий ход; Ctrl+U стирает строку ввода и
    // работу не трогает (Ctrl+C там — прерывание).
    expect(profile.keys.queue).toBe('\t');
    expect(profile.keys.clearBusy).toBe('\x15');
    // У Claude отправка работающему — та же клавиша; Ctrl+U стирает его строку так же
    // (замер таска 25 на Claude Code 2.1.322: работа не тронута).
    expect(profileOf('claude').keys.queue).toBeUndefined();
    expect(profileOf('claude').keys.clearBusy).toBe('\x15');
    // Возврат из очереди (замер таска 25): Codex — Shift+← возвращает последнее сообщение,
    // Claude — стрелка вверх возвращает всю очередь; что вернётся, называет профиль.
    expect(profile.keys.unqueue).toBe('\x1b[1;2D');
    expect(profile.screen.queue.edit?.scope).toBe('last');
    expect(profileOf('claude').keys.unqueue).toBe('\x1b[A');
    expect(profileOf('claude').screen.queue.edit?.scope).toBe('all');
    const footer = profile.screen.footer!;
    expect(footer.test('  tab to queue message')).toBe(true);
    expect(footer.test('  tab to queue message                               97% context left')).toBe(true);
    expect(footer.test('tab to queue message')).toBe(false);
    expect(footer.test('  press tab to queue message')).toBe(false);
    const waiting = profile.screen.status.exec(
      'Waiting for background terminal (1m 00s • esc to interrupt) · 1 background terminal running · /ps t…',
    );
    expect([waiting?.[1], waiting?.[2]]).toEqual(['Waiting for background terminal', '1m 00s']);
    expect(profile.screen.status.test('Waiting for background terminal')).toBe(false);
    // Подсказка очереди в подвале сама называет работу — строка работы бывает не видна.
    expect(profile.screen.working!.test('  tab to queue message')).toBe(true);
    expect(profile.screen.working!.test('GPT-6-Astra max · ~/work · Working  tab to queue message  97% context left')).toBe(true);
    expect(profile.screen.working!.test('GPT-6-Astra max · ~/work · Ready  ← for agents · ? for shortcuts')).toBe(false);
    // Списки подстановки: при них Tab и Enter вставляют выбранное (замер).
    expect(profile.screen.picker!.test('  enter/tab insert · esc close · ↑/↓ select · ←/→ filter')).toBe(true);
    expect(profile.screen.picker!.test('  enter select · esc back')).toBe(false);
    const mention = profile.screen.mention!;
    expect(mention.test('look at @READ')).toBe(true);
    expect(mention.test('@')).toBe(true);
    expect(mention.test('look at @README.md please')).toBe(false);
    expect(mention.test('mail user@example')).toBe(false);
    expect(profileOf('claude').screen.picker).toBeUndefined();
    expect(profileOf('claude').screen.mention).toBeUndefined();
  });

  it('ожидающий вопрос: два приглашения, у каждого своя клавиша', () => {
    // Ctrl+/ — побочная беседа; Shift+← — очередь отложенного ввода (CSI 1;2 D).
    expect(profile.keys.showPending).toBe('\x1f');
    expect(profile.keys.answerPending).toBe('\x1b[1;2D');
    const [side, queued] = profile.screen.pending!;
    expect(side!.key).toBe('showPending');
    expect(side!.footer!.test('Side from main thread · main needs input · ⌃/ to switch · ⌃c to close')).toBe(true);
    expect(side!.footer!.test('Side from main thread · main finished · ⌃/ to switch')).toBe(false);
    expect(side!.anyScreen).toBeUndefined();
    expect(queued!.key).toBe('answerPending');
    // В очереди бывает не только вопрос: после клавиши годится любой изменившийся экран.
    expect(queued!.anyScreen).toBe(true);
    const block = queued!.block!;
    expect(block.head.test('• Queued follow-up inputs')).toBe(true);
    expect(block.head.test('  • Queued follow-up inputs')).toBe(false);
    expect(block.count.exec('  ? 1 question')?.[1]).toBe('1');
    expect(block.count.exec('  ? 12 questions')?.[1]).toBe('12');
    expect(block.count.exec('  ? 1 question · 20s')?.[1]).toBe('1');
    expect(block.count.test('  ? 1 question about cats')).toBe(false);
    expect(block.count.test('  ↳ check the build log')).toBe(false);
    expect(block.hint.test('    ⇧← to answer')).toBe(true);
    expect(block.hint.test('    ⌥↑ to edit')).toBe(false);
    // Строка работы с припиской о фоновом терминале — та же строка работы.
    const status = profile.screen.status.exec(
      'Working (24s • esc to interrupt) · 1 background terminal running · /ps to view · /stop to close',
    );
    expect([status?.[1], status?.[2]]).toEqual(['Working', '24s']);
    // Вопрос, открытый из очереди: свой подвал, заголовок блока над ним, «Other» последним.
    const opened = profile.screen.dialogs.find((d) => d.under !== undefined)!;
    expect(opened.kind).toBe('question');
    expect(opened.under!.test('• Queued follow-up inputs')).toBe(true);
    expect(opened.footer!.test('enter submit   ⌃] skip   ⇧→ main prompt')).toBe(true);
    expect(opened.footer!.test('enter submit   ⌃] skip   ⇧→ main prompt   ⇧← next question')).toBe(true);
    expect(opened.footer!.test('enter submit   ⌃] skip   ⇧→ prev question')).toBe(true);
    expect(opened.footer!.test('enter to submit answer')).toBe(false);
    expect(opened.freeLast!.test('Other')).toBe(true);
    expect(opened.freeLast!.test('Other things')).toBe(false);
    expect(profileOf('claude').screen.pending).toBeUndefined();
    expect(profileOf('claude').keys.answerPending).toBeUndefined();
  });

  it('запрос разрешения на инструмент MCP — данные профиля: свой подвал и свой заголовок', () => {
    const hint = 'enter to submit | esc to cancel';
    const mcp = profile.screen.dialogs.filter((d) => d.footer?.test(hint));
    expect(mcp).toHaveLength(1);
    expect(mcp[0]!.kind).toBe('permission');
    // Замер на 0.167.2: цифра отвечает сама — признака «подтверждать клавишей отправки» в
    // профилях нет вовсе. Форма из нескольких полей («Field 1/3») этим запросом не считается.
    for (const agent of ['claude', 'codex'] as const) {
      expect(profileOf(agent).screen.dialogs.some((d) => 'confirm' in d)).toBe(false);
    }
    expect(mcp[0]!.notCounter?.test('Field 1/1')).toBe(false);
    expect(mcp[0]!.notCounter?.test('Field 1/1 (1 required unanswered)')).toBe(false);
    expect(mcp[0]!.notCounter?.test('Field 1/3')).toBe(true);
    expect(mcp[0]!.notCounter?.test('Field 2/2 (1 required unanswered)')).toBe(true);
    // Заголовок обязателен: без строки с вопросом диалог не узнаётся.
    expect(mcp[0]!.title?.test('Allow Docs Server to run "search_pages"?')).toBe(true);
    expect(mcp[0]!.title?.test('Allow Desk Helper to use "Notes"?')).toBe(true);
    expect(mcp[0]!.title?.test('Would you like to run the following command?')).toBe(false);
    expect(mcp[0]!.title?.test('Allow for this session')).toBe(false);
    // Подвалы прежних диалогов и подвал вопроса ему не подходят.
    expect(mcp[0]!.footer!.test('tab to add notes | enter to submit answer | esc to interrupt')).toBe(false);
    expect(mcp[0]!.footer!.test('Press enter to confirm or esc to cancel')).toBe(false);
    // Счётчик над вопросом в заголовок не входит.
    expect(profile.screen.chip.test('Field 1/1')).toBe(true);
    expect(profile.screen.chip.test('Question 1/1 (1 unanswered)')).toBe(true);
  });
});

describe.each<AgentId>(['claude', 'codex'])('профиль %s как данные', (agent) => {
  const profile = profileOf(agent);

  it('назван своим агентом', () => {
    expect(profile.agent).toBe(agent);
  });

  it('встроенные команды: имена без «/», без повторов, с подсказками', () => {
    const names = profile.builtins.map((c) => c.name);
    expect(names.length).toBeGreaterThan(20);
    expect(new Set(names).size).toBe(names.length);
    for (const command of profile.builtins) {
      expect(command.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(command.source).toBe('builtin');
      expect(command.hint).toBeTruthy();
    }
    expect(names).toContain(profile.commands.model);
    expect(names).toContain(profile.commands.compact);
    expect(names).toContain('clear');
  });

  it('id режимов и моделей не повторяются', () => {
    expect(new Set(profile.modes.map((m) => m.id)).size).toBe(profile.modes.length);
    expect(new Set(profile.models.map((m) => m.id)).size).toBe(profile.models.length);
  });
});

describe('isTested', () => {
  it('проверенная версия — да', () => {
    expect(isTested('claude', '2.1.322')).toBe(true);
    expect(isTested('codex', '0.167.0')).toBe(true);
    expect(isTested('codex', '0.167.2')).toBe(true);
  });

  it('версия новее проверенной — нет', () => {
    expect(isTested('claude', '2.1.323')).toBe(false);
    expect(isTested('claude', '2.2.0')).toBe(false);
    expect(isTested('claude', '3.0.0')).toBe(false);
    expect(isTested('codex', '0.167.3')).toBe(false);
    expect(isTested('codex', '0.168.0')).toBe(false);
  });

  it('версия старше проверенной — тоже нет: её экранов мы не видели', () => {
    expect(isTested('claude', '2.1.99')).toBe(false);
    expect(isTested('codex', '0.99.0')).toBe(false);
  });

  it('версии нет или она не разобралась — нет', () => {
    expect(isTested('claude', undefined)).toBe(false);
    expect(isTested('claude', '')).toBe(false);
    expect(isTested('claude', 'latest')).toBe(false);
  });

  it('сравнение числовое, а не строковое; хвост вроде «(Claude Code)» и «v» не мешает', () => {
    expect(isTested('claude', 'v2.1.322')).toBe(true);
    expect(isTested('claude', '2.1.322 (Claude Code)')).toBe(true);
    expect(isTested('codex', 'codex-cli 0.167.0')).toBe(true);
  });
});
