// `termhub local-cert` — сертификат для https://localhost. Основной сертификат агента
// выпущен на внешнее имя (LAN/Tailscale), и на localhost браузер ругается законно.
// Здесь заводится свой центр сертификации, годный ТОЛЬКО для localhost/127.0.0.1/::1
// (ограничение имён зашито в сам сертификат центра: даже утёкший ключ не подпишет
// чужой сайт), и лист-сертификат. Агент выбирает сертификат по имени из запроса (SNI),
// основной при этом продолжает работать. Доверие центру выдаёт владелец одной командой —
// она спрашивает пароль, поэтому агент её только печатает.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, configPath, ensureConfigDir, writeSecretFile } from './paths.js';

const CA_DAYS = 3650;
/** macOS не принимает серверные сертификаты длиннее 825 дней. */
const LEAF_DAYS = 800;

export interface LocalCertPaths {
  ca: string;
  cert: string;
  key: string;
}

export function localCertPaths(dir = configDir()): LocalCertPaths {
  return {
    ca: path.join(dir, 'local-ca.pem'),
    cert: path.join(dir, 'local-cert.pem'),
    key: path.join(dir, 'local-key.pem'),
  };
}

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
}

/** Создаёт центр (если его ещё нет) и свежий лист-сертификат. Возвращает пути. */
export function generateLocalCert(dir = configDir()): LocalCertPaths {
  const paths = localCertPaths(dir);
  const caKey = path.join(dir, 'local-ca-key.pem');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-cert-'));
  try {
    fs.writeFileSync(
      path.join(work, 'ca.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = v3_ca',
        'prompt = no',
        '[dn]',
        `CN = TermHub localhost CA (${os.hostname()})`,
        '[v3_ca]',
        'basicConstraints = critical, CA:TRUE, pathlen:0',
        'keyUsage = critical, keyCertSign, cRLSign',
        'subjectKeyIdentifier = hash',
        'nameConstraints = critical, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, ' +
          'permitted;IP:0:0:0:0:0:0:0:1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(work, 'leaf.cnf'),
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        '[dn]',
        'CN = localhost',
        '[leaf]',
        'basicConstraints = critical, CA:FALSE',
        'keyUsage = critical, digitalSignature, keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectAltName = DNS:localhost, IP:127.0.0.1, IP:::1',
        '',
      ].join('\n'),
    );
    if (!fs.existsSync(paths.ca) || !fs.existsSync(caKey)) {
      openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS),
        '-keyout', 'ca-key.pem', '-out', 'ca.pem', '-config', 'ca.cnf'], work);
      writeSecretFile(caKey, fs.readFileSync(path.join(work, 'ca-key.pem'), 'utf8'));
      writeSecretFile(paths.ca, fs.readFileSync(path.join(work, 'ca.pem'), 'utf8'));
    }
    openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf-key.pem', '-out', 'leaf.csr',
      '-config', 'leaf.cnf'], work);
    openssl(['x509', '-req', '-in', 'leaf.csr', '-CA', paths.ca, '-CAkey', caKey, '-CAcreateserial',
      '-out', 'leaf.pem', '-days', String(LEAF_DAYS), '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'leaf'], work);
    writeSecretFile(paths.key, fs.readFileSync(path.join(work, 'leaf-key.pem'), 'utf8'));
    writeSecretFile(paths.cert, fs.readFileSync(path.join(work, 'leaf.pem'), 'utf8'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(`${paths.ca.replace(/\.pem$/, '')}.srl`, { force: true });
  }
  return paths;
}

/** Команда CLI: выпускает сертификат, прописывает его в config.json и печатает, как довериться. */
export function runLocalCert(): number {
  ensureConfigDir();
  let paths: LocalCertPaths;
  try {
    paths = generateLocalCert();
  } catch (err) {
    console.error(`Failed to generate the localhost certificate (is openssl installed?): ${(err as Error).message}`);
    return 1;
  }
  const file = configPath();
  if (fs.existsSync(file)) {
    const config = JSON.parse(fs.readFileSync(file, 'utf8')) as { tlsExtra?: Array<{ cert: string; key: string }> };
    const rest = (config.tlsExtra ?? []).filter((t) => t.cert !== paths.cert);
    config.tlsExtra = [...rest, { cert: paths.cert, key: paths.key }];
    writeSecretFile(file, `${JSON.stringify(config, null, 2)}\n`);
  }
  console.log(`Certificate for localhost: ${paths.cert} (valid ${LEAF_DAYS} days; rerun this command to renew)`);
  console.log('Trust its authority once (asks for your password; the authority can only sign localhost):');
  if (process.platform === 'darwin') {
    console.log(`  security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db "${paths.ca}"`);
  } else {
    console.log(`  sudo cp "${paths.ca}" /usr/local/share/ca-certificates/termhub-local-ca.crt && sudo update-ca-certificates`);
  }
  console.log('Then restart the agent and open https://localhost:<port>/ . Without `tls` in the config the extra certificate is not used.');
  return 0;
}
