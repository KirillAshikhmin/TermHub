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
  "updatedAt": "2026-08-29T16:07:40+03:00",
  "finishedAt": null,
  "stages": [
    { "id": "preflight", "status": "done", "startedAt": "2026-08-29T15:45:36+03:00", "finishedAt": "2026-08-29T15:46:32+03:00" },
    { "id": "manifest", "status": "done", "startedAt": "2026-08-29T15:46:32+03:00", "finishedAt": "2026-08-29T15:47:05+03:00" },
    { "id": "briefing", "status": "skipped", "startedAt": "2026-08-29T15:47:05+03:00", "finishedAt": "2026-08-29T15:47:24+03:00", "note": "вопросов не потребовалось" },
    { "id": "spec", "status": "done", "startedAt": "2026-08-29T15:47:24+03:00", "finishedAt": "2026-08-29T15:49:06+03:00", "note": "15 историй; G2: расхождений нет" },
    { "id": "plan", "status": "done", "startedAt": "2026-08-29T15:49:06+03:00", "finishedAt": "2026-08-29T15:49:50+03:00", "note": "2 таска, ярус T1, 2 волны" },
    { "id": "build", "status": "active", "startedAt": "2026-08-29T15:49:50+03:00", "note": "1 из 2 тасков готов; полный прогон 704/704" },
    { "id": "review", "status": "pending" },
    { "id": "final", "status": "pending" }
  ],
  "requirements": {
    "total": 10, "done": 0, "inTicket": 10, "inSpec": 0,
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
      "status": "pending",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    }
  ],
  "singlePass": null,
  "tests": null,
  "debt": { "placeholders": [], "assumptions": [], "emptyEnv": [] },
  "additions": [],
  "coverage": {
    "runs": 1,
    "findings": 0,
    "extra": "7 защитных/ошибочных сценариев прикреплены к R03/R09i/R10i"
  },
  "concerns": [
    "craft: resolveSafe/stat/isFile повторяется между resolveFile и openOnHost",
    "craft: relay FilesCtl дублирует FileOpCtl",
    "craft: relay open-host test использует общую Gradle fixture"
  ],
  "reviewers": { "manifestSpec": "/root/host_open_review_ms", "craft": "/root/host_open_review_craft" },
  "blind": null
}
