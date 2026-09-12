window.STATE =
{
  "slug": "control-mode",
  "title": "Этап 1: control mode вместо attach",
  "mode": "semi",
  "depth": "deep",
  "polish": null,
  "tier": "T2",
  "briefFile": "2026-09-12-brief.md",
  "memoryFile": "CLAUDE.md",
  "skillDir": "/Users/asihminkirill/.agents/skills/autopilot",
  "startedAt": "2026-09-12T20:59:18+03:00",
  "updatedAt": "2026-09-13T00:18:10+03:00",
  "finishedAt": "2026-09-13T00:18:10+03:00",
  "stages": [
    { "id": "preflight", "status": "done", "startedAt": "2026-09-12T20:59:18+03:00", "finishedAt": "2026-09-12T20:59:24+03:00" },
    { "id": "manifest",  "status": "done", "startedAt": "2026-09-12T20:59:24+03:00", "finishedAt": "2026-09-12T21:02:56+03:00" },
    { "id": "briefing",  "status": "done", "startedAt": "2026-09-12T21:02:56+03:00", "finishedAt": "2026-09-12T21:02:56+03:00", "note": "1 вопрос: ручка отката" },
    { "id": "spec",      "status": "done", "startedAt": "2026-09-12T21:02:56+03:00", "finishedAt": "2026-09-12T21:02:56+03:00", "note": "29 историй; G2 идёт" },
    { "id": "plan",      "status": "done", "startedAt": "2026-09-12T21:02:56+03:00", "finishedAt": "2026-09-12T21:04:54+03:00", "note": "4 таска, ярус T2, 4 волны по одному" },
    { "id": "build",     "status": "done", "startedAt": "2026-09-12T21:04:54+03:00", "finishedAt": "2026-09-12T23:10:31+03:00", "note": "7 тасков; control mode заработал вживую только после живого шва" },
    { "id": "review",    "status": "done", "startedAt": "2026-09-12T21:31:29+03:00", "finishedAt": "2026-09-12T23:10:31+03:00", "note": "3 оси на каждый таск, 9 кругов правок" },
    { "id": "final",     "status": "done", "startedAt": "2026-09-12T23:10:31+03:00", "finishedAt": "2026-09-13T00:18:10+03:00", "note": "развёрнуто: локальный агент перезапущен, relay пересобран и поднят" }
  ],
  "requirements": { "total": 27, "done": 27, "inTicket": 0, "inSpec": 0, "placeholder": 0, "deferred": 0, "dropped": 0 },
  "tickets": [
    {"id": "00", "title": "Починить красный тест из main и убрать worktree из прогона", "requirements": ["R18i"], "blockedBy": [], "wave": 1, "zone": ["packages/agent/test/bridge.unit.test.ts", "vitest.config.ts"], "status": "done", "startedAt": "2026-09-12T21:31:29+03:00", "retries": 0, "repairs": 0, "handoffs": 0, "finishedAt": "2026-09-12T21:43:08+03:00", "files": ["vitest.config.ts", "packages/agent/test/bridge.unit.test.ts"], "commit": "fcad2c2", "tests": {"passed": 22, "failed": 0}},
    {"id": "01", "title": "Модуль разбора протокола control mode", "requirements": ["R02", "R02.1", "R12", "R13"], "blockedBy": [], "wave": 1, "zone": ["packages/agent/src/control-protocol.ts", "packages/agent/test/control-protocol.test.ts"], "status": "done", "startedAt": "2026-09-12T21:04:54+03:00", "retries": 0, "repairs": 2, "repairFindings": ["незакрытый блок поглощает весь дальнейший вывод", "хвост незавершённой строки не ограничен", "%output без панели даёт пустое событие", "битый %begin маскируется под уведомление", "сверка номера команды не проверена тестом", "тест разрыва внутри символа не проверяет заявленное", "поведение для строки без % не закреплено", "брошенный блок не выпускает события и вешает ожидающего", "длинная строка внутри блока пропадает молча"], "handoffs": 0, "finishedAt": "2026-09-12T22:22:53+03:00", "files": ["packages/agent/src/control-protocol.ts", "packages/agent/test/control-protocol.test.ts"], "commit": "f550f4a", "tests": {"passed": 37, "failed": 0}},
    {"id": "02", "title": "Жизненный цикл control-клиента", "requirements": ["R01", "R05", "R08", "R11", "R12", "R03", "R04"], "blockedBy": ["01"], "wave": 2, "zone": ["packages/agent/src/session-link.ts", "packages/agent/test/session-link.test.ts"], "status": "done", "startedAt": "2026-09-12T21:31:29+03:00", "retries": 0, "repairs": 2, "repairFindings": ["ответы сопоставляются по порядку, а не по номеру — ложный откат", "снимок глушит вывод, пришедший в том же куске", "у команды нет срока — снимок может зависнуть", "тест смерти до готовности зеленеет по таймеру", "ветка отказа attach не покрыта", "клампы и константы скопированы из bridge.ts", "после отката служебные команды уходят в сессию пользователя текстом"], "handoffs": 0, "finishedAt": "2026-09-12T22:22:53+03:00", "files": ["packages/agent/src/session-link.ts", "packages/agent/src/pty-common.ts", "packages/agent/test/session-link.test.ts"], "commit": "d3568ef", "tests": {"passed": 38, "failed": 0}},
    {"id": "03", "title": "Встраивание в оба пути агента", "requirements": ["R01", "R03", "R04", "R05", "R06", "R07", "R08", "R09", "R10", "R11", "R14i", "R15i", "R16i", "R17i", "G01"], "blockedBy": ["02"], "wave": 3, "zone": ["packages/agent/src/", "packages/protocol/src/frames.ts", "packages/agent/test/", "packages/protocol/test/"], "status": "done", "startedAt": "2026-09-12T22:22:53+03:00", "retries": 0, "repairs": 2, "repairFindings": ["необработанное отклонение промиса роняет процесс агента", "живой вывод придерживается до 10 секунд", "LAN и relay валидируют просьбу по-разному", "нет теста на живой звонок в control mode", "тест про звонок из снимка зеленеет по другой причине", "предел придержания не покрыт", "тест про старшинство настройки проверяет только отсутствие флага", "хелпер ничего не захватывает", "сброс в обработчике отказа не проверяет, жив ли терминал", "отмена снимка по сроку молчит"], "handoffs": 0, "finishedAt": "2026-09-12T22:52:06+03:00", "files": ["packages/agent/src/bridge.ts", "packages/agent/src/relay-link.ts", "packages/agent/src/cli.ts", "packages/agent/src/config.ts", "packages/agent/src/doctor.ts", "packages/agent/src/sessions.ts", "packages/protocol/src/frames.ts"], "commit": "4e46d27", "tests": {"passed": 34, "failed": 0}},
    {"id": "04", "title": "Веб: режим, пометка, переключатель", "requirements": ["R07", "R09", "R10", "R14i", "G01"], "blockedBy": ["03"], "wave": 4, "zone": ["packages/web/src/", "packages/web/test/", "docs/manual-test-checklist.md", "docs/manual-test-checklist.ru.md"], "status": "done", "startedAt": "2026-09-12T22:51:11+03:00", "retries": 0, "repairs": 2, "repairFindings": ["тест переключателя закрепляет невозможный сценарий и ложный факт про запрет attach", "чип обещал режим, который не включится", "признаки складываются в противоречивую подпись"], "handoffs": 0, "finishedAt": "2026-09-12T23:10:31+03:00", "files": ["packages/web/src/term-mode.ts", "packages/web/src/term.ts", "packages/web/src/ws-frames.ts", "packages/web/src/transport.ts", "packages/web/src/relay-transport.ts", "packages/web/src/diag.ts", "packages/web/src/i18n.ts", "docs/manual-test-checklist*.md"], "commit": "320aaca", "tests": {"passed": 299, "failed": 0}},
    {"id": "05", "title": "Две починки подключения по отложенным находкам", "requirements": ["R01", "R05", "R08"], "blockedBy": ["02"], "wave": 3, "zone": ["packages/agent/src/session-link.ts", "packages/agent/test/session-link.test.ts"], "status": "done", "startedAt": "2026-09-12T22:29:13+03:00", "retries": 0, "repairs": 1, "repairFindings": ["бюджет готовности меряется настенными часами", "продление не оставляет следа в логе"], "handoffs": 0, "finishedAt": "2026-09-12T22:35:54+03:00", "files": ["packages/agent/src/session-link.ts", "packages/agent/test/session-link.test.ts"], "commit": "b0901ab", "tests": {"passed": 41, "failed": 0}},
    {"id": "06", "title": "Снять DCS-обёртку и завести шов с настоящим tmux", "requirements": ["R01", "R02", "R09", "R10", "R11", "D07"], "blockedBy": ["01", "02", "03"], "wave": 5, "zone": ["packages/agent/src/control-protocol.ts", "packages/agent/test/control-protocol.test.ts", "packages/agent/test/control-mode.tmux.test.ts", "packages/web/src/touch-scroll.ts"], "status": "done", "startedAt": "2026-09-12T23:22:13+03:00", "retries": 0, "repairs": 0, "handoffs": 0, "finishedAt": "2026-09-12T23:31:28+03:00", "files": ["packages/agent/src/control-protocol.ts", "packages/agent/test/control-protocol.test.ts", "packages/web/src/touch-scroll.ts"], "commit": "f58ec56", "tests": {"passed": 40, "failed": 0}, "note": "живой шов написан, но красный из-за дефекта в session-link — уходит с таском 07"},
    {"id": "07", "title": "Сопоставление ответов по живому tmux", "requirements": ["R01", "R05", "R08", "D08"], "blockedBy": ["06"], "wave": 6, "zone": ["packages/agent/src/session-link.ts", "packages/agent/test/session-link.test.ts", "packages/agent/test/session-link.tmux.test.ts"], "status": "done", "startedAt": "2026-09-12T23:31:28+03:00", "retries": 0, "repairs": 0, "handoffs": 0, "finishedAt": "2026-09-12T23:40:07+03:00", "files": ["packages/agent/src/session-link.ts", "packages/agent/test/session-link.test.ts", "packages/agent/test/session-link.tmux.test.ts"], "commit": "0c073f5", "tests": {"passed": 42, "failed": 0}}
  ],
  "singlePass": null,
  "tests": {"full": "828/829 в группе suite; единственное падение — vcs.git по таймауту, в одиночном прогоне 26/26 зелёные", "live": "session-link.tmux — control mode на настоящем tmux, снимок непустой", "build": "npm run build прошла, libsodium в LAN-бандл не попал", "types": "agent и web чисты"},
  "debt": { "placeholders": [], "assumptions": [], "emptyEnv": [] },
  "additions": [],
  "coverage": {
    "runs": 1, "found": 7, "fixed": 7, "deferred": 0,
    "extra": "потерянная связь меток этапа с манифестом прогона; R11 обещал больше, чем даёт этап; не заданы глубина снимка, детектор alt-screen, формат октального экранирования и написание refresh-client"
  },
  "concerns": [
    "control-protocol: после брака блока остаток его тела разбирается как поток — строка ответа, начинающаяся с %output, дойдёт до экрана чужим выводом",
    "оба замечания про session-link закрыты таском 05"
  ],
  "reviewers": { "manifestSpec": "a382962cad146ccfb", "craft": "a5dab3f7b9c92bb9a" },
  "blind": {
    "verdict": "drift",
    "drift": ["control mode не включался ни разу на живой машине: DCS-обёртка в начале потока -CC не снималась (T06)", "номера блоков не идут подряд, предсказание номера давало ложный откат (T07)"],
    "implemented": ["разбор протокола", "жизненный цикл и откат", "ввод, размер, снимок", "LAN, relay и CLI одной дорогой", "пресет Codex", "переключатель и пометка в вебе"],
    "note": "оба расхождения найдены живым швом против настоящего tmux, которого в наборе не было; исправлены и закоммичены"
  }
}
