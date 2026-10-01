// Клиентская сторона объявления возможностей (ADR 0018): что клиент назвал агенту,
// что запомнил из ответа и когда забывает. Транспорт — заглушка: сеть и кадры
// проверяются своими швами (relay-transport.test.ts, server.test.ts агента).
import { beforeEach, describe, expect, it } from 'vitest';

import { forgetCaps, hasCap, negotiateCaps, negotiatedCaps } from '../src/capabilities';
import type { Transport } from '../src/transport';

/** Агент-заглушка: отвечает по очереди (список — ответ, Error — отказ; последний
 *  ответ повторяется) и запоминает, что объявил клиент. */
function agent(...replies: Array<string[] | Error>): { transport: Transport; announced: string[][] } {
  const announced: string[][] = [];
  const queue = [...replies];
  const transport = {
    capabilities: (mine: string[]): Promise<string[]> => {
      announced.push(mine);
      const reply = queue.length > 1 ? queue.shift()! : queue[0]!;
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
  } as unknown as Transport;
  return { transport, announced };
}

/** Отказ REST агента с HTTP-статусом — форма ApiError из api.ts. */
function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

beforeEach(() => forgetCaps());

describe('negotiateCaps', () => {
  it('клиент называет свои имена и запоминает пересечение', async () => {
    const { transport, announced } = agent(['feed', 'teleport']);
    expect(await negotiateCaps(transport)).toEqual(['feed']);
    expect(announced[0]).toContain('feed');
    expect(negotiatedCaps()).toEqual(['feed']);
    expect(hasCap('feed')).toBe(true);
  });

  it('агент умеет не то же самое → в пересечении только общее', async () => {
    const { transport } = agent(['teleport']);
    expect(await negotiateCaps(transport)).toEqual([]);
    expect(hasCap('feed')).toBe(false);
    expect(hasCap('teleport')).toBe(false);
  });

  it('старый агент ответил 404 → пустое пересечение, и повторно его не дёргаем', async () => {
    const { transport, announced } = agent(httpError(404));
    expect(await negotiateCaps(transport)).toEqual([]);
    expect(hasCap('feed')).toBe(false);
    await negotiateCaps(transport);
    expect(announced.length).toBe(1); // обмен один на транспорт
  });

  it('401 — это «мы ещё не вошли», а не «возможностей нет»: следующий вызов повторяет обмен', async () => {
    const { transport, announced } = agent(httpError(401), ['feed']);
    expect(await negotiateCaps(transport)).toEqual([]);
    expect(hasCap('feed')).toBe(false);

    // После входа тот же транспорт спрашивают снова — и пересечение появляется.
    expect(await negotiateCaps(transport)).toEqual(['feed']);
    expect(announced.length).toBe(2);
    expect(hasCap('feed')).toBe(true);
  });

  it('обмен один на транспорт: второй вызов не ходит к агенту повторно', async () => {
    const { transport, announced } = agent(['feed']);
    await negotiateCaps(transport);
    await negotiateCaps(transport);
    expect(announced.length).toBe(1);
    expect(hasCap('feed')).toBe(true);
  });

  it('смена транспорта заменяет прежнее пересечение (сменился агент)', async () => {
    await negotiateCaps(agent(['feed']).transport);
    expect(hasCap('feed')).toBe(true);
    await negotiateCaps(agent([]).transport);
    expect(hasCap('feed')).toBe(false);
  });

  it('поздний ответ прежнего транспорта не переписывает пересечение нового', async () => {
    let answerOld: (caps: string[]) => void = () => {};
    const oldTransport = {
      capabilities: () => new Promise<string[]>((resolve) => (answerOld = resolve)),
    } as unknown as Transport;

    const pending = negotiateCaps(oldTransport);
    await negotiateCaps(agent(['feed']).transport); // переключились на другого агента
    answerOld([]); // прежний агент ответил, когда его уже никто не слушает
    await pending;

    expect(hasCap('feed')).toBe(true);
  });
});

describe('forgetCaps', () => {
  it('обрыв соединения гасит пересечение: до нового обмена возможностей нет', async () => {
    await negotiateCaps(agent(['feed']).transport);
    expect(hasCap('feed')).toBe(true);
    forgetCaps();
    expect(hasCap('feed')).toBe(false);
    expect(negotiatedCaps()).toEqual([]);
  });

  it('после забвения тот же транспорт объявляется заново', async () => {
    const { transport, announced } = agent(['feed']);
    await negotiateCaps(transport);
    forgetCaps();
    await negotiateCaps(transport);
    expect(announced.length).toBe(2);
    expect(hasCap('feed')).toBe(true);
  });
});
