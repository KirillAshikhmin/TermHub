window.STATE =
{
  "slug": "open-on-host",
  "title": "Открытие файла на хосте",
  "mode": "semi",
  "depth": "normal",
  "polish": null,
  "tier": "T1",
  "briefFile": "2026-08-29-brief.md",
  "memoryFile": "CLAUDE.md",
  "skillDir": "/Users/asihminkirill/.agents/skills/autopilot",
  "startedAt": "2026-08-29T15:45:36+03:00",
  "updatedAt": "2026-08-29T16:25:56+03:00",
  "finishedAt": "2026-08-29T16:25:56+03:00",
  "stages": [
    { "id": "preflight", "status": "done", "startedAt": "2026-08-29T15:45:36+03:00", "finishedAt": "2026-08-29T15:46:32+03:00" },
    { "id": "manifest", "status": "done", "startedAt": "2026-08-29T15:46:32+03:00", "finishedAt": "2026-08-29T15:47:05+03:00" },
    { "id": "briefing", "status": "skipped", "startedAt": "2026-08-29T15:47:05+03:00", "finishedAt": "2026-08-29T15:47:24+03:00", "note": "вопросов не потребовалось" },
    { "id": "spec", "status": "done", "startedAt": "2026-08-29T15:47:24+03:00", "finishedAt": "2026-08-29T15:49:06+03:00", "note": "15 историй; G2: расхождений нет" },
    { "id": "plan", "status": "done", "startedAt": "2026-08-29T15:49:06+03:00", "finishedAt": "2026-08-29T15:49:50+03:00", "note": "3 таска, ярус T1, 2 волны; T03 добавлен по подтверждённой пользователем Codex-регрессии" },
    { "id": "build", "status": "done", "startedAt": "2026-08-29T15:49:50+03:00", "finishedAt": "2026-08-29T16:22:30+03:00", "note": "3 из 3 тасков готовы; 715/715; build и deploy зелёные" },
    { "id": "review", "status": "done", "startedAt": "2026-08-29T16:22:30+03:00", "finishedAt": "2026-08-29T16:25:56+03:00", "note": "blind acceptance: все пользовательские сценарии реализованы; служебные файлы закрываются финальным коммитом" },
    { "id": "final", "status": "done", "startedAt": "2026-08-29T16:25:40+03:00", "finishedAt": "2026-08-29T16:25:56+03:00" }
  ],
  "requirements": {
    "total": 11, "done": 11, "inTicket": 0, "inSpec": 0,
    "placeholder": 0, "deferred": 0, "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Безопасное системное открытие файла",
      "requirements": ["R03", "R04", "R05", "R09i", "R10i"],
      "blockedBy": [],
      "wave": 1,
      "zone": ["packages/agent/src/host-open.ts", "packages/agent/src/files.ts", "packages/agent/src/server.ts", "packages/agent/src/relay-link.ts", "packages/agent/test/"],
      "status": "done",
      "startedAt": "2026-08-29T15:51:08+03:00",
      "finishedAt": "2026-08-29T16:07:40+03:00",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0
    },
    {
      "id": "02",
      "title": "Кнопка «Открыть на хосте» в Проводнике",
      "requirements": ["R01", "R02", "R03", "R05", "R06", "R07", "R08", "R09i", "R10i"],
      "blockedBy": ["01"],
      "wave": 2,
      "zone": ["packages/web/src/files.ts", "packages/web/src/i18n.ts", "packages/web/test/", "docs/manual-test-checklist*.md"],
      "status": "done",
      "startedAt": "2026-08-29T16:11:15+03:00",
      "finishedAt": "2026-08-29T16:22:30+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "03",
      "title": "Копирование при mouse tracking Codex",
      "requirements": ["R11"],
      "blockedBy": [],
      "wave": 2,
      "zone": ["packages/web/src/term.ts", "packages/web/test/term-copy*.test.ts", "packages/web/test/term-harness.ts", "docs/manual-test-checklist*.md"],
      "status": "done",
      "startedAt": "2026-08-29T16:11:15+03:00",
      "finishedAt": "2026-08-29T16:16:20+03:00",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    }
  ],
  "singlePass": null,
  "tests": {
    "targetedHostOpen": "98/98",
    "targetedWeb": "19/19",
    "full": "715/715",
    "build": "passed",
    "deployHealth": "ok",
    "doctor": "All good; 11 tmux sessions; relay reachable"
  },
  "debt": { "placeholders": [], "assumptions": [], "emptyEnv": [] },
  "additions": [],
  "coverage": {
    "runs": 1,
    "findings": 0,
    "extra": "7 защитных/ошибочных сценариев прикреплены к R03/R09i/R10i"
  },
  "concerns": [
    "drop: дублирование resolveSafe/stat и FilesCtl — локальная структурная вкусовщина, публичный контракт не расходится",
    "drop: relay open-host test использует Gradle fixture — тест изолирован по поведению и зелёный",
    "drop: xterm mouse semantics закреплена fake — точный внешний контракт дополнительно проверен в исходниках установленного xterm",
    "drop: redraw+Command+C покрыты отдельными тестами вместо одного сквозного — оба шва зелёные",
    "report: при open-host можно войти в edit/cancel до завершения opener и получить новый активный экземпляр кнопки; обычный double-click заблокирован, edge-case не удерживает релиз"
  ],
  "reviewers": { "manifestSpec": "/root/host_open_review_ms", "craft": "/root/host_open_review_craft" },
  "blind": {
    "verdict": "agreed",
    "implemented": ["open-on-host UI", "macOS host opener", "session preservation", "deploy", "Codex mouse-mode copy"],
    "initialPartial": "служебные run/memory файлы были не закоммичены на момент проверки; закрываются финальным коммитом",
    "drift": []
  }
}
