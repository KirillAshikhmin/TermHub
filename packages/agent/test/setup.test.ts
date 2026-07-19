import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  TMUX_CONF_LINES,
  missingTmuxLines,
  ZSH_MARKER,
  zshAliasBlock,
  hasZshMarker,
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

  it('zshAliasBlock содержит маркер, функцию tm и алиас tml на выделенном сокете', () => {
    const block = zshAliasBlock();
    expect(block.includes(ZSH_MARKER)).toBe(true);
    // Функция, а не alias: имя из аргумента ($1) или из basename текущего каталога.
    expect(block.includes('tm() {')).toBe(true);
    expect(block.includes(`tmux -L ${TMUX_SOCKET} new -As "${'${1:-$(basename "$PWD")}'}"`)).toBe(true);
    // tml — список сессий на том же выделенном сокете, что и агент.
    expect(block.includes(`alias tml='tmux -L ${TMUX_SOCKET} ls'`)).toBe(true);
    expect(hasZshMarker(block)).toBe(true);
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
