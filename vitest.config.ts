// Единственная задача этой конфигурации — не пускать тяжёлый tmux-шов Gradle в
// параллель с остальными тестами. Он держит настоящие tmux-сессии с настоящими
// процессами около полуминуты, и от такой нагрузки на машине рвался соседний
// relay-тест на 16-мегабайтный фрейм (примерно раз из трёх). Группы проектов
// запускаются по возрастанию groupOrder: сначала вся сюита, потом — в одиночестве —
// tmux-шов. Порогов чужих тестов это не трогает.
import { configDefaults, defineConfig } from 'vitest/config';

const TMUX_SEAM = 'packages/agent/test/gradle.tmux.test.ts';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'suite',
          exclude: [...configDefaults.exclude, TMUX_SEAM],
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: 'tmux',
          include: [TMUX_SEAM],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
