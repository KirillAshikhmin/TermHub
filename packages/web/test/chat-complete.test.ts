// Подсказки поля ввода: где открывается список, как сужается и что подставляется.
import type { ChatCommand } from '@termhub/protocol/chat';
import { describe, expect, it } from 'vitest';

import { applyCompletion, completionAt, rankCommands } from '../src/chat-complete';

describe('completionAt', () => {
  it('«/» в начале поля открывает список команд, набор — запрос', () => {
    expect(completionAt('/', 1)).toEqual({ kind: 'slash', query: '', from: 0, to: 1 });
    expect(completionAt('/co', 3)).toEqual({ kind: 'slash', query: 'co', from: 0, to: 3 });
  });

  it('«/» в середине текста и после пробела списка не открывает', () => {
    expect(completionAt('сделай /commit', 14)).toBeNull();
    expect(completionAt('a\n/commit', 9)).toBeNull();
    expect(completionAt('путь a/b', 8)).toBeNull();
  });

  it('после пробела за командой — уже аргументы, список закрыт', () => {
    expect(completionAt('/model opus', 11)).toBeNull();
    expect(completionAt('/model ', 7)).toBeNull();
  });

  it('«@» открывает файлы в начале и после пробела или переноса', () => {
    expect(completionAt('@', 1)).toEqual({ kind: 'file', query: '', from: 0, to: 1 });
    expect(completionAt('глянь @src/ch', 13)).toEqual({ kind: 'file', query: 'src/ch', from: 6, to: 13 });
    expect(completionAt('a\n@x', 4)).toEqual({ kind: 'file', query: 'x', from: 2, to: 4 });
  });

  it('«@» внутри слова (почта) списка не открывает', () => {
    expect(completionAt('mail me@host', 12)).toBeNull();
  });

  it('каретка внутри слова: запрос до каретки, замена — до конца слова', () => {
    expect(completionAt('/commit', 3)).toEqual({ kind: 'slash', query: 'co', from: 0, to: 7 });
    expect(completionAt('см @src/main.ts дальше', 7)).toEqual({ kind: 'file', query: 'src', from: 3, to: 15 });
  });

  it('каретка до «/» или «@», в чужом слове и в пустом поле — ничего', () => {
    expect(completionAt('/commit', 0)).toBeNull();
    expect(completionAt('слово другое', 8)).toBeNull();
    expect(completionAt('', 0)).toBeNull();
  });
});

const CMDS: ChatCommand[] = [
  { name: 'compact', hint: 'Сжать контекст', source: 'builtin' },
  { name: 'review', hint: 'Проверить commit', source: 'skill' },
  { name: 'commit', source: 'project' },
  { name: 'init', hint: 'Создать CLAUDE.md', source: 'builtin' },
];

describe('rankCommands', () => {
  it('пустой запрос — все, порядок прежний', () => {
    expect(rankCommands(CMDS, '').map((c) => c.name)).toEqual(['compact', 'review', 'commit', 'init']);
  });

  it('начало имени старше вхождения, вхождение в имени — старше подсказки', () => {
    expect(rankCommands(CMDS, 'co').map((c) => c.name)).toEqual(['compact', 'commit']);
    expect(rankCommands(CMDS, 'view').map((c) => c.name)).toEqual(['review']);
    expect(rankCommands([CMDS[1]!, CMDS[2]!], 'mit').map((c) => c.name)).toEqual(['commit']);
    expect(rankCommands([{ name: 'recommit', source: 'user' }, CMDS[2]!], 'com').map((c) => c.name)).toEqual(['commit', 'recommit']);
  });

  it('подсказка в поиске не участвует: сужают по имени', () => {
    expect(rankCommands(CMDS, 'контекст')).toEqual([]);
  });

  it('регистр не важен; нет совпадений — пусто', () => {
    expect(rankCommands(CMDS, 'INI').map((c) => c.name)).toEqual(['init']);
    expect(rankCommands(CMDS, 'zzz')).toEqual([]);
  });
});

describe('applyCompletion', () => {
  it('команда заменяет набранное и добавляет пробел', () => {
    const at = completionAt('/co', 3)!;
    expect(applyCompletion('/co', at, '/compact')).toEqual({ text: '/compact ', caret: 9 });
  });

  it('замена идёт до конца слова; пробел после не удваивается', () => {
    const text = 'см @src/main.ts дальше';
    const at = completionAt(text, 7)!;
    expect(applyCompletion(text, at, '@src/other.ts')).toEqual({ text: 'см @src/other.ts дальше', caret: 16 });
  });

  it('без пробела — для каталога: подсказка остаётся открытой на его содержимом', () => {
    const text = 'глянь @sr';
    const at = completionAt(text, 9)!;
    const res = applyCompletion(text, at, '@src/', false);
    expect(res).toEqual({ text: 'глянь @src/', caret: 11 });
    expect(completionAt(res.text, res.caret)).toEqual({ kind: 'file', query: 'src/', from: 6, to: 11 });
  });

  it('каретка встаёт после вставленного', () => {
    const text = 'глянь @';
    const at = completionAt(text, 7)!;
    const res = applyCompletion(text, at, '@a.ts');
    expect(res).toEqual({ text: 'глянь @a.ts ', caret: 12 });
  });
});
