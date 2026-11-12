// @vitest-environment happy-dom
// Оформление сообщений чата поверх markdown.ts: кликабельные пути и копирование кода.
// Ожидания — руками: какие ссылки и какой текст должны получиться на данном входе.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLang } from '../src/i18n';
import { copyButtonFor, linkifyPaths, renderChatMarkdown, type PathLinker } from '../src/chat-render';

setLang('ru');

const linker = (roots: string[], sessionRoot = ''): PathLinker => ({
  target: (path) => {
    const hit = roots.find((r) => path === r || path.startsWith(`${r}/`));
    if (!hit) return null;
    return `#/files/${encodeURIComponent(hit)}/${sessionRoot === hit ? 'S' : ''}`;
  },
});

function host(frag: DocumentFragment): HTMLElement {
  const div = document.createElement('div');
  div.append(frag);
  return div;
}

afterEach(() => vi.unstubAllGlobals());

describe('пути в тексте', () => {
  it('путь внутри корня становится ссылкой на проводник, вне корня — остаётся текстом', () => {
    const el = host(renderChatMarkdown('Правка в /root/a/src/main.ts и ещё /etc/hosts.', linker(['/root/a'])));
    const links = [...el.querySelectorAll<HTMLAnchorElement>('a.th-path')];
    expect(links.map((a) => a.textContent)).toEqual(['/root/a/src/main.ts']);
    expect(links[0]!.getAttribute('href')).toBe(`#/files/${encodeURIComponent('/root/a')}/`);
    expect(el.textContent).toContain('/etc/hosts');
    expect(el.querySelectorAll('a').length).toBe(1);
  });

  it('путь в инлайн-коде тоже ссылка; в блоке кода — нет', () => {
    const el = host(renderChatMarkdown('Смотри `/root/a/x.ts`\n\n```\n/root/a/y.ts\n```', linker(['/root/a'])));
    expect([...el.querySelectorAll('a.th-path')].map((a) => a.textContent)).toEqual(['/root/a/x.ts']);
  });

  it('без linker (гость без files) — обычный текст, https-ссылки продолжают работать', () => {
    const el = host(renderChatMarkdown('/root/a/x.ts и https://example.com/p', null));
    expect(el.querySelector('a.th-path')).toBeNull();
    const a = el.querySelector<HTMLAnchorElement>('a.th-md__link')!;
    expect(a.href).toBe('https://example.com/p');
    expect(a.target).toBe('_blank');
  });

  it('путь внутри уже готовой ссылки не трогается; повторный проход ничего не дублирует', () => {
    const el = host(renderChatMarkdown('[/root/a/x.ts](https://e.com/root/a/x.ts) и /root/a/z.ts', linker(['/root/a'])));
    linkifyPaths(el, linker(['/root/a']));
    linkifyPaths(el, linker(['/root/a']));
    expect(el.querySelectorAll('a.th-path').length).toBe(1);
    expect(el.querySelectorAll('a').length).toBe(2);
  });

  it('относительный путь с cwd сессии: цель решает linker', () => {
    const rel: PathLinker = { target: (p) => (p === './src/a.ts' ? '#/sfiles/s/src' : null) };
    const el = host(renderChatMarkdown('см. ./src/a.ts', rel));
    expect(el.querySelector('a.th-path')!.getAttribute('href')).toBe('#/sfiles/s/src');
  });
});

describe('устойчивость разметки', () => {
  it('недописанный блок кода остаётся кодом и не съедает соседей: каждое сообщение рисуется само', () => {
    const cut = host(renderChatMarkdown('Вот:\n```ts\nconst a = 1;', null));
    expect(cut.querySelector('pre code')!.textContent).toContain('const a = 1;');
    const next = host(renderChatMarkdown('# Следующее\n\n- один', null));
    expect(next.querySelector('h1')!.textContent).toBe('Следующее');
    expect(next.querySelector('li')!.textContent).toBe('один');
  });

  it('html из текста остаётся текстом', () => {
    const el = host(renderChatMarkdown('<img src=x onerror=alert(1)>', null));
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img');
  });
});

describe('копирование кода', () => {
  it('у блока кода есть кнопка; нажатие кладёт в буфер весь код', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const el = host(renderChatMarkdown('```sh\nnpm test\n```', null));
    const btn = el.querySelector<HTMLButtonElement>('pre button.th-md__copy')!;
    expect(btn).not.toBeNull();
    btn.click();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('npm test\n');
  });

  it('copyButtonFor без буфера (небезопасный контекст) не падает', async () => {
    vi.stubGlobal('navigator', {});
    const pre = document.createElement('pre');
    pre.textContent = 'x';
    const btn = copyButtonFor(pre);
    expect(() => btn.click()).not.toThrow();
  });
});

describe('ссылка markdown на локальный файл', () => {
  it('абсолютный путь в корне: на экране название, ведёт в проводник; скобок и пути нет', () => {
    const el = host(renderChatMarkdown('Задано по требованию [навык](/root/a/skills/demo/SKILL.md).', linker(['/root/a'])));
    const a = el.querySelector<HTMLAnchorElement>('a.th-path')!;
    expect(a.textContent).toBe('навык');
    expect(a.getAttribute('href')).toBe(`#/files/${encodeURIComponent('/root/a')}/`);
    expect(a.hasAttribute('target')).toBe(false);
    expect(el.textContent).toBe('Задано по требованию навык.');
  });

  it('относительный путь: цель решает linker, название остаётся названием', () => {
    const seen: string[] = [];
    const rel: PathLinker = { target: (path) => (seen.push(path), path === 'docs/guide.md' ? '#/sfiles/work/docs/guide.md' : null) };
    const el = host(renderChatMarkdown('См. [руководство](docs/guide.md)', rel));
    const a = el.querySelector<HTMLAnchorElement>('a.th-path')!;
    expect(a.textContent).toBe('руководство');
    expect(a.getAttribute('href')).toBe('#/sfiles/work/docs/guide.md');
    expect(seen).toContain('docs/guide.md');
  });

  it('путь вне корней и гость без права: название текстом, без ссылки и без сырой разметки', () => {
    for (const l of [linker(['/root/a']), null]) {
      const el = host(renderChatMarkdown('Файл [заметки](/etc/notes.md) рядом', l));
      expect(el.querySelectorAll('a').length).toBe(0);
      expect(el.textContent).toBe('Файл заметки рядом');
    }
  });

  it('корни приехали позже: повторный проход делает название ссылкой', () => {
    let roots: string[] = [];
    const late: PathLinker = { target: (path) => (roots.some((r) => path.startsWith(`${r}/`)) ? '#/files/x' : null) };
    const el = host(renderChatMarkdown('[план](/root/a/plan.md)', late));
    expect(el.querySelectorAll('a').length).toBe(0);
    roots = ['/root/a'];
    linkifyPaths(el, late);
    linkifyPaths(el, late);
    expect([...el.querySelectorAll('a.th-path')].map((a) => a.textContent)).toEqual(['план']);
  });

  it('небезопасные схемы остаются текстом как были; https работает как раньше', () => {
    const all: PathLinker = { target: () => '#/files/any' };
    const el = host(
      renderChatMarkdown('[a](javascript:alert(1)) [b](data:text/html,x) [c](vbscript:x) [d](file:///etc/passwd) [e](//evil.example/x) [сайт](https://example.com/p)', all),
    );
    const links = [...el.querySelectorAll<HTMLAnchorElement>('a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href'), a.target])).toEqual([['сайт', 'https://example.com/p', '_blank']]);
    expect(el.textContent).toContain('[a](javascript:alert(1))');
    expect(el.textContent).toContain('[b](data:text/html,x)');
    expect(el.textContent).toContain('[e](//evil.example/x)');
  });
});
