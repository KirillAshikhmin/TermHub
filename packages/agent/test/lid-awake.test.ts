// Режим «не спать при закрытой крышке»: команды подменены, настоящий pmset и sudo не зовутся.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Caffeinate } from '../src/caffeinate.js';
import { allowsWithoutPassword, LidAwake, parseClamshell, sudoersInstallCommand, sudoersRule, type RunCommand } from '../src/lid-awake.js';

const RULE_CMDS = '/usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1';

let dir: string;
let marker: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-lid-'));
  marker = path.join(dir, 'lid-awake.on');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Подставной мир: есть ли разрешение sudoers и закрыта ли крышка; журнал вызовов. */
function world(init: { allowed?: boolean; closed?: boolean } = {}) {
  const w = { allowed: init.allowed ?? true, closed: init.closed ?? false, calls: [] as string[] };
  const run: RunCommand = async (cmd, args) => {
    const line = `${cmd} ${args.join(' ')}`;
    w.calls.push(line);
    if (cmd === 'ioreg') return { code: 0, stdout: `  |   "AppleClamshellState" = ${w.closed ? 'Yes' : 'No'}\n` };
    // Список правил: у владельца-админа он есть всегда, разрешение — отдельной строкой.
    if (args.join(' ') === '-n -l')
      return { code: 0, stdout: `    (ALL) ALL\n${w.allowed ? `    (root) NOPASSWD: ${RULE_CMDS}\n` : ''}` };
    return { code: w.allowed ? 0 : 1, stdout: '' };
  };
  const lid = new LidAwake({ platform: 'darwin', run, markerFile: marker, pollMs: 1_000_000, log: () => {} });
  return { w, lid };
}

describe('LidAwake', () => {
  it('правило sudoers разрешает ровно две команды pmset и ничего шире', () => {
    expect(sudoersRule('kirill')).toBe(
      'kirill ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1',
    );
    expect(sudoersInstallCommand('kirill')).toContain('sudo visudo -cf /etc/sudoers.d/termhub-lidawake');
  });

  it('включение и выключение идут через sudo -n pmset, метка на диске живёт вместе с режимом', async () => {
    const { w, lid } = world();
    expect(await lid.set(true)).toBe(true);
    expect(w.calls).toContain('sudo -n /usr/bin/pmset -a disablesleep 1');
    expect(fs.existsSync(marker)).toBe(true);
    expect(lid.state()).toMatchObject({ lidSupported: true, lidReady: true, lid: true });
    expect(await lid.set(false)).toBe(true);
    expect(w.calls).toContain('sudo -n /usr/bin/pmset -a disablesleep 0');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('без разрешения sudoers режим не включается и настройку не трогает', async () => {
    const { w, lid } = world({ allowed: false });
    expect(await lid.set(true)).toBe(false);
    expect(lid.state()).toMatchObject({ lidSupported: true, lidReady: false, lid: false });
    expect(w.calls.some((c) => c.startsWith('sudo -n /usr/bin/pmset'))).toBe(false);
  });

  it('снимается сам, когда крышку закрыли и снова открыли; открытая с самого начала — ждёт', async () => {
    const { w, lid } = world({ closed: false });
    await lid.set(true);
    await lid.checkLid(); // крышка ещё открыта: режим включили перед тем, как закрыть
    expect(lid.state().lid).toBe(true);
    w.closed = true;
    await lid.checkLid();
    expect(lid.state().lid).toBe(true);
    w.closed = false;
    await lid.checkLid();
    expect(lid.state().lid).toBe(false);
    expect(w.calls.at(-1)).toBe('sudo -n /usr/bin/pmset -a disablesleep 0');
  });

  it('после падения агента оставшаяся включённой настройка возвращается на старте', async () => {
    fs.writeFileSync(marker, '');
    const { w, lid } = world();
    await lid.recover();
    expect(w.calls).toEqual(['sudo -n /usr/bin/pmset -a disablesleep 0']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('остановка агента возвращает сон', async () => {
    const { w, lid } = world();
    await lid.set(true);
    lid.release();
    expect(lid.state().lid).toBe(false);
    expect(w.calls.at(-1)).toBe('sudo -n /usr/bin/pmset -a disablesleep 0');
  });

  it('не macOS — режима нет вовсе, команд не зовёт', async () => {
    const calls: string[] = [];
    const lid = new LidAwake({ platform: 'linux', run: async (c) => (calls.push(c), { code: 0, stdout: '' }), markerFile: marker });
    expect(await lid.set(true)).toBe(false);
    expect(lid.state()).toEqual({ lidSupported: false, lidReady: false, lid: false });
    expect(calls).toEqual([]);
  });

  it('разрешение читается по списку правил: нужны обе команды без пароля, чужое правило не в счёт', () => {
    expect(allowsWithoutPassword(`    (ALL) ALL\n    (root) NOPASSWD: ${RULE_CMDS}\n`)).toBe(true);
    expect(allowsWithoutPassword('    (ALL) NOPASSWD: ALL\n')).toBe(true);
    // Без терминала sudo переносит правило на 80-й колонке — так оно и приходит агенту.
    expect(
      allowsWithoutPassword(
        '    (ALL) ALL\n    (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a\n        disablesleep 1\n',
      ),
    ).toBe(true);
    // Наше правило не должно «дотянуться» до команд следующей записи.
    expect(
      allowsWithoutPassword('    (root) NOPASSWD: /usr/bin/pmset -a disablesleep 0\n    (root) /usr/bin/pmset -a disablesleep 1\n'),
    ).toBe(false);
    // Обычный админ: всё можно, но с паролем.
    expect(allowsWithoutPassword('    (ALL) ALL\n')).toBe(false);
    // Чужое правило без пароля — не наше разрешение.
    expect(allowsWithoutPassword('    (ALL) ALL\n    (root) NOPASSWD: /usr/bin/true\n')).toBe(false);
    // Только одна из двух команд — выключить режим было бы нечем.
    expect(allowsWithoutPassword('    (root) NOPASSWD: /usr/bin/pmset -a disablesleep 1\n')).toBe(false);
  });

  it('состояние крышки читается из ioreg; незнакомый вывод — «не узнать»', () => {
    expect(parseClamshell('  "AppleClamshellState" = Yes')).toBe(true);
    expect(parseClamshell('  "AppleClamshellState" = No')).toBe(false);
    expect(parseClamshell('nothing here')).toBeUndefined();
  });

  it('контроллер сна отдаёт режим крышки рядом с обычным удержанием и принимает запрос {lid}', async () => {
    const { lid } = world();
    const proc = { on: () => {}, kill: () => {} };
    const caffeinate = new Caffeinate({ spawn: () => proc, supported: true, lid });
    await caffeinate.apply({ lid: true });
    expect(caffeinate.state()).toMatchObject({ active: false, supported: true, lid: true, lidSupported: true });
    await caffeinate.apply({ active: true, lid: 'yes' }); // не булево — поля нет
    expect(caffeinate.state()).toMatchObject({ active: true, lid: true });
    // Без режима крышки его полей в состоянии нет вовсе.
    expect(new Caffeinate({ spawn: () => proc, supported: true }).state()).toEqual({ active: false, supported: true });
  });
});
