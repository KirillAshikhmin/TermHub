// Гарантия classic-совместимости service worker'а. sw.js регистрируется как
// classic (navigator.serviceWorker.register('sw.js') без { type: 'module' }),
// поэтому в собранном файле не должно остаться ни одного `import`. Vite/rollup
// инлайнит ОТНОСИТЕЛЬНЫЕ импорты в единственный sw-вход, но внешний (bare)
// специфаер или разделяемый чанк остались бы `import` в sw.js → тихий крах
// регистрации (PWA/push мертвы без сигнала). Проверка на уровне исходника (без
// зависимости от сборки): обходим граф SW от sw.ts по относительным импортам и
// требуем, чтобы КАЖДЫЙ специфаер был относительным (инлайнится), а не внешним.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const ENTRY = new URL('../src/sw.ts', import.meta.url);

// Статические import/export-from, bare-import и динамический import() — всё, что
// в собранном classic-воркере превратилось бы в недопустимый `import`.
const SPEC_RE = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Все специфаеры импорта/экспорта из файла. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) out.push(spec);
  }
  return out;
}

describe('service worker остаётся classic-совместимым', () => {
  it('в графе sw.ts нет внешних (bare) импортов — только инлайнируемые относительные', () => {
    const visited = new Set<string>();
    const external: string[] = [];
    const queue: URL[] = [ENTRY];

    while (queue.length) {
      const url = queue.shift()!;
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      const source = fs.readFileSync(url, 'utf8');
      for (const spec of specifiers(source)) {
        if (spec.startsWith('.')) {
          // Относительный — инлайнится в sw.js; идём по нему дальше (.ts-модуль).
          queue.push(new URL(spec.endsWith('.ts') ? spec : `${spec}.ts`, url));
        } else {
          // Внешний/пакетный/абсолютный — остался бы `import` в classic sw.js.
          external.push(spec);
        }
      }
    }

    expect(external).toEqual([]);
    // Санити: граф действительно обошёлся (sw.ts + его локальные модули).
    expect(visited.size).toBeGreaterThan(1);
  });
});
