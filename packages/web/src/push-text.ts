// Тело пуша о звонке сессии и текст уведомления из него. Чистый модуль без импортов:
// его тянет только service worker (общий с main модуль rollup вынес бы в чанк, а
// классический воркер `import` не переживает).

export interface PushBody {
  session: string;
  /** Название беседы из заголовка панели. */
  task: string;
  /** Что случилось: агент спрашивает либо закончил ход. Нет — агент старше сводки. */
  kind?: 'question' | 'done';
  agent?: string;
  text?: string;
  options?: string[];
}

/** Разбор тела пуша: незнакомое и битое отбрасывается поштучно. */
export function parsePush(raw: unknown): PushBody {
  const body = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const session = str(body.session) || 'TermHub';
  const kind = body.kind === 'question' || body.kind === 'done' ? body.kind : undefined;
  const options = Array.isArray(body.options) ? body.options.filter((o): o is string => typeof o === 'string' && o !== '') : [];
  return {
    session,
    task: str(body.task),
    ...(kind ? { kind } : {}),
    ...(str(body.agent) ? { agent: str(body.agent) } : {}),
    ...(str(body.text) ? { text: str(body.text) } : {}),
    ...(options.length > 0 ? { options } : {}),
  };
}

const WORDS = {
  ru: { asks: 'спрашивает', done: 'закончил', agent: 'Агент', session: 'сессия' },
  en: { asks: 'asks', done: 'is done', agent: 'The agent', session: 'session' },
} as const;

/** Заголовок и текст уведомления. Заголовок — название беседы (а нет его — имя сессии);
 *  текст — кто и что: «Codex спрашивает: …» с вариантами либо «Claude закончил: …» с началом
 *  ответа; последней строкой — имя сессии, если заголовок занят названием беседы. Язык — по
 *  языку системы: настройки приложения воркеру не видны. */
export function notificationText(push: PushBody, language = 'en'): { title: string; body: string } {
  const words = WORDS[language.toLowerCase().startsWith('ru') ? 'ru' : 'en'];
  const title = push.task || push.session;
  const lines: string[] = [];
  if (push.kind) {
    const who = push.agent ?? words.agent;
    const what = push.kind === 'question' ? words.asks : words.done;
    lines.push(push.text ? `${who} ${what}: ${push.text}` : `${who} ${what}`);
    if (push.kind === 'question' && push.options?.length) lines.push(push.options.map((o) => `• ${o}`).join('\n'));
  }
  if (push.task) lines.push(`${words.session}: ${push.session}`);
  // Старый агент сводки не шлёт: прежний вид — «сессия: задача» под заголовком TermHub.
  if (!push.kind) return { title: 'TermHub', body: push.task ? `${push.session}: ${push.task}` : push.session };
  return { title, body: lines.join('\n') };
}
