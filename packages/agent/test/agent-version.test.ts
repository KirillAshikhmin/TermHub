// Версия агента — версия программы, запущенной в панели, а не той, которой беседа была
// создана. Источники подменены: таблица процессов, панели и исполняемый файл процесса.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentInfo, clearVersionCache, versionFromPath } from '../src/agent-live.js';
import { clearCache, type ProcessRow, type TranscriptSources } from '../src/agent-transcript.js';

const PANE = 'work:@1.%1';
const STARTED = new Date(2026, 10, 12, 9, 0, 0);
const CASK = '/opt/homebrew/Caskroom/codex/0.167.0.upgrading/bin/codex';

let dir: string;
let rollout: string;

beforeEach(() => {
  clearCache();
  clearVersionCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-version-'));
  rollout = path.join(dir, 'rollout.jsonl');
  // Поток создан версией 0.161.0 — так и было у владельца.
  fs.writeFileSync(
    rollout,
    [
      '{"type":"session_meta","payload":{"id":"t1","cli_version":"0.161.0"}}',
      '{"type":"turn_context","payload":{"model":"gpt-9-unknown"}}',
      '',
    ].join('\n'),
  );
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

interface World {
  sources: Partial<TranscriptSources>;
  asked: number[];
  rows: ProcessRow[];
}

/** Оболочка панели (pid 100) и клиент Codex в ней (pid 200). */
function world(executable: string | undefined | (() => never), args = 'codex'): World {
  const w: World = {
    asked: [],
    rows: [
      { pid: 100, ppid: 1, startedAt: STARTED, args: '-zsh' },
      { pid: 200, ppid: 100, startedAt: STARTED, args },
      { pid: 300, ppid: 1, startedAt: STARTED, args: '/x/releases/0.161.0-aarch64-apple-darwin/bin/codex app-server' },
    ],
    sources: {},
  };
  w.sources = {
    home: dir,
    panePids: async () => new Map([[PANE, 100]]),
    processTable: async () => w.rows,
    executable: async (pid) => {
      w.asked.push(pid);
      return typeof executable === 'function' ? executable() : executable;
    },
  };
  return w;
}

describe('versionFromPath — версия в пути исполняемого файла', () => {
  it('сегмент версии после каталога codex; хвост обновления отбрасывается', () => {
    expect(versionFromPath(CASK)).toBe('0.167.0');
    expect(versionFromPath('/opt/homebrew/Cellar/codex/0.167.2/bin/codex')).toBe('0.167.2');
    expect(versionFromPath('/home/u/.codex/packages/standalone/releases/0.170.1-x86_64-unknown-linux-musl/bin/codex')).toBe(
      '0.170.1',
    );
  });

  it('версия node в пути — не версия Codex; чужая программа версии не называет', () => {
    expect(
      versionFromPath('/Users/u/.volta/tools/image/node/22.3.0/lib/node_modules/@openai/codex/vendor/codex/codex'),
    ).toBeUndefined();
    expect(versionFromPath('/opt/homebrew/Cellar/node/22.3.0/bin/node')).toBeUndefined();
    expect(versionFromPath('/usr/local/bin/codex')).toBeUndefined();
  });
});

describe('agentInfo — версия запущенного Codex', () => {
  it('берётся по исполняемому файлу процесса панели, а не из первой строки беседы', async () => {
    const w = world(CASK);
    expect(await agentInfo('codex', rollout, 'codex', { pane: PANE, sources: w.sources })).toEqual({
      version: '0.167.0',
      model: 'gpt-9-unknown',
      source: 'process',
    });
    // Спрошен клиент в панели, а не её оболочка и не демон.
    expect(w.asked).toEqual([200]);
  });

  it('беседы на диске ещё нет — версия программы всё равно названа', async () => {
    const w = world(CASK);
    expect(await agentInfo('codex', undefined, 'codex', { pane: PANE, sources: w.sources })).toEqual({
      version: '0.167.0',
      source: 'process',
    });
  });

  it('путь версии не несёт — версия из package.json пакета codex рядом', async () => {
    const pkg = path.join(dir, 'lib', 'node_modules', '@openai', 'codex');
    const bin = path.join(pkg, 'vendor', 'aarch64-apple-darwin', 'codex');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@openai/codex","version":"0.166.0"}');
    const w = world(path.join(bin, 'codex'));
    expect(await agentInfo('codex', rollout, 'codex', { pane: PANE, sources: w.sources })).toMatchObject({
      version: '0.166.0',
      source: 'process',
    });
  });

  it('программа версии не называет — версия из беседы, с пометкой источника', async () => {
    const w = world('/usr/local/bin/codex');
    expect(await agentInfo('codex', rollout, 'codex', { pane: PANE, sources: w.sources })).toEqual({
      version: '0.161.0',
      model: 'gpt-9-unknown',
      source: 'transcript',
    });
  });

  it('обход процессов сорвался — версия из беседы, а не сбой', async () => {
    const w = world(() => {
      throw new Error('lsof: permission denied');
    });
    expect(await agentInfo('codex', rollout, 'codex', { pane: PANE, sources: w.sources })).toMatchObject({
      version: '0.161.0',
      source: 'transcript',
    });
  });

  it('без адреса панели — прежнее поведение: версия из беседы', async () => {
    expect(await agentInfo('codex', rollout, 'codex')).toEqual({
      version: '0.161.0',
      model: 'gpt-9-unknown',
      source: 'transcript',
    });
  });

  it('помнится на процесс: тот же клиент не опрашивается заново, новый — опрашивается', async () => {
    const w = world(CASK);
    const where = { pane: PANE, sources: w.sources };
    await agentInfo('codex', rollout, 'codex', where);
    await agentInfo('codex', rollout, 'codex', where);
    expect(w.asked).toEqual([200]);
    // Codex перезапустили в той же оболочке: pid оболочки прежний, клиент новый.
    w.rows[1] = { pid: 201, ppid: 100, startedAt: new Date(STARTED.getTime() + 60_000), args: 'codex' };
    clearCache();
    await agentInfo('codex', rollout, 'codex', where);
    expect(w.asked).toEqual([200, 201]);
  });
});

describe('agentInfo — версия Claude', () => {
  it('по-прежнему команда панели; процессы не опрашиваются', async () => {
    const w = world(CASK);
    expect(await agentInfo('claude', undefined, '2.1.322', { pane: PANE, sources: w.sources })).toEqual({
      version: '2.1.322',
      source: 'process',
    });
    expect(w.asked).toEqual([]);
  });
});
