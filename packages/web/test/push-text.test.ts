import { describe, expect, it } from 'vitest';

import { notificationText, parsePush } from '../src/push-text';

describe('текст уведомления о звонке сессии', () => {
  it('агент спрашивает: заголовок — название беседы, в тексте вопрос, варианты и имя сессии', () => {
    const push = parsePush({
      session: 'sprut_app2',
      task: 'MQTT',
      kind: 'question',
      agent: 'Codex',
      text: 'Довести до слияния?',
      options: ['Да', 'Нет', 7],
    });
    expect(notificationText(push, 'ru-RU')).toEqual({
      title: 'MQTT',
      body: 'Codex спрашивает: Довести до слияния?\n• Да\n• Нет\nсессия: sprut_app2',
    });
  });

  it('агент закончил: начало его ответа; без названия беседы заголовок — имя сессии', () => {
    const push = parsePush({ session: 'work', task: '', kind: 'done', agent: 'Claude', text: 'Готово, тесты зелёные.' });
    expect(notificationText(push, 'ru')).toEqual({ title: 'work', body: 'Claude закончил: Готово, тесты зелёные.' });
    expect(notificationText(parsePush({ session: 'work', kind: 'done' }), 'en-US')).toEqual({ title: 'work', body: 'The agent is done' });
  });

  it('старый агент без сводки и битое тело — прежний вид', () => {
    expect(notificationText(parsePush({ session: 'work', task: 'Refactor' }))).toEqual({ title: 'TermHub', body: 'work: Refactor' });
    expect(notificationText(parsePush(null))).toEqual({ title: 'TermHub', body: 'TermHub' });
    expect(parsePush({ session: 5, kind: 'nope', text: 3 })).toEqual({ session: 'TermHub', task: '' });
  });
});
