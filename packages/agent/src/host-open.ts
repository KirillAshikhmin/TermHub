import { spawn as nodeSpawn } from 'node:child_process';

interface HostOpenDeps {
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
}

/** Открывает абсолютный путь приложением хоста по умолчанию, не запуская shell. */
export function openPathOnHost(filePath: string, deps: HostOpenDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  const command = platform === 'darwin' ? 'open' : platform === 'linux' ? 'xdg-open' : null;
  if (!command) return Promise.reject(new Error(`Opening files is not supported on ${platform}`));

  return new Promise<void>((resolve, reject) => {
    const child = (deps.spawn ?? nodeSpawn)(command, [filePath], { shell: false, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${code === null ? ` with signal ${signal ?? 'unknown'}` : ` with exit code ${code}`}`));
    });
  });
}
