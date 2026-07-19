import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

const manifestUrl = new URL('../public/manifest.webmanifest', import.meta.url);

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose: string }>;
}

describe('web app manifest', () => {
  const raw = fs.readFileSync(manifestUrl, 'utf8');

  it('является валидным JSON с обязательными полями PWA', () => {
    const m = JSON.parse(raw) as Manifest;
    expect(m.name).toBe('TermHub');
    expect(m.short_name).toBe('TermHub');
    expect(m.start_url).toBe('./');
    expect(m.scope).toBe('./');
    expect(m.display).toBe('standalone');
    // Портретная блокировка: PWA не крутится вопреки залоченному телефону.
    expect(m.orientation).toBe('portrait');
    expect(m.background_color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(m.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('объявляет установочную иконку (в т.ч. maskable)', () => {
    const m = JSON.parse(raw) as Manifest;
    expect(m.icons.length).toBeGreaterThan(0);
    const icon = m.icons[0]!;
    expect(icon.src).toBe('icon.svg');
    expect(icon.type).toBe('image/svg+xml');
    expect(icon.sizes).toBe('any');
    expect(icon.purpose).toContain('maskable');
  });
});
