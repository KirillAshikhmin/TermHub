import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Тот же бандл раздают два хоста: LAN-агент и remote-relay. Vite пишет в статику
// агента; этот плагин по завершении сборки зеркалит её в ../relay/static, чтобы
// `npm run build -w @termhub/web` обновлял оба каталога одним прогоном.
function mirrorToRelay(): Plugin {
  const from = fileURLToPath(new URL('../agent/static', import.meta.url));
  const to = fileURLToPath(new URL('../relay/static', import.meta.url));
  return {
    name: 'termhub-mirror-relay',
    apply: 'build',
    closeBundle() {
      fs.rmSync(to, { recursive: true, force: true });
      fs.cpSync(from, to, { recursive: true });
    },
  };
}

// Один бандл раздаётся с двух хостов (LAN-агент и remote-relay), поэтому base
// относительный — ассеты грузятся от текущего пути, а не от корня домена.
export default defineConfig({
  base: './',
  plugins: [mirrorToRelay()],
  build: {
    // Собранный web кладётся в статику агента; тот раздаёт index.html как
    // no-cache, а assets/* — immutable (имена с хэшами).
    outDir: '../agent/static',
    emptyOutDir: true,
    assetsDir: 'assets',
    target: 'es2022',
    rollupOptions: {
      // Service worker — отдельный вход: должен лежать в корне (/sw.js), чтобы
      // его scope был '/'. Приложение и его ассеты — как обычно, с хэшами.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
