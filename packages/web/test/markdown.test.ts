// @vitest-environment happy-dom
// Разметка ответа агента: что из markdown рисуется узлами DOM и, главное, что
// НЕ становится элементом. Текст беседы — чужой транскрипт, поэтому первым идёт
// не заголовок, а строка, похожая на HTML: она обязана остаться строкой.
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../src/markdown';

/** Корень с нарисованной разметкой — как его собирает лента. */
function render(text: string): HTMLElement {
  const box = document.createElement('div');
  box.append(renderMarkdown(text));
  return box;
}

describe('чужой текст не становится разметкой', () => {
  it('тег из беседы остаётся видимой строкой, а не элементом', () => {
    const box = render('Он написал <img onerror=alert(1) src=x> и ушёл');

    expect(box.querySelector('img')).toBeNull();
    expect(box.textContent).toContain('<img onerror=alert(1) src=x>');
  });

  it('скрипт внутри блока кода остаётся текстом блока', () => {
    const box = render('```\n<script>alert(1)</script>\n```');

    expect(box.querySelector('script')).toBeNull();
    expect(box.querySelector('code')?.textContent).toBe('<script>alert(1)</script>\n');
  });

  it('сущности HTML не раскрываются: &lt;b&gt; так и написано', () => {
    const box = render('&lt;b&gt;жирный&lt;/b&gt;');

    expect(box.querySelector('b')).toBeNull();
    expect(box.textContent).toBe('&lt;b&gt;жирный&lt;/b&gt;');
  });

  it('ссылка на javascript: не получает href — остаётся текстом', () => {
    const box = render('[жми](javascript:alert(1))');

    expect(box.querySelector('a')).toBeNull();
    expect(box.textContent).toContain('жми');
  });
});

describe('заголовки', () => {
  it('«## Готово» рисуется заголовком, решётки в текст не попадают', () => {
    const box = render('## Готово');

    const h = box.querySelector('h2');
    expect(h).not.toBeNull();
    expect(h!.textContent).toBe('Готово');
    expect(box.textContent).not.toContain('#');
  });

  it('уровень берётся из числа решёток', () => {
    const box = render('# раз\n\n#### четыре');

    expect(box.querySelector('h1')?.textContent).toBe('раз');
    expect(box.querySelector('h4')?.textContent).toBe('четыре');
  });
});

describe('выделение в строке', () => {
  it('**вкладка «Лента»** становится жирной без звёздочек', () => {
    const box = render('открой **вкладку «Лента»** и смотри');

    expect(box.querySelector('strong')?.textContent).toBe('вкладку «Лента»');
    expect(box.textContent).toBe('открой вкладку «Лента» и смотри');
  });

  it('одиночные звёздочки дают курсив', () => {
    const box = render('это *важно*');

    expect(box.querySelector('em')?.textContent).toBe('важно');
  });

  it('`code` в строке рисуется моноширинным, кавычки-обратные не видны', () => {
    const box = render('правь `feed.ts` рядом');

    expect(box.querySelector('code')?.textContent).toBe('feed.ts');
    expect(box.textContent).toBe('правь feed.ts рядом');
  });

  it('звёздочка посреди слова не рвёт текст на курсив', () => {
    const box = render('2*3*4 = 24');

    expect(box.querySelector('em')).toBeNull();
    expect(box.textContent).toBe('2*3*4 = 24');
  });
});

describe('ссылки', () => {
  it('[текст](url) становится ссылкой с href', () => {
    const box = render('см. [тикет](https://example.org/t/5)');

    const a = box.querySelector('a');
    expect(a?.textContent).toBe('тикет');
    expect(a?.getAttribute('href')).toBe('https://example.org/t/5');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });

  it('голый https-адрес тоже становится ссылкой', () => {
    const box = render('открой https://localhost:7710/ и жди');

    expect(box.querySelector('a')?.getAttribute('href')).toBe('https://localhost:7710/');
  });
});

describe('списки', () => {
  it('маркированный список — ul с пунктами, дефисы не видны', () => {
    const box = render('- раз\n- два\n- три');

    const items = [...box.querySelectorAll('ul > li')].map((li) => li.textContent);
    expect(items).toEqual(['раз', 'два', 'три']);
  });

  it('нумерованный список — ol', () => {
    const box = render('1. раз\n2. два');

    expect(box.querySelectorAll('ol > li')).toHaveLength(2);
  });

  it('вложенный список лежит внутри своего пункта, а не рядом', () => {
    const box = render('- верх\n  - низ');

    const outer = box.querySelector('ul > li');
    expect(outer?.querySelector('ul > li')?.textContent).toBe('низ');
  });
});

describe('таблицы', () => {
  it('| Что | Почему | рисуется таблицей с шапкой, палки не видны', () => {
    const box = render('| Что | Почему |\n| --- | --- |\n| лента | читают |\n| терминал | смотрят |');

    const table = box.querySelector('table');
    expect(table).not.toBeNull();
    expect([...table!.querySelectorAll('thead th')].map((c) => c.textContent)).toEqual(['Что', 'Почему']);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(box.textContent).not.toContain('|');
  });

  it('таблица без строки-разделителя остаётся текстом', () => {
    const box = render('| просто | палки |');

    expect(box.querySelector('table')).toBeNull();
    expect(box.textContent).toContain('| просто | палки |');
  });
});

describe('цитаты и линии', () => {
  it('> цитата становится blockquote без угловой скобки', () => {
    const box = render('> он сказал так');

    expect(box.querySelector('blockquote')?.textContent).toBe('он сказал так');
  });

  it('--- на своей строке становится линией', () => {
    const box = render('до\n\n---\n\nпосле');

    expect(box.querySelector('hr')).not.toBeNull();
  });
});

describe('блок кода', () => {
  it('огороженный блок — pre > code, язык уезжает в класс', () => {
    const box = render('```ts\nconst a = 1;\n```');

    const code = box.querySelector('pre > code');
    expect(code?.textContent).toBe('const a = 1;\n');
    expect(code?.className).toContain('language-ts');
  });

  it('незакрытый блок кода дочитывается до конца текста, а не теряется', () => {
    const box = render('```\nостаток беседы');

    expect(box.querySelector('pre > code')?.textContent).toBe('остаток беседы');
  });
});

describe('обычный текст', () => {
  it('абзацы разделены пустой строкой, перевод строки внутри абзаца сохраняется', () => {
    const box = render('первый\nс переносом\n\nвторой');

    const ps = [...box.querySelectorAll('p')];
    expect(ps).toHaveLength(2);
    expect(ps[0]!.textContent).toBe('первый\nс переносом');
    expect(ps[1]!.textContent).toBe('второй');
  });
});

/** Ждёт ленивый чанк подсветки: он приезжает динамическим import, а не синхронно. */
async function settled(code: Element): Promise<void> {
  for (let i = 0; i < 200 && !code.classList.contains('hljs'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('подсветка блока кода', () => {
  it('приезжает ленивым чанком: сначала простой текст, потом раскрашенные узлы', async () => {
    const box = render('```ts\nconst a = 1;\n```');
    const code = box.querySelector('pre > code')!;
    expect(code.querySelector('span')).toBeNull();

    await settled(code);

    expect(code.querySelector('.hljs-keyword')?.textContent).toBe('const');
    expect(code.textContent).toBe('const a = 1;\n');
  });

  it('строка кода, похожая на разметку, после подсветки остаётся текстом', async () => {
    // Здесь дыра и была бы: вывод highlight.js — HTML-строка, и присвоить её через
    // innerHTML значит впустить в ленту то, что агент всего лишь процитировал.
    const box = render('```ts\nconst s = "</span><img src=x onerror=alert(1)>";\n```');
    const code = box.querySelector('pre > code')!;

    await settled(code);

    expect(code.querySelector('img')).toBeNull();
    expect(code.textContent).toContain('</span><img src=x onerror=alert(1)>');
  });
});

describe('амперсанд в подсвеченном коде', () => {
  it('возвращается ровно таким, каким его написали, — без второго разворота', () => {
    // Вывод hljs экранирован: `&` в исходнике становится `&amp;`, а уже написанное
    // `&lt;` — `&amp;lt;`. Разворачивать его надо один раз: второй проход превратил
    // бы `&amp;lt;` в `<` и тихо испортил бы чужой код в ленте.
    const source = 'const ok = a && b; const tag = "&lt;div&gt;"; const amp = "&amp;";';
    const box = render('```ts\n' + source + '\n```');
    const code = box.querySelector('pre > code')!;

    return settled(code).then(() => {
      expect(code.classList.contains('hljs')).toBe(true);
      expect(code.textContent).toBe(source + '\n');
    });
  });
});
