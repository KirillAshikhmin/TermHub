// Адреса прямого доступа, которые агент сообщает клиенту: публичные IP сюда попасть
// не должны — это был бы приглашающий жест в сторону интернета.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:os', () => ({
  default: {
    networkInterfaces: () => mockIfaces,
  },
}));

let mockIfaces: Record<string, Array<{ address: string; family: string; internal: boolean }>> = {};

const { localUrls } = await import('../src/local-urls.js');

afterEach(() => {
  mockIfaces = {};
});

describe('localUrls', () => {
  it('отдаёт приватные IPv4 со схемой по наличию TLS', () => {
    mockIfaces = {
      en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }],
    };
    expect(localUrls({ port: 7710, tls: true })).toEqual(['https://192.168.1.5:7710']);
    expect(localUrls({ port: 7710, tls: false })).toEqual(['http://192.168.1.5:7710']);
  });

  it('пропускает публичные адреса, loopback и IPv6', () => {
    mockIfaces = {
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [{ address: '203.0.113.7', family: 'IPv4', internal: false }],
      en1: [{ address: 'fe80::1', family: 'IPv6', internal: false }],
      en2: [{ address: '10.1.2.3', family: 'IPv4', internal: false }],
    };
    expect(localUrls({ port: 7710, tls: true })).toEqual(['https://10.1.2.3:7710']);
  });

  it('берёт все частные диапазоны, включая CGNAT (туда попадает Tailscale)', () => {
    mockIfaces = {
      a: [{ address: '172.16.0.9', family: 'IPv4', internal: false }],
      b: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
      c: [{ address: '169.254.1.1', family: 'IPv4', internal: false }],
      d: [{ address: '172.32.0.1', family: 'IPv4', internal: false }],
    };
    const urls = localUrls({ port: 80, tls: false });
    expect(urls).toContain('http://172.16.0.9:80');
    expect(urls).toContain('http://100.101.102.103:80');
    expect(urls).toContain('http://169.254.1.1:80');
    expect(urls).not.toContain('http://172.32.0.1:80'); // вне 172.16/12
  });

  it('дубликаты между интерфейсами схлопываются', () => {
    mockIfaces = {
      a: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
      b: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
    };
    expect(localUrls({ port: 7710, tls: true })).toEqual(['https://10.0.0.1:7710']);
  });
});
