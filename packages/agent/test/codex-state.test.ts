// База состояния Codex: настоящий SQLite во временном каталоге, живой Codex не трогается.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { codexStateDb, readCodexThreads } from '../src/codex-state.js';

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-codex-state-'));
  fs.mkdirSync(path.join(home, '.codex'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function makeDb(name: string, schema = true): void {
  const db = new DatabaseSync(path.join(home, '.codex', name));
  if (schema) {
    db.exec(
      'create table threads (id text primary key, rollout_path text, cwd text, title text, name text, archived integer, thread_source text)',
    );
    const add = db.prepare('insert into threads values (?, ?, ?, ?, ?, ?, ?)');
    add.run('t1', '/r/router.jsonl', '/work/app', 'Продолжи работу', 'Router', 0, 'user');
    add.run('t2', '/r/mqtt.jsonl', '/work/app', 'Передача автопилота', 'MQTT', 0, 'user');
    add.run('t3', '/r/review.jsonl', '/work/app', 'Guardian review', 'Guardian review', 0, 'guardian_review');
    add.run('t4', '/r/old.jsonl', '/work/app', 'Старое', 'Old', 1, 'user');
    add.run('t5', '/r/elsewhere.jsonl', '/work/other', 'Чужой каталог', 'Router', 0, 'user');
    add.run('t6', '/r/unnamed.jsonl', '/work/app', 'Без имени', null, 0, null);
  } else db.exec('create table something_else (x integer)');
  db.close();
}

describe('база состояния Codex', () => {
  it('берётся файл с наибольшим номером схемы; нет базы — нет и потоков', async () => {
    expect(await codexStateDb(home)).toBeUndefined();
    expect(await readCodexThreads(home, '/work/app')).toEqual([]);
    makeDb('state_4.sqlite', false);
    makeDb('state_5.sqlite');
    expect(await codexStateDb(home)).toBe(path.join(home, '.codex', 'state_5.sqlite'));
  });

  it('отдаёт корневые неархивные потоки каталога: без подагентов, архива и чужих каталогов', async () => {
    makeDb('state_5.sqlite');
    const rows = await readCodexThreads(home, '/work/app');
    expect(rows).toEqual([
      { id: 't1', rolloutPath: '/r/router.jsonl', name: 'Router' },
      { id: 't2', rolloutPath: '/r/mqtt.jsonl', name: 'MQTT' },
      // Имени нет — названием служит заголовок; источник не указан — считается беседой человека.
      { id: 't6', rolloutPath: '/r/unnamed.jsonl', name: 'Без имени' },
    ]);
  });

  it('незнакомая схема — null: определитель идёт прежним путём', async () => {
    makeDb('state_9.sqlite', false);
    expect(await readCodexThreads(home, '/work/app')).toBeNull();
  });
});
