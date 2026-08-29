window.STATE =
{
  "slug": "codex-compatibility",
  "title": "Совместимость TermHub с Codex",
  "mode": "semi",
  "depth": "normal",
  "polish": null,
  "tier": "T1",
  "briefFile": "2026-08-29-brief.md",
  "memoryFile": "CLAUDE.md",
  "skillDir": "/Users/asihminkirill/.agents/skills/autopilot",
  "startedAt": "2026-08-29T14:41:24+03:00",
  "updatedAt": "2026-08-29T15:39:06+03:00",
  "finishedAt": "2026-08-29T15:39:06+03:00",
  "stages": [
    { "id": "preflight", "status": "done", "startedAt": "2026-08-29T14:41:24+03:00", "finishedAt": "2026-08-29T14:42:39+03:00" },
    { "id": "manifest", "status": "done", "startedAt": "2026-08-29T14:42:39+03:00", "finishedAt": "2026-08-29T14:43:10+03:00" },
    { "id": "briefing", "status": "skipped", "startedAt": "2026-08-29T14:43:10+03:00", "finishedAt": "2026-08-29T14:43:44+03:00", "note": "вопросов не потребовалось" },
    { "id": "spec", "status": "done", "startedAt": "2026-08-29T14:43:44+03:00", "finishedAt": "2026-08-29T14:51:08+03:00", "note": "19 историй; G2: 2 прогона, 2 находки закрыты" },
    { "id": "plan", "status": "done", "startedAt": "2026-08-29T14:51:08+03:00", "finishedAt": "2026-08-29T14:52:43+03:00", "note": "2 таска, ярус T1, 2 волны" },
    { "id": "build", "status": "done", "startedAt": "2026-08-29T14:52:43+03:00", "finishedAt": "2026-08-29T15:30:29+03:00", "note": "3 из 3 тасков готовы; commit/push не выполнялись по правилу проекта" },
    { "id": "review", "status": "done", "startedAt": "2026-08-29T15:20:30+03:00", "finishedAt": "2026-08-29T15:30:29+03:00", "note": "слепая приёмка чистая; 2 craft-находки закрыты T03" },
    { "id": "final", "status": "done", "startedAt": "2026-08-29T15:30:29+03:00", "finishedAt": "2026-08-29T15:39:06+03:00", "note": "relay задеплоен и healthy; локальный LaunchAgent перезапущен; 11 tmux-сессий сохранены" }
  ],
  "requirements": {
    "total": 12, "done": 11, "inTicket": 0, "inSpec": 0,
    "placeholder": 0, "deferred": 1, "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Codex title-контракт и безопасный пресет",
      "requirements": ["R01", "R06", "R07", "R08", "R09", "R10i"],
      "blockedBy": [],
      "wave": 1,
      "zone": ["packages/protocol/src/session-title.ts", "packages/protocol/test/session-title.test.ts", "packages/agent/src/sessions.ts", "packages/agent/test/sessions.unit.test.ts"],
      "status": "done",
      "startedAt": "2026-08-29T14:53:15+03:00",
      "finishedAt": "2026-08-29T15:04:12+03:00",
      "commit": null,
      "files": ["packages/protocol/src/session-title.ts", "packages/protocol/test/session-title.test.ts", "packages/agent/src/sessions.ts", "packages/agent/test/sessions.unit.test.ts"],
      "tests": "узкие 59/59; protocol+agent build; полный vitest 685/685",
      "retries": 0,
      "repairs": 1,
      "handoffs": 0
    },
    {
      "id": "02",
      "title": "Устойчивое копирование и видимые заголовки",
      "requirements": ["R01", "R02", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10i", "A01"],
      "blockedBy": ["01"],
      "wave": 2,
      "zone": ["packages/web/src/term*.ts", "packages/web/src/tabs.ts", "packages/web/src/main.ts", "packages/web/src/workspace.ts", "packages/web/test/", "README*.md", "docs/manual-test-checklist*.md"],
      "status": "done",
      "startedAt": "2026-08-29T15:04:12+03:00",
      "finishedAt": "2026-08-29T15:20:30+03:00",
      "commit": null,
      "files": ["README.md", "README.ru.md", "docs/manual-test-checklist.md", "docs/manual-test-checklist.ru.md", "packages/web/src/document-title.ts", "packages/web/src/term-copy.ts", "packages/web/src/term.ts", "packages/web/src/tabs.ts", "packages/web/src/main.ts", "packages/web/src/workspace.ts", "packages/web/test/term-copy.test.ts", "packages/web/test/term-copy-integration.test.ts", "packages/web/test/term-harness.ts", "packages/web/test/tabs.test.ts", "packages/web/test/workspace.test.ts"],
      "tests": "web 261/261; copy/title 62/62; web tsc; полный build; итоговый vitest 694/694",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    },
    {
      "id": "03",
      "title": "Закрытие отложенных craft-находок",
      "requirements": ["R02", "R08", "R10i"],
      "blockedBy": ["02"],
      "wave": 3,
      "zone": ["README.ru.md", "packages/web/test/term-copy.test.ts"],
      "status": "done",
      "startedAt": "2026-08-29T15:22:24+03:00",
      "finishedAt": "2026-08-29T15:30:29+03:00",
      "commit": null,
      "files": ["README.ru.md", "packages/web/test/term-copy.test.ts"],
      "tests": "term-copy 7/7; итоговый vitest 695/695",
      "retries": 0,
      "repairs": 0,
      "handoffs": 0
    }
  ],
  "singlePass": null,
  "tests": { "passed": 695, "failed": 0 },
  "deployment": {
    "relay": "healthy; внешний /healthz → ok",
    "agent": "LaunchAgent running; doctor → All good; relay registered",
    "sessionsBefore": 11,
    "sessionsAfter": 11
  },
  "debt": { "placeholders": [], "assumptions": [], "emptyEnv": [] },
  "additions": [
    { "id": "A01", "parent": "R02", "title": "Устойчивое копирование для любой часто перерисовывающей TUI" }
  ],
  "coverage": {
    "runs": 2,
    "findings": 2,
    "resolved": [
      "явно разделены tmux-id, project-name и Codex thread-title",
      "добавлен полный перечень результатов Codex-аудита"
    ]
  },
  "concerns": [
    { "ticket": "02", "axis": "craft", "file": "README.ru.md:151", "finding": "Формулировку нужно унифицировать с EN: именно TermHub не читает и не изменяет ~/.codex/config.toml; сам Codex продолжает читать свой config.", "verdict": "fixed", "followup": "T03" },
    { "ticket": "02", "axis": "craft", "file": "packages/web/test/term-copy.test.ts:41", "finding": "Failure-тест покрывает rejected Promise, но не resolved false от clipboard helper; snapshot должен сохраняться и допускать keyboard retry в обоих случаях.", "verdict": "fixed", "followup": "T03" }
  ],
  "reviewers": { "manifestSpec": "/root/review_manifest_spec", "craft": "/root/review_craft" },
  "blind": {
    "at": "2026-08-29T15:22:00+03:00",
    "verdicts": {
      "копирование": "реализовано — auto-copy и Command/Ctrl+C используют snapshot, переживающий redraw",
      "имя сессии": "реализовано — session tab и browser/PWA title получают Codex thread-title с tmux-id fallback",
      "другие Codex-проблемы": "реализовано — process-local preset отключает title-анимацию и распознаёт Action Required"
    },
    "drift": [],
    "notRun": [],
    "commands": [
      "production web preview на 127.0.0.1:4174 → HTTP 200",
      "релевантный vitest → 6 файлов, 100 тестов passed",
      "итоговый npm test → 54 файла, 695 тестов passed"
    ]
  }
}
