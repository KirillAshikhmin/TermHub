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
  `crypto_secretstream_xchacha20poly1305`.
- **Trust follows the TOFU principle** (trust on first use): once successfully
  paired, a device stays trusted until it is explicitly revoked. There is no
  certificate authority — only keys and the fact of pairing.
- **Revoking a device:** `termhub devices` / `termhub revoke <fingerprint|name>`
  on the Mac. After revocation, the device does not pass a new E2E handshake
  and cannot open new terminals even over an already established connection.
  Terminals already open at that moment continue to live until the connection
  is dropped — to terminate them immediately, restart the agent
  (`termhub start`).

**About forward secrecy.** Session keys are derived from the devices'
long-term keys (static Diffie–Hellman); there are no ephemeral per-session
keys. The practical implication: if someone's long-term private key is
compromised, an attacker who recorded the encrypted traffic in advance (for
example, on the relay itself) will be able to decrypt it after the fact. This
is a deliberate trade-off: the relay by design does not store traffic, and the
live channel remains confidential and protected against tampering. If your
threat model requires perfect forward secrecy, that is a direction for a
future version (ephemeral X25519 on top of identity-based authentication).

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
