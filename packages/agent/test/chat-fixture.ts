// Ожидаемые тела чата — одни на оба транспорта (приём feed-fixture.ts). LAN-ответ
// (`GET /api/live`, `POST /api/act`) сверяется с этими строками как есть; payload кадров
// LiveResult/ActResult — то же тело с `id` запроса первым полем (`withId`).

import type { ActResult, ChatAction, CommandsResult, LiveResult } from '@termhub/protocol/chat';

/** Тип не ослаблять: он и ловит расхождение форм. */
export const LIVE_STATE: LiveResult = {
  ok: true,
  agent: 'claude',
  version: '2.1.322',
  tested: true,
  model: 'Fable 5.2',
  screen: { kind: 'working', status: 'Думаю…', elapsed: 6, mode: 'plan', input: '', queued: 1 },
  modes: [
    { id: 'manual', label: 'Manual' },
    { id: 'plan', label: 'Plan' },
  ],
  models: [{ id: 'fable', label: 'Fable 5.2' }],
};

/** То же тело, выписанное руками: ожидание не считается тем же способом, что ответ. */
export const LIVE_STATE_JSON =
  '{"ok":true,"agent":"claude","version":"2.1.322","tested":true,"model":"Fable 5.2",' +
  '"screen":{"kind":"working","status":"Думаю…","elapsed":6,"mode":"plan","input":"","queued":1},' +
  '"modes":[{"id":"manual","label":"Manual"},{"id":"plan","label":"Plan"}],' +
  '"models":[{"id":"fable","label":"Fable 5.2"}]}';

export const LIVE_CRASH_JSON = '{"ok":false,"reason":"lookup-failed","detail":"pane vanished"}';

export const ACT_ACTION: ChatAction = { kind: 'answer', stamp: 'aa11bb22cc33dd44', option: '2' };

export const ACT_DONE: ActResult = { ok: true, screen: { kind: 'idle', mode: 'manual', input: '' }, taken: 'черновик' };

export const ACT_DONE_JSON = '{"ok":true,"screen":{"kind":"idle","mode":"manual","input":""},"taken":"черновик"}';

export const ACT_STALE: ActResult = { ok: false, reason: 'stale', detail: 'the question is a different one' };

export const ACT_STALE_JSON = '{"ok":false,"reason":"stale","detail":"the question is a different one"}';

/** Отказ на действие, которого не разобрать: до панели оно не доходит. */
export const ACT_BAD_JSON = '{"ok":false,"reason":"unsupported","detail":"not a chat action"}';

/** Список команд для подсказок (`GET /api/commands`, кадр Commands). */
export const COMMANDS_LIST: CommandsResult = {
  ok: true,
  commands: [
    { name: 'compact', hint: 'Free up context', source: 'builtin' },
    { name: 'ship', hint: 'Ship it', source: 'user', args: '<env>' },
    { name: 'plugin:thing', source: 'screen' },
  ],
  verified: true,
};

export const COMMANDS_LIST_JSON =
  '{"ok":true,"commands":[{"name":"compact","hint":"Free up context","source":"builtin"},' +
  '{"name":"ship","hint":"Ship it","source":"user","args":"<env>"},{"name":"plugin:thing","source":"screen"}],"verified":true}';

export const COMMANDS_CRASH_JSON = '{"ok":false,"reason":"lookup-failed","detail":"pane vanished"}';

/** Отказ гостю relay. */
export const CHAT_FORBIDDEN_SESSION_JSON = '{"ok":false,"reason":"forbidden","detail":"session not shared"}';
export const CHAT_FORBIDDEN_WRITE_JSON = '{"ok":false,"reason":"forbidden","detail":"no write permission"}';

/** Payload кадра ответа: то же тело, перед которым стоит `id` запроса. */
export function withId(id: number, json: string): string {
  return `{"id":${id},${json.slice(1)}`;
}
