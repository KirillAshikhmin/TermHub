// Тест на генерацию plist LaunchAgent и на резолв путей. launchctl НЕ вызывается —
// это чистые функции (buildPlist, plistPath, logPath, binPath, parseStatus,
// isNotFoundError).

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  SERVICE_LABEL,
  buildPlist,
  binPath,
  plistPath,
  logPath,
  parseStatus,
  isNotFoundError,
  buildUnit,
  systemdUnitPath,
  parseSystemdStatus,
} from '../src/service.js';

const OPTS = {
  execPath: '/usr/local/bin/node',
  binPath: '/Users/alice/projects/TermHub/packages/agent/bin/termhub.js',
  logPath: '/Users/alice/Library/Logs/termhub.log',
  home: '/Users/alice',
  path: '/opt/homebrew/bin:/usr/bin:/bin',
  lang: 'ru_RU.UTF-8',
};

describe('buildPlist', () => {
  const xml = buildPlist(OPTS);

  it('starts with a valid XML doctype and plist root', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(xml).toContain('<plist version="1.0">');
  });

  it('contains the Label key with dev.termhub.agent', () => {
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain(`<string>${SERVICE_LABEL}</string>`);
  });

  it('lists ProgramArguments in order: execPath, binPath, "start"', () => {
    const argsBlock = xml.slice(xml.indexOf('<key>ProgramArguments</key>'), xml.indexOf('</array>'));
    const strings = [...argsBlock.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
    expect(strings).toEqual([OPTS.execPath, OPTS.binPath, 'start']);
  });

  it('sets RunAtLoad and KeepAlive to true', () => {
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\s*\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\s*\/>/);
  });

  it('points StandardOutPath and StandardErrorPath at the log file', () => {
    expect(xml).toContain(`<key>StandardOutPath</key>\n  <string>${OPTS.logPath}</string>`);
    expect(xml).toContain(`<key>StandardErrorPath</key>\n  <string>${OPTS.logPath}</string>`);
  });

  it('sets WorkingDirectory to the home directory', () => {
    expect(xml).toContain(`<key>WorkingDirectory</key>\n  <string>${OPTS.home}</string>`);
  });

  it('passes the install-time PATH to the agent via EnvironmentVariables (launchd stripped it before)', () => {
    const envBlock = xml.slice(xml.indexOf('<key>EnvironmentVariables</key>'));
    expect(envBlock).toContain('<key>PATH</key>');
    expect(envBlock).toContain(`<string>${OPTS.path}</string>`);
  });

  it('passes a UTF-8 LANG via EnvironmentVariables (без неё tmux портит табы в format-выводе)', () => {
    const envBlock = xml.slice(xml.indexOf('<key>EnvironmentVariables</key>'));
    expect(envBlock).toContain('<key>LANG</key>');
    expect(envBlock).toContain(`<string>${OPTS.lang}</string>`);
  });

  it('escapes XML special characters in path values', () => {
    const escaped = buildPlist({
      execPath: '/usr/bin/node',
      binPath: '/Users/a&b/<weird>/"bin"/termhub.js',
      logPath: '/tmp/log.log',
      home: '/Users/a&b',
      path: '/usr/bin:/bin',
      lang: 'en_US.UTF-8',
    });
    expect(escaped).toContain('/Users/a&amp;b/&lt;weird&gt;/&quot;bin&quot;/termhub.js');
    expect(escaped).not.toContain('<weird>');
    expect(escaped).toContain('/Users/a&amp;b</string>');
  });

  it('has no unclosed tags (balanced open/close counts for container tags)', () => {
    for (const tag of ['plist', 'dict', 'array', 'key', 'string']) {
      const opens = [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'g'))].length;
      const closes = [...xml.matchAll(new RegExp(`</${tag}>`, 'g'))].length;
      expect(closes).toBe(opens);
    }
    // Самозакрывающиеся <true/> — ровно по одному на RunAtLoad и KeepAlive.
    expect([...xml.matchAll(/<true\s*\/>/g)]).toHaveLength(2);
  });
});

describe('path helpers', () => {
  it('plistPath is absolute, under ~/Library/LaunchAgents, named after the label', () => {
    const p = plistPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`));
  });

  it('logPath is absolute, under ~/Library/Logs/termhub.log', () => {
    const p = logPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.homedir(), 'Library', 'Logs', 'termhub.log'));
  });

  it('binPath is absolute and resolves to bin/termhub.js next to the package root', () => {
    const p = binPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p.endsWith(path.join('agent', 'bin', 'termhub.js'))).toBe(true);
  });
});

describe('parseStatus', () => {
  it('reports not-installed when launchctl print exits non-zero', () => {
    expect(parseStatus(3, '')).toBe('not-installed');
    expect(parseStatus(113, 'Could not find service')).toBe('not-installed');
  });

  it('reports running when exit is 0 and output shows state = running', () => {
    expect(parseStatus(0, 'state = running\n')).toBe('running');
  });

  it('reports loaded (but not running) when exit is 0 without a running state', () => {
    expect(parseStatus(0, 'state = waiting\n')).toBe('loaded');
  });
});

describe('buildUnit (systemd --user)', () => {
  const U = {
    execPath: '/usr/bin/node',
    binPath: '/home/alice/TermHub/packages/agent/bin/termhub.js',
    home: '/home/alice',
    path: '/usr/local/bin:/usr/bin:/bin',
    lang: 'C.UTF-8',
  };
  const unit = buildUnit(U);

  it('has [Unit], [Service] and [Install] sections', () => {
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
  });

  it('ExecStart runs node + termhub.js start, unquoted (systemd 259 rejects quoted ExecStart)', () => {
    expect(unit).toContain(`ExecStart=${U.execPath} ${U.binPath} start`);
  });

  it('restarts on failure and is wanted by default.target', () => {
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('passes install-time PATH and a UTF-8 LANG via Environment, unquoted', () => {
    expect(unit).toContain(`Environment=PATH=${U.path}`);
    expect(unit).toContain(`Environment=LANG=${U.lang}`);
  });

  it('escapes the systemd specifier «%» in values', () => {
    const u = buildUnit({ ...U, home: '/home/a%b' });
    expect(u).toContain('WorkingDirectory=/home/a%%b');
  });

  it('quotes only values that actually need it (spaces)', () => {
    const u = buildUnit({ ...U, home: '/home/a b' });
    expect(u).toContain('WorkingDirectory="/home/a b"');
  });
});

describe('systemdUnitPath', () => {
  it('is absolute, under ~/.config/systemd/user, named after the label', () => {
    const p = systemdUnitPath();
    expect(path.isAbsolute(p)).toBe(true);
    expect(p).toBe(path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`));
  });
});

describe('parseSystemdStatus', () => {
  it('not-installed when the unit file is absent', () => {
    expect(parseSystemdStatus(false, 'inactive')).toBe('not-installed');
  });

  it('running when the unit exists and is-active reports active', () => {
    expect(parseSystemdStatus(true, 'active\n')).toBe('running');
  });

  it('loaded when the unit exists but is not active', () => {
    expect(parseSystemdStatus(true, 'inactive\n')).toBe('loaded');
    expect(parseSystemdStatus(true, 'failed\n')).toBe('loaded');
  });
});

describe('isNotFoundError', () => {
  // uninstallCommand использует эту функцию, чтобы решить, удалять ли plist:
  // «не найден» — не настоящая ошибка (нечего снимать), любая другая ошибка bootout
  // (например Operation not permitted) НЕ должна приводить к удалению plist.
  it('recognizes "no such process" as a not-found error', () => {
    expect(isNotFoundError('No such process')).toBe(true);
  });

  it('recognizes "could not find" as a not-found error', () => {
    expect(isNotFoundError('Could not find service "dev.termhub.agent" in domain for user')).toBe(true);
  });

  it('recognizes a lowercase "not found" as a not-found error', () => {
    expect(isNotFoundError('service not found')).toBe(true);
  });

  it('does not treat an unrelated failure (e.g. permissions) as not-found', () => {
    expect(isNotFoundError('Operation not permitted')).toBe(false);
    expect(isNotFoundError('')).toBe(false);
  });
});
