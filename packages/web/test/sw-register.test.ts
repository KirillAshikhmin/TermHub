import { describe, expect, it } from 'vitest';

import { shouldRegisterSw } from '../src/sw-register';

describe('shouldRegisterSw', () => {
  it('secure context + есть navigator.serviceWorker → true', () => {
    expect(shouldRegisterSw({ isSecureContext: true, hasServiceWorker: true })).toBe(true);
  });

  it('небезопасный контекст (http без localhost) → false даже при наличии SW', () => {
    expect(shouldRegisterSw({ isSecureContext: false, hasServiceWorker: true })).toBe(false);
  });

  it('нет navigator.serviceWorker → false даже в secure context', () => {
    expect(shouldRegisterSw({ isSecureContext: true, hasServiceWorker: false })).toBe(false);
  });
});
