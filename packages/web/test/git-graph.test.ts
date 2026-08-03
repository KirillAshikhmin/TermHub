import { describe, expect, it } from 'vitest';

import { layoutGraph } from '../src/git-graph';

const c = (rev: string, ...parents: string[]): { rev: string; parents: string[] } => ({ rev, parents });

describe('layoutGraph', () => {
  it('линейная история идёт одной дорожкой', () => {
    const { rows, width } = layoutGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(width).toBe(1);
    expect(rows.every((r) => !r.merge)).toBe(true);
  });

  it('слияние помечено и сводит две дорожки в одну точку', () => {
    // m — слияние feature (f) в main (b); оба родителя в выборке.
    const { rows, width } = layoutGraph([c('m', 'b', 'f'), c('b', 'a'), c('f', 'a'), c('a')]);
    const byRev = Object.fromEntries(rows.map((r) => [r.rev, r]));
    expect(byRev.m!.merge).toBe(true);
    expect(width).toBeGreaterThanOrEqual(2);
    // Из точки слияния выходят две линии — к обоим родителям.
    expect(byRev.m!.edges.filter((e) => e.from === byRev.m!.lane).length).toBe(2);
    // Ветки лежат в разных колонках, иначе линии наложились бы.
    expect(byRev.b!.lane).not.toBe(byRev.f!.lane);
  });

  it('первый родитель наследует дорожку — линия ветки не прыгает вбок', () => {
    const { rows } = layoutGraph([c('m', 'b', 'f'), c('b', 'a'), c('f', 'a'), c('a')]);
    const byRev = Object.fromEntries(rows.map((r) => [r.rev, r]));
    expect(byRev.b!.lane).toBe(byRev.m!.lane);
  });

  it('оборванные родители (лог обрезан лимитом) не тянут линию в никуда', () => {
    // Родителя 'old' в выборке нет — дорожка обязана закрыться.
    const { rows, width } = layoutGraph([c('b', 'old'), c('a', 'old')]);
    expect(width).toBe(1);
    expect(rows[0]!.edges).toEqual([]);
    expect(rows[1]!.edges).toEqual([]);
  });

  it('освободившаяся дорожка переиспользуется, граф не расползается', () => {
    // Две независимые головы, затем каждая закрывается — третья голова садится в 0.
    const { width } = layoutGraph([c('h1'), c('h2'), c('h3')]);
    expect(width).toBe(1);
  });

  it('коммит без родителей закрывает свою дорожку', () => {
    const { rows } = layoutGraph([c('root')]);
    expect(rows[0]!.edges).toEqual([]);
    expect(rows[0]!.merge).toBe(false);
  });

  it('у каждой строки есть колонка, и все рёбра ссылаются на существующие колонки', () => {
    const { rows, width } = layoutGraph([c('m', 'b', 'f'), c('b', 'a'), c('f', 'a'), c('a')]);
    for (const row of rows) {
      expect(row.lane).toBeGreaterThanOrEqual(0);
      expect(row.lane).toBeLessThan(width);
      for (const e of row.edges) {
        expect(e.from).toBeLessThan(width);
        expect(e.to).toBeLessThan(width);
      }
    }
  });
});
