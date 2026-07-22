// Экран «Файлы»: навигация по корням сессий и вложенным папкам, просмотр файла
// в модалке (текст/картинка/скачивание). Работает в обоих режимах через Transport
// (LAN — REST, relay — E2E). Только чтение. Путь навигации живёт в hash
// (#/files/<root>/<path>) — работает кнопка «Назад» браузера.

import { t } from './i18n';
import { openModal } from './ui';
import { renderHeader, renderHoloBar, renderTabs, iconButton, spinner, toast, wireToolbar, errorScreen } from './ui';
import { openCreateModal } from './dashboard';
import { openRowMenu, openTextInNotaText, streamDownload } from './file-ops';
import { formatDate, formatSize } from './format';
import { mountSessionBar } from './tabs';
import { filesHash, parseSessionSub } from './routes';
import { resolveSessionPath } from './session-path';
import type { FileEntry, Transport } from './transport';

/** Расширение → язык highlight.js (для подсветки текста). */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown', yml: 'yaml', yaml: 'yaml',
  rs: 'rust', go: 'go', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', sql: 'sql', swift: 'swift',
  toml: 'ini', ini: 'ini', conf: 'ini', diff: 'diff', patch: 'diff',
};

/** Подсветка текста по расширению. Сразу показываем plain, затем лениво грузим
 *  highlight.js (отдельный чанк) и заменяем на подсвеченный HTML. */
function highlightText(code: HTMLElement, text: string, name: string): void {
  code.textContent = text;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  const lang = LANG_BY_EXT[ext];
  if (!lang) return;
  void import('./highlight')
    .then(({ default: hljs }) => {
      if (!hljs.getLanguage(lang)) return;
      code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
      code.classList.add('hljs');
    })
    .catch(() => {
      // подсветка недоступна — остаётся plain-текст
    });
}

/** Корни кэшируем на время сессии страницы: при hash-навигации экран
 *  перемонтируется, но набор корней не меняется — лишний dirs() ни к чему. */
let rootsCache: string[] | null = null;
/** Последняя открытая папка — восстанавливается при возврате на вкладку (не
 *  сбрасывается при уходе на сессии/репозиторий). */
let lastFilesLoc: { root: string; path: string } | null = null;


/** Склейка пути внутри корня без ведущего слэша. */
function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

/** Родительский путь («..»). */
function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Разбор hash навигации: #/files/<root>/<path>. */
function parseFilesHash(): { root: string; path: string } {
  const m = /^#\/files(?:\/([^/]*))?(?:\/(.*))?$/.exec(location.hash);
  return {
    root: m && m[1] ? decodeURIComponent(m[1]) : '',
    path: m && m[2] ? decodeURIComponent(m[2]) : '',
  };
}

// filesHash — в ./routes (общий формат с termlinks.ts).
// streamDownload — в ./file-ops (общий с пунктом «Скачать» в ⋮-меню строки).

/** Модалка просмотра одного файла. */
function openFileModal(transport: Transport, root: string, filePath: string, name: string): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-fileview';

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = name;
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-fileview__body';
    body.append(spinner());
    box.append(head, body);

    const canWrite = !transport.clientScope || transport.clientScope.write;
    const foot = document.createElement('div');
    foot.className = 'th-modal__foot';
    box.append(foot);

    const btn = (label: string, primary: boolean, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `th-btn${primary ? ' th-btn--primary' : ''}`;
      b.textContent = label;
      b.addEventListener('click', onClick);
      return b;
    };
    const downloadBtn = (): HTMLButtonElement =>
      btn(t('files.download'), true, () => streamDownload(transport, root, filePath, name));
    const showNote = (text: string): void => {
      body.replaceChildren();
      const p = document.createElement('p');
      p.className = 'th-fileview__note';
      p.textContent = text;
      body.append(p);
    };

    // Просмотр текста (подсветка) + подвал: скачать [+ редактировать при праве записи].
    const showText = (data: string): void => {
      body.replaceChildren();
      const pre = document.createElement('pre');
      pre.className = 'th-fileview__text';
      const codeEl = document.createElement('code');
      highlightText(codeEl, data, name);
      pre.append(codeEl);
      body.append(pre);
      foot.replaceChildren(downloadBtn());
      if (canWrite) foot.append(btn(t('files.edit'), false, () => editText(data)));
      foot.append(btn(t('files.openNota'), false, () => openTextInNotaText(data, name)));
    };
    // Простое редактирование: textarea + Сохранить/Отмена (write через fileOp).
    const editText = (data: string): void => {
      body.replaceChildren();
      const ta = document.createElement('textarea');
      ta.className = 'th-fileview__edit';
      ta.value = data;
      ta.spellcheck = false;
      body.append(ta);
      const save = btn(t('files.save'), true, () => {
        save.disabled = true;
        transport.fileOp('write', { root, path: filePath, content: ta.value }).then(
          () => {
            toast(t('files.saved'), 'info');
            showText(ta.value);
          },
          (err) => {
            save.disabled = false;
            toast(err instanceof Error ? err.message : t('files.error'), 'error');
          },
        );
      });
      foot.replaceChildren(btn(t('common.cancel'), false, () => showText(data)), save);
      ta.focus();
    };

    void transport
      .fileStat(root, filePath)
      .then((stat) => {
        // Видео/аудио — плеер (LAN — нативный range; relay — blob чанками).
        if (stat.kind === 'video' || stat.kind === 'audio') {
          body.replaceChildren();
          const media = document.createElement(stat.kind) as HTMLMediaElement;
          media.controls = true;
          media.className = 'th-fileview__media';
          const url = transport.downloadUrl(root, filePath);
          if (url) {
            media.src = url;
            body.append(media);
          } else {
            showNote(t('files.loading'));
            void transport.fileBlob(root, filePath).then(
              (blob) => {
                media.src = URL.createObjectURL(blob);
                body.replaceChildren(media);
              },
              () => showNote(t('files.error')),
            );
          }
          foot.replaceChildren(downloadBtn());
          return;
        }
        // Прочее — инлайн-просмотр (image/text) или скачивание (большое/binary).
        void transport.fileRead(root, filePath).then(
          (c) => {
            if (c.truncated) {
              showNote(t('files.tooLarge', { size: formatSize(c.size) }));
              foot.replaceChildren(downloadBtn());
              return;
            }
            if (c.kind === 'image') {
              body.replaceChildren();
              const img = document.createElement('img');
              img.className = 'th-fileview__img';
              img.src = `data:${c.mime};base64,${c.data}`;
              img.alt = name;
              body.append(img);
              foot.replaceChildren(downloadBtn());
            } else if (c.kind === 'text') {
              showText(c.data);
            } else {
              showNote(t('files.binary'));
              foot.replaceChildren(downloadBtn());
            }
          },
          (err) => showNote(err instanceof Error ? err.message : t('files.error')),
        );
      })
      .catch((err) => showNote(err instanceof Error ? err.message : t('files.error')));

    return box;
  });
}

/** Монтирует экран «Файлы». Путь берётся из hash (#/files/<root>/<path>),
 *  навигация меняет hash — кнопка «Назад» браузера листает историю путей. */
export function mountFiles(root: HTMLElement, transport: Transport, session?: string): () => void {
  // session-режим: подпуть из #/sfiles/<name>/<sub> (null → путь сессии по умолчанию).
  const sub = session ? parseSessionSub('sfiles') : null;
  const parsed = session ? { root: '', path: sub ?? '' } : parseFilesHash();
  // Возврат на голый #/files (не session-режим) — восстанавливаем последнюю папку.
  if (!session && !parsed.root && !parsed.path && lastFilesLoc) {
    location.hash = filesHash(lastFilesLoc.root, lastFilesLoc.path);
    return () => {};
  }
  root.replaceChildren();

  const main = document.createElement('main');
  main.className = 'th-files';

  let teardownTop = (): void => {};
  // session-режим: панель сессий (как на терминале) + Holo-таббар; иначе шапка + вкладки.
  if (session) {
    const sbar = mountSessionBar({
      transport,
      current: session,
      onSwitch: (name) => (location.hash = `#/sfiles/${encodeURIComponent(name)}`),
      onCreate: () =>
        openCreateModal(transport, (name) => (location.hash = `#/term/${encodeURIComponent(name)}`)),
    });
    teardownTop = sbar.teardown;
    let hideBar = (): void => {};
    const holo = renderHoloBar({ active: 'files', session, transport, onHide: () => hideBar() });
    const toolbar = document.createElement('div');
    toolbar.className = 'th-holowrap th-slide th-slide--top';
    toolbar.append(holo);
    root.append(sbar.el, toolbar, main);
    hideBar = wireToolbar({ toolbars: [toolbar], floatMount: main }).hide;
  } else {
    const header = renderHeader(true, transport);
    teardownTop = header.teardown;
    root.append(header.el, renderTabs('files', transport), main);
  }

  let stopped = false;
  let curRoot = parsed.root;
  let curPath = parsed.path;
  let floor = ''; // корень навигации: '' (дашборд) или путь сессии (session-режим)
  const canWrite = !transport.clientScope || transport.clientScope.write; // мутации файлов
  let lastEntries: FileEntry[] = []; // последний листинг — чтобы у таргета ссылки понять файл/папка
  let inited = false; // корень сессии резолвнут — можно реагировать на показ вкладки
  let lastTarget: string | null = sub; // последний обработанный таргет ссылки (#/sfiles/…/<путь>)

  const rootSelect = document.createElement('select');
  rootSelect.className = 'th-input th-files__root';

  const crumbs = document.createElement('div');
  crumbs.className = 'th-files__crumbs';

  const list = document.createElement('div');
  list.className = 'th-files__list';

  const bar = document.createElement('div');
  bar.className = 'th-files__bar';
  if (!session) bar.append(rootSelect); // session-режим: корень фиксирован, без селектора
  bar.append(crumbs);
  main.append(bar, list);

  // Ошибка загрузки: экран с сообщением + «Обновить» (retryFn — что перезапустить).
  const showError = (message: string, retryFn: () => void): void => {
    list.replaceChildren(errorScreen(message, retryFn));
  };

  // Навигация: dashboard — через hash (пере-монтирование роутером, работает «Назад»);
  // session-режим (живёт в workspace, не пере-монтируется) — внутренняя перерисовка.
  const navigate = (nextRoot: string, nextPath: string): void => {
    if (session) {
      curRoot = nextRoot;
      curPath = nextPath;
      void load();
    } else {
      location.hash = filesHash(nextRoot, nextPath);
    }
  };

  const renderCrumbs = (): void => {
    crumbs.replaceChildren();
    // Крошки от floor (session-режим — от папки сессии; иначе от корня '').
    const rel = floor && curPath.startsWith(floor) ? curPath.slice(floor.length).replace(/^\//, '') : curPath;
    const mkCrumb = (label: string, target: string): HTMLElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'th-files__crumb';
      b.textContent = label;
      b.addEventListener('click', () => navigate(curRoot, target));
      return b;
    };
    // Первая крошка — имя корневой папки навигации (вместо «/»); дальше сегменты пути.
    const rootName = floor
      ? (floor.split('/').pop() ?? floor)
      : (curRoot.split('/').filter(Boolean).pop() ?? curRoot);
    crumbs.append(mkCrumb(rootName, floor));
    let acc = floor;
    for (const p of rel ? rel.split('/') : []) {
      acc = joinPath(acc, p);
      crumbs.append(mkCrumb(p, acc));
    }
  };

  const render = (entries: FileEntry[]): void => {
    list.replaceChildren();
    // «..» — на уровень вверх, только если не в корне навигации (floor).
    if (curPath !== floor) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'th-files__row';
      const icon = document.createElement('span');
      icon.className = 'th-files__icon';
      icon.textContent = '📁';
      const nm = document.createElement('span');
      nm.className = 'th-files__name';
      nm.textContent = '..';
      up.append(icon, nm);
      up.addEventListener('click', () => navigate(curRoot, parentPath(curPath)));
      list.append(up);
    }
    if (entries.length === 0 && curPath === floor) {
      const empty = document.createElement('p');
      empty.className = 'th-files__empty';
      empty.textContent = t('files.empty');
      list.append(empty);
      return;
    }
    for (const e of entries) {
      const wrap = document.createElement('div');
      wrap.className = 'th-files__rowwrap';
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `th-files__row${e.hidden ? ' is-hidden-file' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'th-files__icon';
      icon.textContent = e.kind === 'dir' ? '📁' : '📄';
      const nm = document.createElement('span');
      nm.className = 'th-files__name';
      nm.textContent = e.name;
      const meta = document.createElement('span');
      meta.className = 'th-files__meta';
      meta.textContent =
        e.kind === 'file' ? `${formatSize(e.size)} · ${formatDate(e.mtime)}` : formatDate(e.mtime);
      row.append(icon, nm, meta);
      row.addEventListener('click', () => {
        if (e.kind === 'dir') navigate(curRoot, joinPath(curPath, e.name));
        else openFileModal(transport, curRoot, joinPath(curPath, e.name), e.name);
      });
      // Кнопка «⋮» — контекстное меню (копировать/переместить/переименовать/удалить/свойства).
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'th-files__more';
      more.textContent = '⋮';
      more.setAttribute('aria-label', t('files.actions'));
      more.addEventListener('click', () =>
        openRowMenu({
          transport,
          root: curRoot,
          path: joinPath(curPath, e.name),
          entry: e,
          canWrite,
          onDone: () => void load(),
        }),
      );
      wrap.append(row, more);
      list.append(wrap);
    }
  };

  const load = async (opts?: { silent?: boolean }): Promise<void> => {
    if (!session) lastFilesLoc = { root: curRoot, path: curPath }; // запоминаем (вне session-режима)
    renderCrumbs();
    if (!opts?.silent) list.replaceChildren(spinner()); // silent — тихий рефреш без спиннера (при показе вкладки)
    try {
      const entries = await transport.filesList(curRoot, curPath);
      if (stopped) return;
      lastEntries = entries;
      render(entries);
    } catch (err) {
      if (stopped) return;
      showError(err instanceof Error ? err.message : t('files.error'), () => void load());
    }
  };

  /** Открыть цель ссылки (полный путь rel к корню): показать РОДИТЕЛЬСКУЮ папку и,
   *  если это файл (есть в листинге) — сразу открыть его превью. */
  const openTarget = async (targetRel: string): Promise<void> => {
    const slash = targetRel.lastIndexOf('/');
    curPath = slash < 0 ? '' : targetRel.slice(0, slash);
    const name = slash < 0 ? targetRel : targetRel.slice(slash + 1);
    await load();
    if (stopped) return;
    const entry = lastEntries.find((e) => e.name === name);
    if (entry?.kind === 'file') openFileModal(transport, curRoot, targetRel, name);
  };

  rootSelect.addEventListener('change', () => navigate(rootSelect.value, ''));

  const fillRoots = (roots: string[]): void => {
    rootSelect.replaceChildren(
      ...roots.map((r) => {
        const o = document.createElement('option');
        o.value = r;
        o.textContent = r;
        if (r === curRoot) o.selected = true;
        return o;
      }),
    );
  };

  const start = (roots: string[]): void => {
    if (stopped) return;
    if (roots.length === 0) {
      list.replaceChildren();
      const p = document.createElement('p');
      p.className = 'th-files__empty';
      p.textContent = t('files.noRoots');
      list.append(p);
      return;
    }
    // Неизвестный/пустой корень в hash → первый доступный.
    if (!curRoot || !roots.includes(curRoot)) curRoot = roots[0]!;
    fillRoots(roots);
    void load();
  };

  // Корни: session-режим — из пути сессии (без селектора); иначе кэш или dirs().
  const startLoading = (): void => {
    if (session) {
      void resolveSessionPath(transport, session)
        .then((res) => {
          if (stopped) return;
          if (!res) {
            showError(t('files.error'), startLoading);
            return;
          }
          curRoot = res.root;
          floor = res.subpath; // папка сессии — корень навигации (не выше неё)
          inited = true;
          const target = parseSessionSub('sfiles'); // актуальный таргет из hash
          lastTarget = target;
          if (target === null) {
            curPath = res.subpath; // по умолчанию — ровно путь сессии
            void load();
          } else {
            void openTarget(target); // ссылка: родительская папка + превью файла
          }
        })
        .catch(() => {
          if (!stopped) showError(t('files.error'), startLoading);
        });
    } else if (rootsCache) {
      start(rootsCache);
    } else {
      void transport
        .dirs()
        .then((groups) => {
          rootsCache = groups.map((g) => g.root);
          start(rootsCache);
        })
        .catch(() => {
          if (!stopped) showError(t('files.error'), startLoading);
        });
    }
  };

  // Показ вкладки (session-режим, вид живёт в workspace, workspace ставит .is-active):
  // другой таргет из hash (новая ссылка) → навигация + превью файла; иначе — тихо
  // перечитать текущую папку (содержимое могло измениться, файл ссылки мог появиться).
  let obs: MutationObserver | null = null;
  if (session) {
    obs = new MutationObserver(() => {
      if (!inited || !root.classList.contains('is-active')) return;
      const hashSub = parseSessionSub('sfiles');
      if (hashSub !== null && hashSub !== lastTarget) {
        lastTarget = hashSub;
        void openTarget(hashSub);
      } else {
        void load({ silent: true });
      }
    });
    obs.observe(root, { attributes: true, attributeFilter: ['class'] });
  }

  startLoading();

  return () => {
    stopped = true;
    obs?.disconnect();
    teardownTop();
  };
}
