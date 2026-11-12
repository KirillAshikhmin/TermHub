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
    expect(profile.tested).toEqual({ min: '0.167.0', max: '0.167.0' });
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
  });

  it('версия новее проверенной — нет', () => {
    expect(isTested('claude', '2.1.323')).toBe(false);
    expect(isTested('claude', '2.2.0')).toBe(false);
    expect(isTested('claude', '3.0.0')).toBe(false);
    expect(isTested('codex', '0.167.2')).toBe(false);
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
