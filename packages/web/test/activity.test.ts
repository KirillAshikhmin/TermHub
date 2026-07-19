import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../src/activity';

describe('ActivityTracker', () => {
  it('первая встреча сессии — НЕ горячая (baseline без мигания на загрузке)', () => {
    const a = new ActivityTracker();
    a.observe([{ name: 's', activityTs: 100 }]);
    expect(a.isHot('s')).toBe(false);
  });

  it('рост activityTs делает сессию горячей, затем она остывает через HOT_POLLS', () => {
    const a = new ActivityTracker();
    a.observe([{ name: 's', activityTs: 100 }]); // baseline
    a.observe([{ name: 's', activityTs: 200 }]); // вырос → горячо, stale=0
    expect(a.isHot('s')).toBe(true);
    a.observe([{ name: 's', activityTs: 200 }]); // без роста, stale=1 → ещё горячо
    expect(a.isHot('s')).toBe(true);
    a.observe([{ name: 's', activityTs: 200 }]); // без роста, stale=2 → остыло
    expect(a.isHot('s')).toBe(false);
  });

  it('исчезнувшая из списка сессия забывается', () => {
    const a = new ActivityTracker();
    a.observe([{ name: 's', activityTs: 100 }]);
    a.observe([{ name: 's', activityTs: 200 }]);
    expect(a.isHot('s')).toBe(true);
    a.observe([]); // s пропала
    expect(a.isHot('s')).toBe(false);
  });

  it('неизвестное имя — не горячее', () => {
    const a = new ActivityTracker();
    expect(a.isHot('nope')).toBe(false);
  });

  it('reset() очищает состояние', () => {
    const a = new ActivityTracker();
    a.observe([{ name: 's', activityTs: 100 }]);
    a.observe([{ name: 's', activityTs: 200 }]);
    a.reset();
    expect(a.isHot('s')).toBe(false);
  });
});
