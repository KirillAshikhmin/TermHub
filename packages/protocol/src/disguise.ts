// Маскировка TCP-соединения с relay под «разрешённый» протокол. Фильтры, которые
// душат поток после пары десятков пакетов, решают по ПЕРВОМУ пакету клиента: увидев
// начало SSH, RDP или DNS-запроса, пропускают соединение целиком, что бы ни шло следом.
// Клиент (агент, CLI) шлёт преамбулу первой, relay на отдельном порту срезает её и
// дальше отдаёт поток как есть (TLS + WebSocket). Браузеру этот путь недоступен:
// первые байты соединения он не выбирает. Модуль чистый — ни сети, ни процессов.

export type Disguise = 'ssh' | 'rdp' | 'dns';

export const DISGUISES: readonly Disguise[] = ['ssh', 'rdp', 'dns'];

export function isDisguise(value: unknown): value is Disguise {
  return typeof value === 'string' && (DISGUISES as readonly string[]).includes(value);
}

/** Пределы преамбулы: всё, что длиннее, — не наша маскировка, а чужой трафик на порту. */
const MAX_BANNER = 255;
const MAX_SSH_PACKET = 4096;
const MAX_TPKT = 512;
const MAX_DNS = 512;

const text = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

/** Пакет SSH_MSG_KEXINIT в обёртке бинарного протокола: баннера одного фильтру мало. */
function sshKexInit(): Uint8Array {
  const lists = [
    'curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256',
    'ssh-ed25519,rsa-sha2-512,rsa-sha2-256',
    'chacha20-poly1305@openssh.com,aes256-gcm@openssh.com',
    'chacha20-poly1305@openssh.com,aes256-gcm@openssh.com',
    'umac-64-etm@openssh.com,hmac-sha2-256',
    'umac-64-etm@openssh.com,hmac-sha2-256',
    'none,zlib@openssh.com',
    'none,zlib@openssh.com',
    '',
    '',
  ];
  const cookie = new Uint8Array(16);
  for (let i = 0; i < cookie.length; i++) cookie[i] = (i * 37 + 11) & 255;
  const payload = concat([
    Uint8Array.of(20),
    cookie,
    ...lists.flatMap((l) => [u32(l.length), text(l)]),
    Uint8Array.of(0),
    u32(0),
  ]);
  let pad = 8 - ((5 + payload.length) % 8);
  if (pad < 4) pad += 8;
  return concat([u32(1 + payload.length + pad), Uint8Array.of(pad), payload, new Uint8Array(pad)]);
}

/** Байты, которые клиент шлёт первыми, до TLS. */
export function disguisePreface(kind: Disguise): Uint8Array {
  if (kind === 'ssh') return concat([text('SSH-2.0-OpenSSH_9.9\r\n'), sshKexInit()]);
  if (kind === 'rdp') {
    // X.224 Connection Request в TPKT: 19 байт, один пакет.
    return Uint8Array.of(3, 0, 0, 19, 14, 0xe0, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0);
  }
  // DNS-запрос A example.org с двухбайтной длиной (DNS поверх TCP).
  const query = concat([
    Uint8Array.of(0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0),
    Uint8Array.of(7),
    text('example'),
    Uint8Array.of(3),
    text('org'),
    Uint8Array.of(0, 0, 1, 0, 1),
  ]);
  return concat([Uint8Array.of(query.length >> 8, query.length & 255), query]);
}

/** Сколько байт занимает преамбула в начале `buf`: число — длина, `null` — данных пока
 *  мало, исключение — это не преамбула. Вид определяется по первым байтам. */
export function prefaceLength(buf: Uint8Array): number | null {
  if (buf.length === 0) return null;
  if (buf[0] === 3) {
    if (buf.length < 4) return null;
    const len = (buf[2] << 8) | buf[3];
    if (buf[1] !== 0 || len < 7 || len > MAX_TPKT) throw new Error('bad preface');
    return buf.length >= len ? len : null;
  }
  if (buf[0] === 0x53) {
    const head = text('SSH-2.0-');
    for (let i = 0; i < Math.min(head.length, buf.length); i++) {
      if (buf[i] !== head[i]) throw new Error('bad preface');
    }
    const nl = buf.indexOf(10);
    if (nl < 0) {
      if (buf.length > MAX_BANNER) throw new Error('bad preface');
      return null;
    }
    if (nl > MAX_BANNER) throw new Error('bad preface');
    if (buf.length < nl + 5) return null;
    const len = ((buf[nl + 1] << 24) | (buf[nl + 2] << 16) | (buf[nl + 3] << 8) | buf[nl + 4]) >>> 0;
    if (len < 2 || len > MAX_SSH_PACKET) throw new Error('bad preface');
    const total = nl + 5 + len;
    return buf.length >= total ? total : null;
  }
  if (buf.length < 2) return null;
  const len = (buf[0] << 8) | buf[1];
  if (len < 12 || len > MAX_DNS) throw new Error('bad preface');
  return buf.length >= 2 + len ? 2 + len : null;
}
