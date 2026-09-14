import { describe, expect, it } from 'vitest';

import { AGENT_CAPS, CLIENT_CAPS, FrameType, intersect, parseCaps } from '../src/index.js';

describe('кадры объявления возможностей', () => {
  it('Capabilities = 44, CapabilitiesResult = 45', () => {
    expect(FrameType.Capabilities).toBe(44);
    expect(FrameType.CapabilitiesResult).toBe(45);
  });
});

describe('intersect', () => {
  it('оставляет общие имена в порядке первого списка', () => {
    expect(intersect(['feed', 'echo', 'zoom'], ['zoom', 'feed'])).toEqual(['feed', 'zoom']);
  });

  it('общих имён нет → пустое пересечение', () => {
    expect(intersect(['feed'], ['echo'])).toEqual([]);
  });

  it('пустой список с любой стороны → пустое пересечение', () => {
    expect(intersect([], ['feed'])).toEqual([]);
    expect(intersect(['feed'], [])).toEqual([]);
  });

  it('дубль в списке не удваивает пересечение', () => {
    expect(intersect(['feed', 'feed'], ['feed'])).toEqual(['feed']);
  });
});

describe('parseCaps', () => {
  it('не массив → пустой список', () => {
    expect(parseCaps(undefined)).toEqual([]);
    expect(parseCaps('feed')).toEqual([]);
    expect(parseCaps({ caps: ['feed'] })).toEqual([]);
  });

  it('оставляет только строки', () => {
    expect(parseCaps(['feed', 42, null, 'echo'])).toEqual(['feed', 'echo']);
  });

  it('дубли схлопываются', () => {
    expect(parseCaps(['feed', 'feed'])).toEqual(['feed']);
  });
});

describe('списки сторон', () => {
  it('обе стороны этого этапа объявляют feed', () => {
    expect(AGENT_CAPS).toContain('feed');
    expect(CLIENT_CAPS).toContain('feed');
  });

  it('пересечение сторон этого этапа — feed', () => {
    expect(intersect(AGENT_CAPS, CLIENT_CAPS)).toEqual(['feed']);
  });
});
