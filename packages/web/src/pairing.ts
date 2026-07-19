// Экран пейринга: ввод одноразового кода агента (XXXX-YYYY-YYYY-YYYY) + название
// агента. Крутит relay pair-flow клиента: pair-join(roomId) → pair-msg(hello) →
// pair-msg(ответ агента) → сохранение известного агента. Тянет крипто — грузится
// лениво (из remote.ts). i18n оба языка.

import {
  fingerprint,
  openPair,
  pairKey,
  parsePairingCode,
  sealPair,
} from '@termhub/protocol';
import type { Identity } from '@termhub/protocol';

import { b64, unb64 } from './b64';
import { t } from './i18n';
import type { KnownAgent } from './keys';
import { renderHeader, spinner } from './ui';

/** Длина Ed25519-публичного ключа. */
const ED25519_PUB_BYTES = 32;
/** Тайм-аут ожидания ответа агента (relay TTL — 5 мин, но UX-порог короче). */
const PAIR_TIMEOUT_MS = 30_000;

export interface PairingOpts {
  /** ws(s)://host/relay */
  wsUrl: string;
  identity: Identity;
  /** Имя этого устройства (шлётся агенту). */
  clientName: string;
  /** Успех: сохранить агента и перейти к списку. */
  onPaired: (agent: KnownAgent) => void;
  /** Отмена/назад к списку агентов. */
  onCancel: () => void;
}

/** Монтирует экран пейринга; возвращает функцию очистки. */
export function mountPairing(root: HTMLElement, opts: PairingOpts): () => void {
  root.replaceChildren();
  const header = renderHeader(false);
  root.append(header.el);

  const main = document.createElement('main');
  main.className = 'th-login';

  const form = document.createElement('form');
  form.className = 'th-login__card';
  form.noValidate = true;

  const title = document.createElement('h1');
  title.className = 'th-login__title';
  title.textContent = t('pair.title');

  const subtitle = document.createElement('p');
  subtitle.className = 'th-login__subtitle';
  subtitle.textContent = t('pair.subtitle');

  const codeInput = document.createElement('input');
  codeInput.type = 'text';
  codeInput.className = 'th-input th-pair__code';
  codeInput.autocomplete = 'off';
  codeInput.spellcheck = false;
  codeInput.autocapitalize = 'characters';
  codeInput.setAttribute('aria-label', t('pair.code'));
  codeInput.placeholder = 'XXXX-YYYY-YYYY-YYYY';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'th-input';
  nameInput.autocomplete = 'off';
  nameInput.setAttribute('aria-label', t('pair.name'));
  nameInput.placeholder = t('pair.namePlaceholder');

  const error = document.createElement('p');
  error.className = 'th-login__error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'th-btn th-btn--primary th-login__submit';
  submit.textContent = t('pair.submit');

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'th-btn';
  cancel.textContent = t('common.cancel');
  cancel.addEventListener('click', () => opts.onCancel());

  form.append(title, subtitle, codeInput, nameInput, error, submit, cancel);
  main.append(form);
  root.append(main);
  codeInput.focus();

  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let disposed = false;

  const showError = (message: string): void => {
    error.textContent = message;
    error.hidden = false;
    submit.disabled = false;
    submit.textContent = t('pair.submit');
    codeInput.focus();
    codeInput.select();
  };

  const teardownSocket = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (ws) {
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        // уже закрыт — идемпотентно
      }
      ws = null;
    }
  };

  const fail = (message: string): void => {
    if (settled || disposed) return;
    settled = true;
    teardownSocket();
    showError(message);
  };

  const submitForm = (e: Event): void => {
    e.preventDefault();
    if (settled) {
      // Повторная попытка после ошибки — сбрасываем состояние.
      settled = false;
    }
    error.hidden = true;

    let roomId: string;
    let secret: string;
    try {
      ({ roomId, secret } = parsePairingCode(codeInput.value));
    } catch {
      showError(t('pair.errorCode'));
      return;
    }
    const key = pairKey(secret);
    const agentName = nameInput.value.trim();

    submit.disabled = true;
    submit.replaceChildren(spinner());
    teardownSocket();

    const sock = new WebSocket(opts.wsUrl);
    ws = sock;

    timer = setTimeout(() => fail(t('pair.errorTimeout')), PAIR_TIMEOUT_MS);

    sock.onopen = (): void => {
      sock.send(JSON.stringify({ t: 'pair-join', roomId }));
      const hello = sealPair(key, { edPub: b64(opts.identity.edPub), name: opts.clientName });
      sock.send(JSON.stringify({ t: 'pair-msg', data: b64(hello) }));
    };

    sock.onmessage = (ev: MessageEvent): void => {
      if (typeof ev.data !== 'string') return;
      let msg: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(ev.data);
        if (typeof parsed !== 'object' || parsed === null) return;
        msg = parsed as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === 'pair-msg' && typeof msg.data === 'string') {
        let reply: { edPub?: unknown; ok?: unknown };
        try {
          reply = openPair<{ edPub?: unknown; ok?: unknown }>(key, unb64(msg.data));
        } catch {
          fail(t('pair.errorCode'));
          return;
        }
        if (reply.ok !== true || typeof reply.edPub !== 'string') {
          fail(t('pair.errorGeneric'));
          return;
        }
        const agentEdPub = unb64(reply.edPub);
        if (agentEdPub.length !== ED25519_PUB_BYTES) {
          fail(t('pair.errorGeneric'));
          return;
        }
        const agentId = fingerprint(agentEdPub);
        const agent: KnownAgent = {
          agentId,
          name: agentName || agentId,
          edPub: reply.edPub,
          addedAt: Date.now(),
        };
        settled = true;
        teardownSocket();
        opts.onPaired(agent);
      } else if (msg.t === 'pair-closed' || msg.t === 'pair-peer-left') {
        fail(t('pair.errorTimeout'));
      } else if (msg.t === 'error') {
        fail(msg.code === 'no-room' ? t('pair.errorNoRoom') : t('pair.errorGeneric'));
      }
    };

    sock.onclose = (): void => {
      // Закрытие до успеха — неверный/просроченный код или комната занята.
      if (!settled && !disposed) fail(t('pair.errorNoRoom'));
    };
    sock.onerror = (): void => {}; // за onerror всегда идёт onclose
  };

  form.addEventListener('submit', submitForm);

  return (): void => {
    disposed = true;
    teardownSocket();
    header.teardown();
    root.replaceChildren();
  };
}
