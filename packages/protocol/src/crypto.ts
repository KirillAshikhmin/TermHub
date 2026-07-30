// E2E-крипто TermHub на libsodium. initCrypto() (sodium.ready) обязан завершиться
// до любого другого вызова — иначе функции бросят: sodium ещё не инициализирован.

import sodium from 'libsodium-wrappers-sumo';

// Алфавит кодов пейринга и fingerprint (30 симв., без похожих I/L/O/U/0/1).
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const PAIR_KEY_CONTEXT = 'termhub-pair-v1';
const FINGERPRINT_BYTES = 10;
const ROOM_ID_LEN = 4;
// Инвариант: SECRET_LEN обеспечивает ≥50 бит энтропии offline-запаса
// (12·log2(30)≈58.9 бит; KDF-растяжки нет — вся offline-энтропия равна
// энтропии secret). НЕ уменьшать ниже 11 (53.9 бит) — это нижняя граница
// приемлемого запаса; 10 символов (49 бит) уже ниже планки безопасности
// пейринга и не должно приниматься без пересмотра всей схемы.
const SECRET_LEN = 12;

const utf8 = new TextEncoder();

/** Кодирует байты в строку алфавита пейринга (base-30, big-endian, фикс. длина). */
function encodeAlphabet(bytes: Uint8Array): string {
  const base = BigInt(PAIR_ALPHABET.length);
  const outLen = Math.ceil((bytes.length * 8) / Math.log2(PAIR_ALPHABET.length));
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  const chars = new Array<string>(outLen);
  for (let i = outLen - 1; i >= 0; i--) {
    chars[i] = PAIR_ALPHABET[Number(value % base)];
    value /= base;
  }
  return chars.join('');
}

/** Инициализирует libsodium; вызвать один раз до любых других функций модуля. */
export async function initCrypto(): Promise<void> {
  await sodium.ready;
}

export interface Identity {
  edPub: Uint8Array;
  edSec: Uint8Array;
}

/** Долговременная Ed25519-identity узла. */
export function generateIdentity(): Identity {
  const pair = sodium.crypto_sign_keypair();
  return { edPub: pair.publicKey, edSec: pair.privateKey };
}

/** Отпечаток публичного ключа для показа человеку и как agentId в relay. */
export function fingerprint(edPub: Uint8Array): string {
  const hash = sodium.crypto_generichash(FINGERPRINT_BYTES, edPub, null);
  return encodeAlphabet(hash);
}

/** Генерирует одноразовый код пейринга XXXX-YYYY-YYYY-YYYY. */
export function generatePairingCode(): { code: string; roomId: string; secret: string } {
  let roomId = '';
  for (let i = 0; i < ROOM_ID_LEN; i++) roomId += PAIR_ALPHABET[sodium.randombytes_uniform(PAIR_ALPHABET.length)];
  let secret = '';
  for (let i = 0; i < SECRET_LEN; i++) secret += PAIR_ALPHABET[sodium.randombytes_uniform(PAIR_ALPHABET.length)];
  const code = `${roomId}-${secret.slice(0, 4)}-${secret.slice(4, 8)}-${secret.slice(8, 12)}`;
  return { code, roomId, secret };
}

/** Проверяет, что строка — синтаксически корректный roomId пейринга.
 *  Нужен relay: он принимает roomId по неаутентифицированному сокету и обязан
 *  отбраковать всё, что не имеет формы кода, ДО использования строки как ключа
 *  комнаты и в логах (иначе туда попадают переводы строк, escape-последовательности
 *  и многомегабайтные значения). */
export function isPairRoomId(value: string): boolean {
  if (value.length !== ROOM_ID_LEN) return false;
  for (const ch of value) if (!PAIR_ALPHABET.includes(ch)) return false;
  return true;
}

/** Нормализует введённый код (регистр, дефисы, пробелы) и делит на roomId/secret. */
export function parsePairingCode(code: string): { roomId: string; secret: string } {
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== ROOM_ID_LEN + SECRET_LEN) throw new Error(`Invalid pairing code length: ${clean.length}`);
  for (const ch of clean)
    if (!PAIR_ALPHABET.includes(ch)) throw new Error(`Invalid pairing code character: ${ch}`);
  return { roomId: clean.slice(0, ROOM_ID_LEN), secret: clean.slice(ROOM_ID_LEN) };
}

/** Ключ пейринга K_pair из секрета кода. */
export function pairKey(secret: string): Uint8Array {
  return sodium.crypto_generichash(sodium.crypto_secretbox_KEYBYTES, utf8.encode(secret), utf8.encode(PAIR_KEY_CONTEXT));
}

/** Шифрует JSON-объект ключом пейринга: nonce(24) || secretbox. */
export function sealPair(key: Uint8Array, obj: unknown): Uint8Array {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(utf8.encode(JSON.stringify(obj)), nonce, key);
  const out = new Uint8Array(nonce.length + cipher.length);
  out.set(nonce, 0);
  out.set(cipher, nonce.length);
  return out;
}

/** Расшифровывает пейринг-сообщение; бросает при неверном ключе/подделке. */
export function openPair<T>(key: Uint8Array, box: Uint8Array): T {
  const nonce = box.subarray(0, sodium.crypto_secretbox_NONCEBYTES);
  const cipher = box.subarray(sodium.crypto_secretbox_NONCEBYTES);
  const plain = sodium.crypto_secretbox_open_easy(cipher, nonce, key);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Ключи сессии из Ed25519-identity сторон (агент — server). */
export function sessionKeys(
  role: 'client' | 'server',
  self: Identity,
  peerEdPub: Uint8Array,
): { rx: Uint8Array; tx: Uint8Array } {
  const selfCurvePub = sodium.crypto_sign_ed25519_pk_to_curve25519(self.edPub);
  const selfCurveSec = sodium.crypto_sign_ed25519_sk_to_curve25519(self.edSec);
  const peerCurvePub = sodium.crypto_sign_ed25519_pk_to_curve25519(peerEdPub);
  const kx =
    role === 'client'
      ? sodium.crypto_kx_client_session_keys(selfCurvePub, selfCurveSec, peerCurvePub)
      : sodium.crypto_kx_server_session_keys(selfCurvePub, selfCurveSec, peerCurvePub);
  return { rx: kx.sharedRx, tx: kx.sharedTx };
}

export interface Encryptor {
  header: Uint8Array;
  push(data: Uint8Array): Uint8Array;
}

export interface Decryptor {
  pull(chunk: Uint8Array): Uint8Array;
}

/** Поток шифрования исходящего направления (secretstream, свой header). */
export function makeEncryptor(txKey: Uint8Array): Encryptor {
  const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(txKey);
  return {
    header,
    push: (data) =>
      sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        data,
        null,
        sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
      ),
  };
}

/** Поток расшифровки входящего направления; pull бросает при подделке. */
export function makeDecryptor(rxKey: Uint8Array, header: Uint8Array): Decryptor {
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, rxKey);
  return {
    pull: (chunk) => {
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, chunk, null);
      if (!result) throw new Error('secretstream: chunk verification failed');
      return result.message;
    },
  };
}

/** Ed25519-подпись сообщения секретным ключом identity. */
export function sign(sec: Uint8Array, msg: Uint8Array): Uint8Array {
  return sodium.crypto_sign_detached(msg, sec);
}

/** Проверяет Ed25519-подпись публичным ключом. */
export function verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  return sodium.crypto_sign_verify_detached(sig, msg, pub);
}

/** Домен-разделитель транскрипта хендшейка (чтобы подпись нельзя было переиспользовать
 *  в другом контексте, где тем же ключом подписывается что-то ещё). */
const HANDSHAKE_DOMAIN = new TextEncoder().encode('termhub-handshake-v1');

/**
 * Транскрипт хендшейка, который клиент подписывает своим долговременным ключом:
 * (домен ‖ челлендж агента ‖ header клиента ‖ header агента).
 *
 * Зачем: сессионные ключи выводятся только из статических Ed25519-ключей сторон, поэтому
 * secretstream детерминирован — записанный поток расшифровался бы повторно, и недоверенный
 * relay мог бы переиграть агенту всё, что пользователь когда-либо набирал. Свежий челлендж
 * делает каждую сессию неповторимой, а привязка обоих header'ов не даёт склеить валидную
 * подпись с записанными ранее потоками. Считается ОДИНАКОВО на всех трёх сторонах
 * (агент, web-клиент, CLI-клиент) — при правке меняй все три.
 */
export function handshakeTranscript(
  challenge: Uint8Array,
  clientHeader: Uint8Array,
  serverHeader: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HANDSHAKE_DOMAIN.length + challenge.length + clientHeader.length + serverHeader.length);
  let at = 0;
  for (const part of [HANDSHAKE_DOMAIN, challenge, clientHeader, serverHeader]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Домен-разделитель транскрипта, который подписывает АГЕНТ. Отличается от клиентского:
 *  иначе подпись одной стороны можно было бы предъявить как подпись другой. */
const SERVER_HANDSHAKE_DOMAIN = utf8.encode('termhub-handshake-server-v1');

/**
 * Транскрипт, который агент подписывает своим долговременным ключом в hello-ok:
 * (домен ‖ челлендж КЛИЕНТА ‖ header агента).
 *
 * Зачем: подпись клиента (handshakeTranscript) закрывает только направление
 * «клиент → агент». В обратную сторону сессионные ключи так же детерминированы, а
 * hello-ok ничем не подтверждён, поэтому недоверенный relay мог переиграть клиенту
 * записанный поток агента — с выключенным агентом — и клиент отрисовывал его как
 * живую сессию. Свежий челлендж клиента делает записанную подпись негодной, а
 * привязка header'а агента не даёт подставить к валидной подписи чужой поток.
 * Считается ОДИНАКОВО на всех трёх сторонах (агент, web-клиент, CLI-клиент) —
 * при правке меняй все три.
 */
export function serverHandshakeTranscript(clientChallenge: Uint8Array, serverHeader: Uint8Array): Uint8Array {
  const out = new Uint8Array(SERVER_HANDSHAKE_DOMAIN.length + clientChallenge.length + serverHeader.length);
  let at = 0;
  for (const part of [SERVER_HANDSHAKE_DOMAIN, clientChallenge, serverHeader]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
