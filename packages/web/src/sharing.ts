// Диалоги «Поделиться» (генерация кода пейринга, опционально со scope на одну
// сессию) и «Устройства» (список + отзыв). Работают в обоих режимах через
// Transport (LAN — REST, relay — E2E).

import { t } from './i18n';
import type { DeviceInfo, DeviceScope, Transport } from './transport';
import { copyToClipboard, iconButton, openModal, spinner, toast } from './ui';

/** Короткий отпечаток для отображения. */
function shortFp(fp: string): string {
  return fp.length > 12 ? `${fp.slice(0, 12)}…` : fp;
}

/** Бейдж прав устройства. */
function scopeBadge(scope?: DeviceScope): string {
  if (!scope) return t('devices.fullAccess');
  const parts = [scope.session];
  if (scope.write) parts.push(t('devices.write'));
  if (scope.files) parts.push(t('devices.files'));
  return parts.join(' · ');
}

/** Показывает сгенерированный код пейринга (заменяет тело модалки). */
function showCode(body: HTMLElement, code: string): void {
  body.replaceChildren();
  const codeEl = document.createElement('div');
  codeEl.className = 'th-share__code';
  codeEl.textContent = code;
  const hint = document.createElement('p');
  hint.className = 'th-share__hint';
  hint.textContent = t('share.hint');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'th-btn';
  copy.textContent = t('share.copy');
  copy.addEventListener('click', () => {
    void copyToClipboard(code).then((ok) =>
      toast(ok ? t('share.copied') : t('files.error'), ok ? 'info' : 'error'),
    );
  });
  body.append(codeEl, hint, copy);
}

/** Диалог «Поделиться». presetSession — из терминала (шарим конкретную сессию). */
export function openShareDialog(transport: Transport, presetSession?: string): void {
  openModal((close) => {
    const box = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('share.title');
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-share__body';
    box.append(head, body);

    // Управление формой возвращает scope | undefined (полный доступ).
    let getScope: () => DeviceScope | undefined = () => undefined;

    const buildForm = (sessions: string[]): void => {
      body.replaceChildren();
      // Режим: все сессии или конкретная.
      const modeAll = document.createElement('label');
      modeAll.className = 'th-share__opt';
      const radioAll = document.createElement('input');
      radioAll.type = 'radio';
      radioAll.name = 'share-mode';
      radioAll.checked = !presetSession;
      modeAll.append(radioAll, document.createTextNode(' ' + t('share.allSessions')));

      const modeOne = document.createElement('label');
      modeOne.className = 'th-share__opt';
      const radioOne = document.createElement('input');
      radioOne.type = 'radio';
      radioOne.name = 'share-mode';
      radioOne.checked = !!presetSession;
      modeOne.append(radioOne, document.createTextNode(' ' + t('share.oneSession')));

      const sessionSelect = document.createElement('select');
      sessionSelect.className = 'th-input';
      const opts = presetSession ? [presetSession] : sessions;
      for (const s of opts) {
        const o = document.createElement('option');
        o.value = s;
        o.textContent = s;
        sessionSelect.append(o);
      }
      if (presetSession) sessionSelect.value = presetSession;

      const writeLabel = document.createElement('label');
      writeLabel.className = 'th-share__opt';
      const writeCb = document.createElement('input');
      writeCb.type = 'checkbox';
      writeCb.checked = true;
      writeLabel.append(writeCb, document.createTextNode(' ' + t('share.allowWrite')));

      const filesLabel = document.createElement('label');
      filesLabel.className = 'th-share__opt';
      const filesCb = document.createElement('input');
      filesCb.type = 'checkbox';
      filesLabel.append(filesCb, document.createTextNode(' ' + t('share.allowFiles')));

      const scopeBox = document.createElement('div');
      scopeBox.className = 'th-share__scope';
      scopeBox.append(sessionSelect, writeLabel, filesLabel);

      const syncMode = (): void => {
        scopeBox.style.display = radioOne.checked ? '' : 'none';
      };
      radioAll.addEventListener('change', syncMode);
      radioOne.addEventListener('change', syncMode);
      syncMode();

      // presetSession → скрываем выбор «все» (шарим именно эту).
      if (presetSession) {
        modeAll.style.display = 'none';
        sessionSelect.disabled = true;
      } else {
        body.append(modeAll, modeOne);
      }
      body.append(scopeBox);

      getScope = () =>
        radioOne.checked
          ? { session: sessionSelect.value, write: writeCb.checked, files: filesCb.checked }
          : undefined;

      const gen = document.createElement('button');
      gen.type = 'button';
      gen.className = 'th-btn th-btn--primary';
      gen.textContent = t('share.generate');
      gen.addEventListener('click', () => {
        gen.disabled = true;
        gen.replaceChildren(spinner());
        void transport.share(getScope()).then(
          (info) => showCode(body, info.code),
          (err) => {
            gen.disabled = false;
            gen.textContent = t('share.generate');
            toast(err instanceof Error && err.message ? err.message : t('files.error'), 'error');
          },
        );
      });
      const foot = document.createElement('div');
      foot.className = 'th-modal__foot';
      foot.append(gen);
      box.append(foot);
    };

    // Список сессий нужен только для выбора в режиме «конкретная» (не preset).
    if (presetSession) {
      buildForm([]);
    } else {
      body.append(spinner());
      void transport.list().then(
        (list) => buildForm(list.map((s) => s.name)),
        () => buildForm([]),
      );
    }

    return box;
  });
}

/** Модалка «Устройства»: список + отзыв. */
export function openDevicesModal(transport: Transport): void {
  openModal((close) => {
    const box = document.createElement('div');
    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('devices.title');
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-devices__body';
    body.append(spinner());
    box.append(head, body);

    const render = (devices: DeviceInfo[]): void => {
      body.replaceChildren();
      if (devices.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'th-devices__empty';
        empty.textContent = t('devices.empty');
        body.append(empty);
        return;
      }
      for (const d of devices) {
        const row = document.createElement('div');
        row.className = 'th-devices__row';
        const info = document.createElement('div');
        info.className = 'th-devices__info';
        const name = document.createElement('div');
        name.className = 'th-devices__name';
        name.textContent = d.name;
        const meta = document.createElement('div');
        meta.className = 'th-devices__meta';
        meta.textContent = `${shortFp(d.fingerprint)} · ${scopeBadge(d.scope)}`;
        info.append(name, meta);
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'th-btn th-btn--danger';
        revoke.textContent = t('devices.revoke');
        revoke.addEventListener('click', () => {
          revoke.disabled = true;
          void transport.revoke(d.fingerprint).then(
            () => load(),
            () => {
              revoke.disabled = false;
              toast(t('files.error'), 'error');
            },
          );
        });
        row.append(info, revoke);
        body.append(row);
      }
    };

    const load = (): void => {
      body.replaceChildren(spinner());
      void transport.devices().then(render, () => {
        body.replaceChildren();
        const err = document.createElement('p');
        err.className = 'th-devices__empty';
        err.textContent = t('files.error');
        body.append(err);
      });
    };
    load();

    return box;
  });
}
