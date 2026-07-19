// Экран «Репозиторий»: навигация по папкам (как в проводнике) + интерфейс VCS
// (git/svn/hg) для папки-репозитория — лог коммитов, просмотр коммита с диффами,
// диалог коммита (выбор файлов галочками + сообщение). Оба режима через Transport
// (LAN — REST, relay — E2E). Путь навигации в hash (#/repo/<root>/<path>).

import { openCreateModal } from './dashboard';
import { t } from './i18n';
import { parseSessionSub, repoHash, srepoHash } from './routes';
import { resolveSessionPath } from './session-path';
import { mountSessionBar } from './tabs';
import { iconButton, openModal, renderHeader, renderHoloBar, renderTabs, spinner, toast, wireToolbar } from './ui';
import type {
  RepoBranches,
  RepoCommitDetail,
  RepoCommitRef,
  RepoFileChange,
  RepoLog,
  RepoStatus,
} from '@termhub/protocol';
import type { FileEntry, Transport } from './transport';

/** Корни кэшируем на время жизни страницы (набор не меняется при hash-навигации). */
let rootsCache: string[] | null = null;
/** Последняя открытая папка — восстанавливается при возврате на вкладку (не сбрасывается
 *  при уходе на сессии/проводник). Живёт на уровне модуля весь сеанс страницы. */
let lastRepoLoc: { root: string; path: string } | null = null;

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}
function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Разбор hash: #/repo/<root>/<path>. */
function parseRepoHash(): { root: string; path: string } {
  const m = /^#\/repo(?:\/([^/]*))?(?:\/(.*))?$/.exec(location.hash);
  return {
    root: m && m[1] ? decodeURIComponent(m[1]) : '',
    path: m && m[2] ? decodeURIComponent(m[2]) : '',
  };
}

/** Дата коммита компактно (локаль пользователя). */
function fmtDate(ts: number): string {
  if (!ts) return '';
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Человекочитаемое имя статуса файла по односимвольному коду. */
function statusLabel(code: string): string {
  const key = `repo.status.${code}`;
  const label = t(key);
  return label === key ? code : label;
}

/** Раскраска unified-диффа по строкам. */
function renderDiff(text: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'th-diff';
  if (!text.trim()) {
    pre.textContent = t('repo.noDiff');
    return pre;
  }
  for (const raw of text.split('\n')) {
    const line = document.createElement('div');
    line.className = 'th-diff__line';
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      line.classList.add('th-diff__meta');
    } else if (raw.startsWith('@@')) {
      line.classList.add('th-diff__hunk');
    } else if (raw.startsWith('+')) {
      line.classList.add('th-diff__add');
    } else if (raw.startsWith('-')) {
      line.classList.add('th-diff__del');
    }
    line.textContent = raw || ' ';
    pre.append(line);
  }
  return pre;
}

/** Просмотр содержимого файла (plain-текст). */
function fileView(text: string): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'th-repo__filetext';
  pre.textContent = text;
  return pre;
}

/** Строка изменённого файла: статус + путь (клик — дифф) + опц. просмотр файла и
 *  чекбокс. Дифф/файл грузятся лениво в раскрываемую панель. */
function changeRow(opts: {
  change: RepoFileChange;
  loadDiff: () => Promise<string>;
  loadFile?: () => Promise<string>;
  checkbox?: { onToggle: (checked: boolean) => void };
}): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'th-repo__change';

  const head = document.createElement('div');
  head.className = 'th-repo__changehead';

  if (opts.checkbox) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'th-repo__check';
    cb.addEventListener('change', () => opts.checkbox!.onToggle(cb.checked));
    head.append(cb);
  }

  const status = document.createElement('span');
  status.className = `th-repo__status is-${opts.change.status.toLowerCase().replace(/[^a-z]/g, 'x')}`;
  status.textContent = opts.change.status;
  status.title = statusLabel(opts.change.status);

  const pathBtn = document.createElement('button');
  pathBtn.type = 'button';
  pathBtn.className = 'th-repo__changepath';
  pathBtn.textContent = opts.change.path;

  head.append(status, pathBtn);

  const panel = document.createElement('div');
  panel.className = 'th-repo__diff';
  panel.hidden = true;

  let shown: 'diff' | 'file' | null = null;
  const show = (which: 'diff' | 'file', loader: () => Promise<string>, asDiff: boolean): void => {
    if (shown === which && !panel.hidden) {
      panel.hidden = true;
      shown = null;
      return;
    }
    shown = which;
    panel.hidden = false;
    panel.replaceChildren(spinner());
    loader().then(
      (text) => {
        if (shown === which) panel.replaceChildren(asDiff ? renderDiff(text) : fileView(text));
      },
      (err) => {
        panel.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-repo__note';
        p.textContent = err instanceof Error ? err.message : t('repo.error');
        panel.append(p);
      },
    );
  };

  if (opts.loadFile) {
    const fileBtn = document.createElement('button');
    fileBtn.type = 'button';
    fileBtn.className = 'th-repo__viewfile';
    fileBtn.textContent = '📄';
    fileBtn.title = t('repo.viewFile');
    fileBtn.addEventListener('click', () => show('file', opts.loadFile!, false));
    head.append(fileBtn);
  }

  wrap.append(head, panel);
  pathBtn.addEventListener('click', () => show('diff', opts.loadDiff, true));
  return wrap;
}

/** Модалка просмотра одного коммита: метаданные, сообщение, изменённые файлы + диффы. */
function openCommitModal(transport: Transport, root: string, path: string, commit: RepoCommitRef): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-repo__modal';

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = `${commit.short} · ${commit.subject}`;
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-repo__modalbody';
    body.append(spinner());
    box.append(head, body);

    transport.repo<RepoCommitDetail>('show', { root, path, rev: commit.rev }).then(
      (detail) => {
        body.replaceChildren();

        const meta = document.createElement('div');
        meta.className = 'th-repo__meta';
        meta.textContent = `${detail.author} · ${fmtDate(detail.date)}`;
        body.append(meta);

        if (detail.message) {
          const msg = document.createElement('pre');
          msg.className = 'th-repo__message';
          msg.textContent = detail.message;
          body.append(msg);
        }

        if (detail.files.length === 0) {
          const note = document.createElement('p');
          note.className = 'th-repo__note';
          note.textContent = t('repo.noFiles');
          body.append(note);
          return;
        }
        const files = document.createElement('div');
        files.className = 'th-repo__changes';
        for (const change of detail.files) {
          files.append(
            changeRow({
              change,
              loadDiff: () => transport.repo<string>('diff', { root, path, file: change.path, rev: commit.rev }),
            }),
          );
        }
        body.append(files);
      },
      (err) => {
        body.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-repo__note';
        p.textContent = err instanceof Error ? err.message : t('repo.error');
        body.append(p);
      },
    );

    return box;
  });
}

/** Диалог создания коммита: выбор файлов галочками (+ дифф) и сообщение. */
function openCommitDialog(transport: Transport, root: string, path: string, onDone: () => void): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-repo__modal';

    const head = document.createElement('div');
    head.className = 'th-modal__head';
    const title = document.createElement('h2');
    title.textContent = t('repo.commitTitle');
    head.append(title, iconButton('close', t('common.close'), close));

    const body = document.createElement('div');
    body.className = 'th-repo__modalbody';
    body.append(spinner());
    box.append(head, body);

    const selected = new Set<string>();

    const foot = document.createElement('div');
    foot.className = 'th-modal__foot th-repo__commitfoot';
    const msg = document.createElement('textarea');
    msg.className = 'th-repo__msginput';
    msg.rows = 2;
    msg.placeholder = t('repo.messagePlaceholder');
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'th-btn th-btn--primary';
    submit.textContent = t('repo.doCommit');
    const refresh = (): void => {
      submit.disabled = selected.size === 0 || !msg.value.trim();
    };
    msg.addEventListener('input', refresh);
    foot.append(msg, submit);

    submit.addEventListener('click', () => {
      submit.disabled = true;
      transport
        .repo<void>('commit', { root, path, files: [...selected], message: msg.value })
        .then(
          () => {
            close();
            toast(t('repo.committed'), 'info');
            onDone();
          },
          (err) => {
            refresh();
            toast(err instanceof Error ? err.message : t('repo.error'), 'error');
          },
        );
    });

    transport.repo<RepoStatus>('status', { root, path }).then(
      (status) => {
        body.replaceChildren();
        if (status.files.length === 0) {
          const note = document.createElement('p');
          note.className = 'th-repo__note';
          note.textContent = t('repo.clean');
          body.append(note);
          return;
        }
        const files = document.createElement('div');
        files.className = 'th-repo__changes';
        for (const change of status.files) {
          files.append(
            changeRow({
              change,
              loadDiff: () => transport.repo<string>('diff', { root, path, file: change.path }),
              loadFile: () => transport.repo<string>('cat', { root, path, file: change.path }),
              checkbox: {
                onToggle: (checked) => {
                  if (checked) selected.add(change.path);
                  else selected.delete(change.path);
                  refresh();
                },
              },
            }),
          );
        }
        body.append(files);
        box.append(foot);
        refresh();
      },
      (err) => {
        body.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-repo__note';
        p.textContent = err instanceof Error ? err.message : t('repo.error');
        body.append(p);
      },
    );

    return box;
  });
}

/** Меню веток: список (текущая помечена; тап — переключение), создать, удалить (git). */
function openBranchMenu(
  transport: Transport,
  root: string,
  path: string,
  data: RepoBranches,
  canWrite: boolean,
  onDone: () => void,
): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-sheet';
    const head = document.createElement('div');
    head.className = 'th-sheet__head';
    const title = document.createElement('div');
    title.className = 'th-sheet__title';
    title.textContent = t('repo.branches');
    head.append(title, iconButton('close', t('common.close'), close));
    box.append(head);

    const run = (action: string, branch: string, okKey: string): void => {
      transport.repo<void>(action, { root, path, branch }).then(
        () => {
          close();
          toast(t(okKey), 'info');
          onDone();
        },
        (err) => toast(err instanceof Error ? err.message : t('repo.error'), 'error'),
      );
    };

    if (canWrite && data.vcs !== 'svn') {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'th-sheet__item';
      create.textContent = t('repo.createBranch');
      create.addEventListener('click', () => {
        const name = prompt(t('repo.branchName'));
        if (name && name.trim()) run('create-branch', name.trim(), 'repo.branchCreated');
      });
      box.append(create);
    }

    for (const b of data.branches) {
      const row = document.createElement('div');
      row.className = 'th-branch__row';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = `th-sheet__item th-branch__pick${b === data.current ? ' is-current' : ''}`;
      pick.textContent = `${b === data.current ? '● ' : ''}${b}`;
      if (b === data.current) pick.disabled = true;
      else pick.addEventListener('click', () => run('checkout', b, 'repo.switched'));
      row.append(pick);
      if (canWrite && data.vcs === 'git' && b !== data.current) {
        const del = iconButton('trash', t('files.delete'), () => {
          if (confirm(t('repo.confirmDeleteBranch', { name: b }))) run('delete-branch', b, 'repo.branchDeleted');
        });
        del.classList.add('th-branch__del');
        row.append(del);
      }
      box.append(row);
    }
    if (data.branches.length === 0) {
      const note = document.createElement('p');
      note.className = 'th-sheet__note';
      note.textContent = t('repo.noBranches');
      box.append(note);
    }
    return box;
  });
}

/** Монтирует экран «Репозиторий». */
export function mountRepo(root: HTMLElement, transport: Transport, session?: string): () => void {
  const sub = session ? parseSessionSub('srepo') : null;
  const parsed = session ? { root: '', path: sub ?? '' } : parseRepoHash();
  // Возврат на голый #/repo (не session-режим) — восстанавливаем последнюю папку.
  if (!session && !parsed.root && !parsed.path && lastRepoLoc) {
    location.hash = repoHash(lastRepoLoc.root, lastRepoLoc.path);
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
      onSwitch: (name) => (location.hash = `#/srepo/${encodeURIComponent(name)}`),
      onCreate: () =>
        openCreateModal(transport, (name) => (location.hash = `#/term/${encodeURIComponent(name)}`)),
    });
    teardownTop = sbar.teardown;
    let hideBar = (): void => {};
    const holo = renderHoloBar({ active: 'repo', session, transport, onHide: () => hideBar() });
    const toolbar = document.createElement('div');
    toolbar.className = 'th-holowrap th-slide th-slide--top';
    toolbar.append(holo);
    root.append(sbar.el, toolbar, main);
    hideBar = wireToolbar({ toolbars: [toolbar], floatMount: main }).hide;
  } else {
    const header = renderHeader(true, transport);
    teardownTop = header.teardown;
    root.append(header.el, renderTabs('repo', transport), main);
  }

  let stopped = false;
  let curRoot = parsed.root;
  let curPath = parsed.path;

  const rootSelect = document.createElement('select');
  rootSelect.className = 'th-input th-files__root';
  const bar = document.createElement('div');
  bar.className = 'th-files__bar';
  if (!session) bar.append(rootSelect); // session: корень фиксирован; крошек в репо нет
  const content = document.createElement('div');
  content.className = 'th-repo__content';
  main.append(bar, content);

  const navigate = (nextRoot: string, nextPath: string): void => {
    location.hash = session ? srepoHash(session, nextPath) : repoHash(nextRoot, nextPath);
  };

  /** Не репозиторий → показываем папки для навигации вглубь. */
  const renderFolders = (entries: FileEntry[]): void => {
    content.replaceChildren();
    bar.hidden = false; // при навигации по папкам путь/выбор корня нужны
    const hint = document.createElement('p');
    hint.className = 'th-repo__note';
    hint.textContent = t('repo.pickFolder');
    content.append(hint);

    const list = document.createElement('div');
    list.className = 'th-files__list';
    if (curPath) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'th-files__row';
      up.innerHTML = '<span class="th-files__icon">📁</span><span class="th-files__name">..</span>';
      up.addEventListener('click', () => navigate(curRoot, parentPath(curPath)));
      list.append(up);
    }
    for (const e of entries.filter((x) => x.kind === 'dir')) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `th-files__row${e.hidden ? ' is-hidden-file' : ''}`;
      const icon = document.createElement('span');
      icon.className = 'th-files__icon';
      icon.textContent = '📁';
      const nm = document.createElement('span');
      nm.className = 'th-files__name';
      nm.textContent = e.name;
      row.append(icon, nm);
      row.addEventListener('click', () => navigate(curRoot, joinPath(curPath, e.name)));
      list.append(row);
    }
    content.append(list);
  };

  /** Репозиторий → панель: тип VCS, обновить, закоммитить, лог коммитов. */
  const renderRepo = (log: RepoLog): void => {
    content.replaceChildren();
    bar.hidden = true; // в репозитории строка пути не нужна (показываем коммиты)
    const canWrite = !transport.clientScope || transport.clientScope.write;

    const panel = document.createElement('div');
    panel.className = 'th-repo__panel';
    const badge = document.createElement('span');
    badge.className = 'th-repo__vcs';
    badge.textContent = log.vcs ?? '';
    const spacer = document.createElement('span');
    spacer.className = 'th-repo__spacer';
    // Чип текущей ветки → меню веток (переключение/создание/удаление).
    const branchChip = document.createElement('button');
    branchChip.type = 'button';
    branchChip.className = 'th-repo__branch';
    branchChip.textContent = '⑂ …';
    branchChip.disabled = true;
    panel.append(badge, branchChip, spacer);
    transport.repo<RepoBranches>('branches', { root: curRoot, path: curPath }).then(
      (data) => {
        branchChip.textContent = `⑂ ${data.current || '—'}`;
        branchChip.disabled = false;
        branchChip.addEventListener('click', () =>
          openBranchMenu(transport, curRoot, curPath, data, canWrite, () => void load()),
        );
      },
      () => {
        branchChip.textContent = '⑂ —';
      },
    );

    // ↓ pull / ↑ push — сетевые операции; результат тостом, затем перезагрузка.
    const runIo = (btn: HTMLButtonElement, action: string, okKey: string): void => {
      btn.disabled = true;
      transport.repo<void>(action, { root: curRoot, path: curPath }).then(
        () => {
          toast(t(okKey), 'info');
          void load();
        },
        (err) => {
          toast(err instanceof Error ? err.message : t('repo.error'), 'error');
          btn.disabled = false;
        },
      );
    };
    if (canWrite) {
      const pullBtn = iconButton('down', t('repo.pull'), () => runIo(pullBtn, 'pull', 'repo.pulled'));
      const pushBtn = iconButton('up', t('repo.push'), () => runIo(pushBtn, 'push', 'repo.pushed'));
      panel.append(pullBtn, pushBtn);
    }

    const refreshBtn = iconButton('refresh', t('repo.refresh'), () => void load(true)); // fetch
    refreshBtn.title = t('repo.refreshHint');
    panel.append(refreshBtn);

    if (canWrite) {
      const commitBtn = iconButton('commit', t('repo.commit'), () =>
        openCommitDialog(transport, curRoot, curPath, () => void load()),
      );
      commitBtn.classList.add('th-repo__commitbtn'); // акцентный
      panel.append(commitBtn);
    }
    content.append(panel);

    if (log.commits.length === 0) {
      const note = document.createElement('p');
      note.className = 'th-repo__note';
      note.textContent = t('repo.noCommits');
      content.append(note);
      return;
    }
    const list = document.createElement('div');
    list.className = 'th-repo__log';
    for (const commit of log.commits) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'th-repo__commit';
      const isHead = !!log.head && commit.rev === log.head;
      if (isHead) row.classList.add('is-head'); // текущий коммит рабочей копии
      const subject = document.createElement('span');
      subject.className = 'th-repo__subject';
      subject.textContent = commit.subject || '(no message)';
      const meta = document.createElement('span');
      meta.className = 'th-repo__commitmeta';
      meta.textContent = `${isHead ? `● ${t('repo.head')} · ` : ''}${commit.short} · ${commit.author} · ${fmtDate(commit.date)}`;
      row.append(subject, meta);
      row.addEventListener('click', () => openCommitModal(transport, curRoot, curPath, commit));
      list.append(row);
    }
    content.append(list);
  };

  const load = async (fetch = false): Promise<void> => {
    if (!session) lastRepoLoc = { root: curRoot, path: curPath }; // запоминаем (вне session-режима)
    content.replaceChildren(spinner());
    try {
      const log = await transport.repo<RepoLog>('log', { root: curRoot, path: curPath, fetch });
      if (stopped) return;
      if (log.vcs) {
        renderRepo(log);
      } else {
        // Не репозиторий — показываем папки для навигации к репозиторию.
        const entries = await transport.filesList(curRoot, curPath);
        if (!stopped) renderFolders(entries);
      }
    } catch (err) {
      if (stopped) return;
      content.replaceChildren();
      const p = document.createElement('p');
      p.className = 'th-repo__note';
      p.textContent = err instanceof Error ? err.message : t('repo.error');
      content.append(p);
    }
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
      const p = document.createElement('p');
      p.className = 'th-repo__note';
      p.textContent = t('files.noRoots');
      content.append(p);
      return;
    }
    if (!curRoot || !roots.includes(curRoot)) curRoot = roots[0]!;
    fillRoots(roots);
    void load();
  };

  if (session) {
    // Корень и подпуть — из пути сессии (без селектора).
    void resolveSessionPath(transport, session)
      .then((res) => {
        if (stopped) return;
        if (!res) {
          const p = document.createElement('p');
          p.className = 'th-repo__note';
          p.textContent = t('repo.error');
          content.append(p);
          return;
        }
        curRoot = res.root;
        if (sub === null) curPath = res.subpath; // по умолчанию — ровно путь сессии
        void load();
      })
      .catch(() => {
        if (!stopped) toast(t('repo.error'), 'error');
      });
  } else if (rootsCache) {
    start(rootsCache);
  } else {
    transport
      .dirs()
      .then((groups) => {
        rootsCache = groups.map((g) => g.root);
        start(rootsCache);
      })
      .catch(() => {
        if (!stopped) toast(t('repo.error'), 'error');
      });
  }

  return () => {
    stopped = true;
    teardownTop();
  };
}
