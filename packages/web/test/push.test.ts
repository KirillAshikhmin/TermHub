// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { urlBase64ToUint8Array } from '../src/push';

describe('urlBase64ToUint8Array', () => {
  it('декодирует base64url без паддинга (вектор «hello»)', () => {
    // 'aGVsbG8' = base64url("hello") без '='.
    expect(Array.from(urlBase64ToUint8Array('aGVsbG8'))).toEqual([104, 101, 108, 108, 111]);
  });

  it('преобразует URL-safe символы -/_ обратно в +// ', () => {
    // '-_8' (base64url) → стандартный '+/8=' → байты [251, 255].
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([251, 255]);
  });

  it('возвращает Uint8Array', () => {
    expect(urlBase64ToUint8Array('aGVsbG8')).toBeInstanceOf(Uint8Array);
  });
});
