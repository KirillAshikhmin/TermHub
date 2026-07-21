// Контекстное меню файла/папки в проводнике: Копировать в / Переместить в /
// Переименовать / Удалить / Свойства. Мутации — через transport.fileOp (оба режима,
// требуют право записи). «Свойства» — попап с метаданными (statFull).

import { t } from './i18n';
import { formatDate, formatSize } from './format';
import { iconButton, openModal, spinner, toast } from './ui';
import type { FileInfo } from '@termhub/protocol';
import type { DirGroup, FileEntry, Transport } from './transport';

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}
function parentPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Скачивание файла: LAN — прямой линк (браузер сам качает, со своим прогрессом),
 *  relay — blob чанками с прогресс-оверлеем (прямого URL у relay нет). */
export function streamDownload(transport: Transport, root: string, filePath: string, name: string): void {
  const save = (href: string, revoke?: boolean): void => {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    a.click();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10_000);
  };
  const direct = transport.downloadUrl(root, filePath);
  if (direct) {
    save(direct);
    return;
  }
  const prog = showDownloadProgress(name);
  transport.fileBlob(root, filePath, (frac) => prog.set(frac)).then(
    (blob) => {
      prog.done();
      save(URL.createObjectURL(blob), true);
    },
    (err) => {
      prog.done();
      toast(err instanceof Error ? err.message : t('files.error'), 'error');
    },
  );
}

/** Плавающий индикатор прогресса скачивания (relay-режим, где blob тянется чанками). */
function showDownloadProgress(name: string): { set: (frac: number) => void; done: () => void } {
  const box = document.createElement('div');
  box.className = 'th-dlprog';
  const label = document.createElement('div');
  label.className = 'th-dlprog__label';
  label.textContent = t('files.downloading', { name });
  const track = document.createElement('div');
  track.className = 'th-dlprog__track';
  const bar = document.createElement('div');
  bar.className = 'th-dlprog__bar';
  track.append(bar);
  box.append(label, track);
  document.body.append(box);
  return {
    set: (frac: number) => {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
    },
    done: () => box.remove(),
  };
}

// ── Открытие в NotAText (инлайн-ссылка: контент зашит в hash, без сервера) ──
const NOTATEXT_ORIGIN = 'https://notatext.ru/';
const NOTA_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript',
  py: 'python', java: 'java', kt: 'kotlin', swift: 'swift', go: 'go', rs: 'rust', rb: 'ruby',
  php: 'php', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', sql: 'sql',
  sh: 'shell', bash: 'shell', zsh: 'shell', lua: 'lua', pl: 'perl', dart: 'dart', scala: 'scala',
  gradle: 'gradle', html: 'html', css: 'css', vue: 'vue', svelte: 'svelte', dockerfile: 'dockerfile',
  toml: 'toml',
};
const NOTA_FMT: Record<string, string> = {
  md: 'md', markdown: 'md', json: 'json', yaml: 'yaml', yml: 'yaml', csv: 'csv', log: 'log',
  xml: 'xml', svg: 'xml', properties: 'properties', ini: 'properties', conf: 'properties',
  wiki: 'wiki', fb2: 'fb2',
};

/** fmt (+lang для кода) по расширению имени. */
function notaFmt(name: string): { fmt: string; lang?: string } {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (NOTA_FMT[ext]) return { fmt: NOTA_FMT[ext] };
  return { fmt: 'code', lang: NOTA_LANG[ext] };
}

/** Инлайн-ссылка NotAText: base64url(gzip(UTF-8(text))) в hash. */
async function notaInlineLink(text: string, name: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const cs = new CompressionStream('gzip');
  const buf = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  const d = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const { fmt, lang } = notaFmt(name);
  const p = new URLSearchParams({ nt: '1', fmt, c: '1', d });
  if (fmt === 'code' && lang) p.set('lang', lang);
  return `${NOTATEXT_ORIGIN}#${p.toString()}`;
}

/** Навигация предоткрытой вкладки на ссылку NotAText (вкладку открываем синхронно в
 *  обработчике клика — иначе popup-блокер зарубит открытие после await). */
async function notaNavigate(win: Window | null, text: string, name: string): Promise<void> {
  const url = await notaInlineLink(text, name);
  if (win) win.location.href = url;
  else window.open(url, '_blank', 'noopener');
}

/** Открыть уже загруженный текст в NotAText (из превью). */
export function openTextInNotaText(text: string, name: string): void {
  void notaNavigate(window.open('about:blank', '_blank'), text, name);
}

/** Открыть файл в NotAText из меню: тянем содержимое, затем открываем инлайн-ссылку. */
export function openInNotaText(transport: Transport, root: string, path: string, name: string): void {
  const win = window.open('about:blank', '_blank'); // синхронно в жесте — обход popup-блока
  transport.fileRead(root, path).then(
    (c) => {
      if (c.truncated || c.kind !== 'text' || c.size > 1_500_000) {
        win?.close();
        toast(t('files.notaOnlyText'), 'error');
        return;
      }
      void notaNavigate(win, c.data, name);
    },
    (err) => {
      win?.close();
      toast(err instanceof Error ? err.message : t('files.error'), 'error');
    },
  );
}

interface RowCtx {
  transport: Transport;
  root: string;
  path: string; // полный подпуть элемента (curPath + '/' + name)
  name: string;
  onDone: () => void;
}

function sheetItem(label: string, opts: { danger?: boolean; onClick: () => void }): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `th-sheet__item${opts.danger ? ' is-danger' : ''}`;
  b.textContent = label;
  b.addEventListener('click', opts.onClick);
  return b;
}

function sheetHead(titleText: string, close: () => void): HTMLElement {
  const head = document.createElement('div');
  head.className = 'th-sheet__head';
  const title = document.createElement('div');
  title.className = 'th-sheet__title';
  title.textContent = titleText;
  head.append(title, iconButton('close', t('common.close'), close));
  return head;
}

/** Контекстное меню строки (файл/папка). canWrite — показывать мутации. */
export function openRowMenu(opts: {
  transport: Transport;
  root: string;
  path: string;
  entry: FileEntry;
  canWrite: boolean;
  onDone: () => void;
}): void {
  const ctx: RowCtx = {
    transport: opts.transport,
    root: opts.root,
    path: opts.path,
    name: opts.entry.name,
    onDone: opts.onDone,
  };
  // dismiss — тихое закрытие меню (без history.back), чтобы открыть под-окно без
  // гонки popstate (иначе оно закрывалось само через ~секунду).
  let dismiss = (): void => {};
  dismiss = openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-sheet';
    box.append(sheetHead(opts.entry.name, close));
    if (opts.canWrite) {
      box.append(
        sheetItem(t('files.copyTo'), {
          onClick: () => {
            dismiss();
            openDestPicker(ctx, 'copy');
          },
        }),
        sheetItem(t('files.moveTo'), {
          onClick: () => {
            dismiss();
            openDestPicker(ctx, 'move');
          },
        }),
        sheetItem(t('files.rename'), {
          onClick: () => {
            dismiss();
            openRename(ctx);
          },
        }),
        sheetItem(t('files.delete'), {
          danger: true,
          onClick: () => {
            dismiss();
            void doDelete(ctx);
          },
        }),
      );
    }
    box.append(
      sheetItem(t('files.properties'), {
        onClick: () => {
          dismiss();
          openProperties(ctx);
        },
      }),
    );
    if (opts.entry.kind === 'file') {
      box.append(
        sheetItem(t('files.download'), {
          onClick: () => {
            dismiss();
            streamDownload(ctx.transport, ctx.root, ctx.path, ctx.name);
          },
        }),
        sheetItem(t('files.openNota'), {
          onClick: () => {
            dismiss();
            openInNotaText(ctx.transport, ctx.root, ctx.path, ctx.name);
          },
        }),
      );
    }
    return box;
  });
}

async function doDelete(ctx: RowCtx): Promise<void> {
  if (!confirm(t('files.confirmDelete', { name: ctx.name }))) return;
  try {
    await ctx.transport.fileOp('remove', { root: ctx.root, path: ctx.path });
    toast(t('files.deleted'), 'info');
    ctx.onDone();
  } catch (err) {
    toast(err instanceof Error ? err.message : t('files.error'), 'error');
  }
}

function openRename(ctx: RowCtx): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-sheet';
    box.append(sheetHead(t('files.rename'), close));

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'th-input th-sheet__input';
    input.value = ctx.name;
    input.autocomplete = 'off';

    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'th-btn th-btn--primary';
    submit.textContent = t('files.rename');

    const run = async (): Promise<void> => {
      const next = input.value.trim();
      if (!next || next === ctx.name) {
        close();
        return;
      }
      if (next.includes('/')) {
        toast(t('files.badName'), 'error');
        return;
      }
      submit.disabled = true;
      try {
        const dest = joinPath(parentPath(ctx.path), next);
        await ctx.transport.fileOp('move', { root: ctx.root, path: ctx.path, destRoot: ctx.root, dest });
        close();
        toast(t('files.renamed'), 'info');
        ctx.onDone();
      } catch (err) {
        submit.disabled = false;
        toast(err instanceof Error ? err.message : t('files.error'), 'error');
      }
    };
    submit.addEventListener('click', () => void run());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void run();
    });

    const foot = document.createElement('div');
    foot.className = 'th-sheet__foot';
    foot.append(submit);
    box.append(input, foot);
    setTimeout(() => input.focus(), 0);
    return box;
  });
}

/** Свойства: метаданные (имя, полный путь, размер, права, даты). */
function openProperties(ctx: RowCtx): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-sheet th-props';
    box.append(sheetHead(t('files.properties'), close));
    const body = document.createElement('div');
    body.className = 'th-props__body';
    body.append(spinner());
    box.append(body);

    ctx.transport.fileOp<FileInfo>('stat-full', { root: ctx.root, path: ctx.path }).then(
      (info) => {
        body.replaceChildren();
        const rows: Array<[string, string]> = [
          [t('files.propName'), info.name],
          [t('files.propKind'), info.kind === 'dir' ? t('files.kindDir') : t('files.kindFile')],
          [t('files.propPath'), info.path],
          [t('files.propSize'), formatSize(info.size)],
          [t('files.propMode'), info.mode],
          [t('files.propCreated'), formatDate(info.birthtime)],
          [t('files.propModified'), formatDate(info.mtime)],
          [t('files.propChanged'), formatDate(info.ctime)],
          [t('files.propAccessed'), formatDate(info.atime)],
        ];
        for (const [label, value] of rows) {
          const row = document.createElement('div');
          row.className = 'th-props__row';
          const k = document.createElement('span');
          k.className = 'th-props__key';
          k.textContent = label;
          const v = document.createElement('span');
          v.className = 'th-props__val';
          v.textContent = value;
          row.append(k, v);
          body.append(row);
        }
      },
      (err) => {
        body.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-sheet__note';
        p.textContent = err instanceof Error ? err.message : t('files.error');
        body.append(p);
      },
    );
    return box;
  });
}

/** Выбор папки назначения (навигация по корням/папкам) для копирования/перемещения. */
function openDestPicker(ctx: RowCtx, mode: 'copy' | 'move'): void {
  openModal((close) => {
    const box = document.createElement('div');
    box.className = 'th-sheet th-destpick';
    box.append(sheetHead(mode === 'copy' ? t('files.copyTo') : t('files.moveTo'), close));

    let destRoot = ctx.root;
    let destPath = parentPath(ctx.path); // стартуем в текущей папке источника

    const rootSelect = document.createElement('select');
    rootSelect.className = 'th-input th-files__root';
    const crumbs = document.createElement('div');
    crumbs.className = 'th-files__crumbs';
    const bar = document.createElement('div');
    bar.className = 'th-files__bar';
    bar.append(rootSelect, crumbs);
    const list = document.createElement('div');
    list.className = 'th-files__list th-destpick__list';
    box.append(bar, list);

    const pickBtn = document.createElement('button');
    pickBtn.type = 'button';
    pickBtn.className = 'th-btn th-btn--primary';
    pickBtn.textContent = t('files.pickHere');
    const foot = document.createElement('div');
    foot.className = 'th-sheet__foot';
    foot.append(pickBtn);
    box.append(foot);

    const renderCrumbs = (): void => {
      crumbs.replaceChildren();
      const mk = (label: string, target: string): HTMLElement => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'th-files__crumb';
        b.textContent = label;
        b.addEventListener('click', () => {
          destPath = target;
          void load();
        });
        return b;
      };
      crumbs.append(mk('/', ''));
      let acc = '';
      for (const p of destPath ? destPath.split('/') : []) {
        acc = joinPath(acc, p);
        crumbs.append(mk(p, acc));
      }
    };

    const load = async (): Promise<void> => {
      renderCrumbs();
      list.replaceChildren(spinner());
      try {
        const entries = await ctx.transport.filesList(destRoot, destPath);
        list.replaceChildren();
        if (destPath) {
          const up = document.createElement('button');
          up.type = 'button';
          up.className = 'th-files__row';
          up.innerHTML = '<span class="th-files__icon">📁</span><span class="th-files__name">..</span>';
          up.addEventListener('click', () => {
            destPath = parentPath(destPath);
            void load();
          });
          list.append(up);
        }
        for (const e of entries.filter((x) => x.kind === 'dir')) {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'th-files__row';
          const icon = document.createElement('span');
          icon.className = 'th-files__icon';
          icon.textContent = '📁';
          const nm = document.createElement('span');
          nm.className = 'th-files__name';
          nm.textContent = e.name;
          row.append(icon, nm);
          row.addEventListener('click', () => {
            destPath = joinPath(destPath, e.name);
            void load();
          });
          list.append(row);
        }
      } catch (err) {
        list.replaceChildren();
        const p = document.createElement('p');
        p.className = 'th-sheet__note';
        p.textContent = err instanceof Error ? err.message : t('files.error');
        list.append(p);
      }
    };

    pickBtn.addEventListener('click', () => {
      pickBtn.disabled = true;
      const dest = joinPath(destPath, ctx.name);
      ctx.transport.fileOp(mode, { root: ctx.root, path: ctx.path, destRoot, dest }).then(
        () => {
          close();
          toast(mode === 'copy' ? t('files.copied') : t('files.moved'), 'info');
          ctx.onDone();
        },
        (err) => {
          pickBtn.disabled = false;
          toast(err instanceof Error ? err.message : t('files.error'), 'error');
        },
      );
    });

    rootSelect.addEventListener('change', () => {
      destRoot = rootSelect.value;
      destPath = '';
      void load();
    });

    void ctx.transport.dirs().then((groups: DirGroup[]) => {
      const roots = groups.map((g) => g.root);
      rootSelect.replaceChildren(
        ...roots.map((r) => {
          const o = document.createElement('option');
          o.value = r;
          o.textContent = r;
          if (r === destRoot) o.selected = true;
          return o;
        }),
      );
      if (!roots.includes(destRoot)) {
        destRoot = roots[0] ?? ctx.root;
        destPath = '';
      }
      void load();
    });

    return box;
  });
}
