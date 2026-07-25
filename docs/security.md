# Security

**English** · [Русский](security.ru.md)

A brief summary of what is protected and how, and which trade-offs TermHub
makes deliberately.

## Local network (LAN)

- By default this is plain HTTP, not HTTPS, and the agent listens on all
  network interfaces (`0.0.0.0`). This is a deliberate trade-off for the sake
  of simplicity: setup requires no certificates, and traffic never leaves the
  Wi-Fi network. Access is protected by a password: the config stores not the
  password itself but its scrypt hash, and comparison is done in constant time
  (resistant to response-timing attacks).
- **The trust boundary is your local network.** Since traffic goes over HTTP,
  a passive listener on the same segment (for example, on a shared or public
  Wi-Fi) can intercept the password at login and the 30-day auth cookie.
  That is why the "HTTP + password" mode is intended for a home/trusted
  network. For access from an untrusted network, use the relay (all traffic is
  end-to-end encrypted, see below), Tailscale, or enable TLS. `termhub setup`
  warns about this explicitly when TLS is not configured.
- A successful login issues an HttpOnly cookie (signed with HMAC; the signing
  secret is generated during `termhub setup`), valid for 30 days; the WS
  connection to the terminal verifies the same cookie.
- On `/api/login` there is a rate limit: no more than 5 failed attempts per
  minute from a single IP.
- If you need HTTPS even on the LAN, a TLS option is available (mkcert or
  `tailscale cert`, see [docs/notifications.md](notifications.md) and
  [docs/remote.md](remote.md)): the paths to the certificate/key files are
  added to `~/.termhub/config.json` manually; `setup` does not create them.

## Remote access (relay)

**What the relay sees.** Connection metadata: `agentId` (the fingerprint of
the agent's long-term public key), the connecting client's public key (it is
needed for routing and key exchange — this is an address, not a secret),
timings, and traffic volume. The content itself (keystrokes, terminal output)
travels inside an end-to-end encrypted stream, whose keys the relay simply
does not have. The relay does not see the client's device name — it is
transmitted to the agent only inside the encrypted pairing channel.

**Crypto scheme (libsodium):**

- The agent and each client have their own long-term Ed25519 key pair
  (identity).
- **Pairing a new device** is done via a one-time code
  (`XXXX-YYYY-YYYY-YYYY`: 12 characters from a 30-character alphabet with no
  mutually similar letters/digits, which is about 59 bits of entropy). From
  the code both sides derive a shared key `K_pair`; the relay itself does not
  know the secret and cannot guess it — the pairing room lives for only 5
  minutes and allows no more than 3 attempts. Inside the channel encrypted
  with `K_pair`, the sides exchange public keys and confirm identity with a
  signature.
- **A normal session:** X25519 key exchange (`crypto_kx`) → a pair of session
  keys → all traffic in both directions goes through
  `crypto_secretstream_xchacha20poly1305`. The agent additionally sends a fresh
  32-byte challenge, and the client signs the handshake transcript
  (challenge ‖ client stream header ‖ agent stream header) with its long-term
  Ed25519 key. Without a valid signature the agent never enters the streaming
  state, so a recorded session **cannot be replayed** — otherwise an untrusted
  relay could replay everything you once typed.
- **Trust follows the TOFU principle** (trust on first use): once successfully
  paired, a device stays trusted until it is explicitly revoked. There is no
  certificate authority — only keys and the fact of pairing.
- **Revoking a device:** `termhub devices` / `termhub revoke <fingerprint|name>`
  on the host. Revocation applies **immediately, including to a live
  connection**: the agent re-checks the device against `authorized.json` on
  every frame, and a revoked but silent connection is evicted by a sweep within
  a few seconds. Privileged frames (opening a terminal, device management, any
  mutation) are checked without caching, so they are rejected the moment the
  device is revoked.

**About forward secrecy.** Session keys are derived from the devices'
long-term keys (static Diffie–Hellman); there are no ephemeral per-session
keys. The practical implication: if someone's long-term private key is
compromised, an attacker who recorded the encrypted traffic in advance (for
example, on the relay itself) will be able to decrypt it after the fact. This
is a deliberate trade-off: the relay by design does not store traffic, and the
live channel remains confidential, protected against tampering and against
replay (see the handshake signature above). If your threat model requires
perfect forward secrecy, that is a direction for a future version (ephemeral
X25519 on top of identity-based authentication).

**Guest access (scope).** «Share» can issue a pairing code limited to a single
session: the guest sees only that session in the list, and the flags «allow
input» and «allow files» are enforced **by the agent**, not just hidden in the
UI. File and VCS operations for such a device are additionally confined to the
working directory of the shared session. If the scope is malformed, the agent
refuses to issue a code at all rather than silently granting full access.

**Where the relay is in the trust boundary.** Terminal traffic is end-to-end
encrypted and the relay cannot read it. But when you open the PWA *from the
relay*, the relay also serves the JavaScript that performs that encryption — so
for the browser client the relay is part of the trusted computing base. Someone
who controls the relay could serve modified code. The CLI client
(`termhub connect`) does not have this property: it runs code from your own
machine. If this matters to you, use the CLI or serve the PWA from the agent
over the LAN.

## Protection against arbitrary commands (anti-RCE)

The agent's API does not run just anything:

- the directory for a new session comes only from a predefined list
  (`sessionRoots` in the config, `~/projects` by default), no arbitrary path;
- the command for a new session is only one of the presets (`zsh` or
  `claude`), not free-form input;
- all calls to `tmux` go through `execFile` without a shell — injection via
  special characters in the session name or directory is ruled out.

## Secrets on disk

`~/.termhub/` (config, identity keys, the list of authorized devices,
push subscriptions) is created with `0700` permissions; individual files are
`0600`. The VAPID private key (for Web Push) and the agent's long-term private
key never leave the Mac — only their public parts are transmitted over the
network.
