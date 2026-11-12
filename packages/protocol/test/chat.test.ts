import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AGENT_CAPS, CAP_CHAT, CLIENT_CAPS } from '../src/capabilities.js';
import { questionStamp } from '../src/chat.js';
import type { ChatAction, LiveState, ScreenQuestion } from '../src/chat.js';
import { FrameType } from '../src/frames.js';

describe('кадры чата', () => {
  it('номера 48–53 идут парами запрос → ответ', () => {
    expect(FrameType.Live).toBe(48);
    expect(FrameType.LiveResult).toBe(49);
    expect(FrameType.Act).toBe(50);
    expect(FrameType.ActResult).toBe(51);
    expect(FrameType.Commands).toBe(52);
    expect(FrameType.CommandsResult).toBe(53);
  });
});

describe('возможность chat', () => {
  it('объявлена обеими сторонами', () => {
    expect(CAP_CHAT).toBe('chat');
    expect(AGENT_CAPS).toContain('chat');
    expect(CLIENT_CAPS).toContain('chat');
  });
});

describe('questionStamp', () => {
  const options = [
    { key: '1', label: 'Yes' },
    { key: '2', label: 'Yes, and switch to accept edits for this session' },
    { key: '3', label: 'No' },
  ];

  it('отпечаток — 16 шестнадцатеричных знаков, один и тот же на тот же вопрос', () => {
    const a = questionStamp('Do you want to create hello.txt?', options);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(questionStamp('Do you want to create hello.txt?', options)).toBe(a);
  });

  it('перенос строк и лишние пробелы отпечаток не меняют', () => {
    const wide = questionStamp('Do you want to create hello.txt?', options);
    const narrow = questionStamp('Do you want to\ncreate  hello.txt?', [
      options[0]!,
      { key: '2', label: 'Yes, and switch to accept edits\n      for this session' },
      options[2]!,
    ]);
    expect(narrow).toBe(wide);
  });

  it('другой заголовок, другой вариант и другой порядок дают другой отпечаток', () => {
    const base = questionStamp('Do you want to create hello.txt?', options);
    expect(questionStamp('Do you want to create other.txt?', options)).not.toBe(base);
    expect(questionStamp('Do you want to create hello.txt?', options.slice(0, 2))).not.toBe(base);
    expect(
      questionStamp('Do you want to create hello.txt?', [options[2]!, options[1]!, options[0]!]),
    ).not.toBe(base);
  });

  it('граница заголовка и варианта различима', () => {
    expect(questionStamp('ab', [{ key: '1', label: 'c' }])).not.toBe(
      questionStamp('a', [{ key: '1', label: 'bc' }]),
    );
  });

  it('тело входит в отпечаток: тот же вопрос о другой команде — другой отпечаток', () => {
    const title = 'Do you want to proceed?';
    const a = questionStamp(title, options, 'Bash command\nrm -rf build');
    expect(questionStamp(title, options, 'Bash command\nrm -rf src')).not.toBe(a);
    expect(questionStamp(title, options)).not.toBe(a);
    expect(questionStamp(title, options, '')).toBe(questionStamp(title, options));
  });

  it('перенос строк тела отпечаток не меняет', () => {
    const title = 'Would you like to run the following command?';
    const wide = questionStamp(title, options, 'Reason: May I create hello.txt in the current directory?');
    const narrow = questionStamp(title, options, 'Reason: May I create hello.txt in the current\ndirectory?');
    expect(narrow).toBe(wide);
  });

  it('граница вариантов и тела различима', () => {
    expect(questionStamp('t', [{ key: '1', label: 'ab' }], 'c')).not.toBe(
      questionStamp('t', [{ key: '1', label: 'a' }], 'bc'),
    );
  });

  it('отметки, положение указателя и текст свободного варианта в отпечаток не входят', () => {
    const plain = questionStamp('Which fruits?', [
      { key: '1', label: 'Apple' },
      { key: '2', label: 'Type something', free: true },
    ]);
    const touched = questionStamp('Which fruits?', [
      { key: '1', label: 'Apple', checked: true, selected: true },
      { key: '2', label: 'parrot', free: true },
    ]);
    expect(touched).toBe(plain);
  });
});

describe('формы провода', () => {
  it('типы собираются в ожидаемые значения', () => {
    const question: ScreenQuestion = {
      stamp: questionStamp('Q?', [{ key: '1', label: 'A' }]),
      title: 'Q?',
      options: [{ key: '1', label: 'A' }],
    };
    const live: LiveState = {
      ok: true,
      agent: 'claude',
      tested: true,
      screen: { kind: 'question', question },
      modes: [],
      models: [],
    };
    const action: ChatAction = { kind: 'answer', stamp: question.stamp, option: '1' };
    expect(live.screen.question?.stamp).toBe(action.stamp);
  });
});

describe('подпуть @termhub/protocol/chat', () => {
  it('объявлен в package.json и не тянет крипту', () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { exports: Record<string, { default: string }> };
    expect(pkg.exports['./chat']?.default).toBe('./dist/chat.js');
    const source = readFileSync(fileURLToPath(new URL('../src/chat.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/^import /m);
  });
});
