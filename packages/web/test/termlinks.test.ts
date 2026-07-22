import { describe, expect, it } from 'vitest';
import { detectPaths, filePathParts, filesTargetForPath, parentRel } from '../src/termlinks';

describe('detectPaths', () => {
  it('находит абсолютный путь и его диапазон', () => {
    const line = 'см. /Users/me/proj/app/x.ts готово';
    const m = detectPaths(line);
    expect(m).toHaveLength(1);
    expect(m[0]!.path).toBe('/Users/me/proj/app/x.ts');
    expect(line.slice(m[0]!.index, m[0]!.index + m[0]!.length)).toBe('/Users/me/proj/app/x.ts');
  });

  it('не ловит хвост URL', () => {
    expect(detectPaths('open http://host.tld/a/b now')).toHaveLength(0);
  });

  it('несколько путей в строке', () => {
    const m = detectPaths('/a/b and /c/d/e');
    expect(m.map((x) => x.path)).toEqual(['/a/b', '/c/d/e']);
  });

  it('не ловит «слово/слово» и «2/3»', () => {
    expect(detectPaths('text 2/3 and/or done')).toHaveLength(0);
  });

  it('находит относительные с расширением и ./ ../', () => {
    expect(detectPaths('см. docs/specs/foo.md').map((x) => x.path)).toEqual(['docs/specs/foo.md']);
    expect(detectPaths('run ./build.sh now').map((x) => x.path)).toEqual(['./build.sh']);
    expect(detectPaths('../lib/x.ts here').map((x) => x.path)).toEqual(['../lib/x.ts']);
  });

  it('не ловит относительное без расширения (docs/specs)', () => {
    expect(detectPaths('open docs/specs dir')).toHaveLength(0);
  });
});

describe('filesTargetForPath', () => {
  const roots = ['/Users/me/projects', '/Users/me/projects/Sprut'];

  it('файл маппится на родительскую папку под самым длинным корнем', () => {
    expect(filesTargetForPath('/Users/me/projects/Sprut/app/main.ts', roots)).toBe(
      `#/files/${encodeURIComponent('/Users/me/projects/Sprut')}/${encodeURIComponent('app')}`,
    );
  });

  it('файл прямо в корне → листинг корня', () => {
    expect(filesTargetForPath('/Users/me/projects/readme.md', roots)).toBe(
      `#/files/${encodeURIComponent('/Users/me/projects')}/`,
    );
  });

  it('клик по самому корню → листинг корня', () => {
    expect(filesTargetForPath('/Users/me/projects', roots)).toBe(
      `#/files/${encodeURIComponent('/Users/me/projects')}/`,
    );
  });

  it('путь вне всех корней → null', () => {
    expect(filesTargetForPath('/etc/hosts', roots)).toBeNull();
  });

  it('относительный путь резолвится от cwd (в родительскую папку)', () => {
    const cwd = '/Users/me/projects/TermHub';
    expect(filesTargetForPath('docs/specs/foo.md', roots, cwd)).toBe(
      `#/files/${encodeURIComponent('/Users/me/projects')}/${encodeURIComponent('TermHub/docs/specs')}`,
    );
  });

  it('относительный ../ схлопывается и мапится на корень', () => {
    const cwd = '/Users/me/projects/TermHub';
    expect(filesTargetForPath('../Sprut/app.ts', roots, cwd)).toBe(
      `#/files/${encodeURIComponent('/Users/me/projects/Sprut')}/`,
    );
  });

  it('относительный путь без cwd → null', () => {
    expect(filesTargetForPath('docs/foo.md', roots)).toBeNull();
  });
});

describe('filePathParts / parentRel', () => {
  const roots = ['/Users/me/projects', '/Users/me/projects/Sprut'];

  it('путь под самым длинным корнем → {root, rel=полный путь}', () => {
    expect(filePathParts('/Users/me/projects/Sprut/app/main.ts', roots)).toEqual({
      root: '/Users/me/projects/Sprut',
      rel: 'app/main.ts',
    });
  });

  it('файл прямо в корне → rel = имя файла', () => {
    expect(filePathParts('/Users/me/projects/readme.md', roots)).toEqual({
      root: '/Users/me/projects',
      rel: 'readme.md',
    });
  });

  it('путь вне корней → null', () => {
    expect(filePathParts('/etc/hosts', roots)).toBeNull();
  });

  it('относительный резолвится от cwd (rel полный)', () => {
    expect(filePathParts('docs/x.md', roots, '/Users/me/projects/TermHub')).toEqual({
      root: '/Users/me/projects',
      rel: 'TermHub/docs/x.md',
    });
  });

  it('parentRel — родительская папка', () => {
    expect(parentRel('app/main.ts')).toBe('app');
    expect(parentRel('readme.md')).toBe('');
  });
});
