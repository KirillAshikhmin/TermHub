import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  TMUX_CONF_LINES,
  missingTmuxLines,
  ZSH_MARKER,
  zshAliasBlock,
  hasZshMarker,
  shellRcFile,
  expandHome,
  parseSessionRoots,
  relativeRoots,
  warnCleartextHttp,
} from '../src/setup.js';
import { TMUX_SOCKET } from '../src/config.js';

describe('setup pure helpers', () => {
  it('missingTmuxLines returns all lines for an empty file', () => {
    expect(missingTmuxLines('')).toEqual(TMUX_CONF_LINES);
  });

  it('missingTmuxLines skips lines already present (ignoring surrounding whitespace)', () => {
    const existing = `  ${TMUX_CONF_LINES[0]}  \n# comment\n${TMUX_CONF_LINES[2]}\n`;
    expect(missingTmuxLines(existing)).toEqual(TMUX_CONF_LINES.filter((_, i) => i !== 0 && i !== 2));
  });

  it('TMUX_CONF_LINES пробрасывает заголовок наружу (set-titles)', () => {
    expect(TMUX_CONF_LINES).toContain('set -g set-titles on');
    expect(TMUX_CONF_LINES).toContain('set -g set-titles-string "#T"');
  });

  it('TMUX_CONF_LINES включает focus-events (focus-tracking в сессиях)', () => {
    expect(TMUX_CONF_LINES).toContain('set -g focus-events on');
  });

  it('TMUX_CONF_LINES: отзывчивость, цвет, эргономика, нумерация', () => {
    expect(TMUX_CONF_LINES).toContain('set -s escape-time 10');
    expect(TMUX_CONF_LINES).toContain('set -as terminal-features ",*:RGB"');
    expect(TMUX_CONF_LINES).toContain('set -g set-clipboard on');
    expect(TMUX_CONF_LINES).toContain('set -g status-position top');
    expect(TMUX_CONF_LINES).toContain('setw -g aggressive-resize on');
    expect(TMUX_CONF_LINES).toContain('set -g base-index 1');
    expect(TMUX_CONF_LINES).toContain('setw -g pane-base-index 1');
    expect(TMUX_CONF_LINES).toContain('set -g renumber-windows on');
  });

  it('TMUX_CONF_LINES: статус-бар перекрашен (не дефолтный зелёный)', () => {
    // Дефолтный status-style tmux — bg=green; перекрываем своим тёмным.
    expect(TMUX_CONF_LINES).toContain("set -g status-style 'bg=#2e3440 fg=#d8dee9'");
    expect(TMUX_CONF_LINES).toContain("set -g window-status-current-style 'bg=#4c566a fg=#eceff4 bold'");
    expect(TMUX_CONF_LINES).toContain("set -g message-style 'bg=#4c566a fg=#eceff4'");
  });

  it('missingTmuxLines returns empty when every line is present', () => {
    expect(missingTmuxLines(TMUX_CONF_LINES.join('\n'))).toEqual([]);
  });

  it('hasZshMarker detects the marker line', () => {
    expect(hasZshMarker('export FOO=1\n')).toBe(false);
    expect(hasZshMarker(`export FOO=1\n${ZSH_MARKER}\nalias tm='...'\n`)).toBe(true);
  });

  it('tml — функция выбора сессии: группировка, нумерация, ввод и переход в каталог', () => {
    const block = zshAliasBlock();
    // Функция, а не алиас: нужен ввод и cd, меняющий каталог вызывающего шелла.
    expect(block).toContain('tml() {');
    // Список запрашивается вместе с рабочим каталогом — по нему и группируем.
    expect(block).toContain('#{session_path}');
    expect(block).toContain('#{session_name}');
    // Текущий каталог получает нулевой ключ сортировки, то есть идёт первой группой.
    expect(block).toContain('(p == cur ? 0 : 1)');
    expect(block).toContain('(current)');
    // Заголовок панели — то же, что в заголовке вкладки веба.
    expect(block).toContain('#{pane_title}');
    // Звонок — из флага окна, тем же источником, что и у агента.
    expect(block).toContain('#{window_bell_flag}');
    expect(block).toContain('list-windows');
    // 🔔 в UTF-8 октальными кодами: awk на macOS не понимает \u-escape.
    expect(block).toContain('\\360\\237\\224\\224');
    // Заголовок, совпавший с именем (с точностью до индикатора), не дублируется.
    expect(block).toContain('rest == name');
    // Ввод номера и защита от нечислового ввода.
    expect(block).toContain('read -r _th_pick');
    expect(block).toContain('*[!0-9]*');
    // Сессия из другого каталога: сперва переход, затем восстановление через tm.
    expect(block).toContain('cd "$_th_dir"');
    expect(block).toContain('tm "$_th_name"');
    // Тот же выделенный сокет, что у агента.
    expect(block).toContain(`tmux -L ${TMUX_SOCKET} list-sessions`);
  });

  it('zshAliasBlock содержит маркер, функцию tm и алиас tml на выделенном сокете', () => {
    const block = zshAliasBlock();
    expect(block.includes(ZSH_MARKER)).toBe(true);
    // Функция, а не alias: имя из аргумента ($1) или из basename текущего каталога.
    expect(block.includes('tm() {')).toBe(true);
    expect(block.includes(`tmux -L ${TMUX_SOCKET} new -As "${'${1:-$(basename "$PWD")}'}"`)).toBe(true);
    // tml — на том же выделенном сокете, что и агент (подробности — в тесте выше).
    expect(block.includes(`tmux -L ${TMUX_SOCKET} list-sessions`)).toBe(true);
    expect(hasZshMarker(block)).toBe(true);
  });

  it('shellRcFile выбирает rc по шеллу: zsh → ~/.zshrc, bash/прочее → ~/.bashrc', () => {
    expect(shellRcFile('/bin/zsh', '/home/u')).toEqual({ path: '/home/u/.zshrc', label: '~/.zshrc' });
    expect(shellRcFile('/usr/bin/zsh', '/home/u')).toEqual({ path: '/home/u/.zshrc', label: '~/.zshrc' });
    expect(shellRcFile('/bin/bash', '/home/u')).toEqual({ path: '/home/u/.bashrc', label: '~/.bashrc' });
    // Неизвестный/пустой шелл → безопасный дефолт ~/.bashrc (наиболее совместимо на Linux).
    expect(shellRcFile('/usr/bin/fish', '/home/u').path).toBe('/home/u/.bashrc');
    expect(shellRcFile(undefined, '/home/u').path).toBe('/home/u/.bashrc');
  });

  it('expandHome expands a leading tilde', () => {
    expect(expandHome('~')).toBe(os.homedir());
    expect(expandHome('~/projects')).toBe(path.join(os.homedir(), 'projects'));
    expect(expandHome('/abs/path')).toBe('/abs/path');
    expect(expandHome('relative')).toBe('relative');
  });

  it('parseSessionRoots splits, trims, expands and falls back on empty input', () => {
    expect(parseSessionRoots('', '~/projects')).toEqual([path.join(os.homedir(), 'projects')]);
    expect(parseSessionRoots('  ~/a , /b/c ,', '~/projects')).toEqual([
      path.join(os.homedir(), 'a'),
      '/b/c',
    ]);
  });

  it('relativeRoots отфильтровывает не-абсолютные пути', () => {
    expect(relativeRoots(['/a', 'TermHub', '~x', '/b/c'])).toEqual(['TermHub', '~x']);
    expect(relativeRoots(parseSessionRoots('~/a, /b', '~/projects'))).toEqual([]);
  });

  it('warnCleartextHttp предупреждает про открытый HTTP на host:port', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnCleartextHttp('0.0.0.0', 7710);
      expect(spy).toHaveBeenCalledOnce();
      const msg = spy.mock.calls[0]![0] as string;
      expect(msg).toContain('0.0.0.0:7710');
      expect(msg).toContain('without encryption');
      expect(msg).toContain('cleartext');
    } finally {
      spy.mockRestore();
    }
  });
});
