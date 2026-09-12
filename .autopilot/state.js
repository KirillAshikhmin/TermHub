window.STATE =
{
  "slug": "own-terminal-mosh-ux",
  "title": "Свой терминал, mosh и удобство работы с агентами",
  "mode": "interview",
  "depth": "deep",
  "polish": null,
  "tier": "T1",
  "briefFile": "2026-09-12-brief.md",
  "memoryFile": "CLAUDE.md",
  "skillDir": "/Users/asihminkirill/.agents/skills/autopilot",
  "startedAt": "2026-09-12T19:37:09+03:00",
  "updatedAt": "2026-09-12T20:48:39+03:00",
  "finishedAt": "2026-09-12T20:48:39+03:00",
  "stages": [
    { "id": "preflight", "status": "done", "startedAt": "2026-09-12T19:37:09+03:00", "finishedAt": "2026-09-12T19:37:13+03:00" },
    { "id": "manifest",  "status": "done", "startedAt": "2026-09-12T19:37:13+03:00", "finishedAt": "2026-09-12T19:38:59+03:00" },
    { "id": "briefing",  "status": "done", "startedAt": "2026-09-12T19:38:59+03:00", "finishedAt": "2026-09-12T20:24:08+03:00", "note": "12 вопросов; премортем: 7 находок"  },
    { "id": "spec",      "status": "done", "startedAt": "2026-09-12T20:24:08+03:00", "finishedAt": "2026-09-12T20:29:48+03:00", "note": "39 историй; G2: 7 расхождений, все закрыты"  },
    { "id": "plan",      "status": "done", "startedAt": "2026-09-12T20:29:48+03:00", "finishedAt": "2026-09-12T20:30:02+03:00", "note": "2 таска, ярус T1, одна волна параллельно"  },
    { "id": "build",     "status": "done", "startedAt": "2026-09-12T20:30:02+03:00", "finishedAt": "2026-09-12T20:42:38+03:00", "note": "3 из 3 тасков готовы" },
    { "id": "review",    "status": "active", "startedAt": "2026-09-12T20:34:38+03:00", "note": "оба таска: по 2 оси, дозапросы отправлены"  },
    { "id": "final",     "status": "done", "startedAt": "2026-09-12T20:42:38+03:00", "note": "слепая приёмка: 2 расхождения, оба исправлены", "finishedAt": "2026-09-12T20:48:39+03:00" }
  ],
  "requirements": {
    "total": 31, "done": 26, "inTicket": 0, "inSpec": 0,
    "placeholder": 0, "deferred": 4, "dropped": 1
  },
  "tickets": [
    {"id": "01", "title": "ADR на шесть принятых решений", "requirements": ["R01", "R02", "R03", "R09", "R04", "R16i", "R06", "R14i", "R07", "G01", "G02", "R13i", "R12i"], "blockedBy": [], "wave": 1, "zone": ["docs/adr/"], "status": "done", "startedAt": "2026-09-12T20:30:02+03:00", "retries": 0, "repairs": 2, "repairFindings": ["G01: компенсация скрытой рамки не зафиксирована", "профиль агента урезан против §10a", "первый показ сессии не решён", "цена отката на attach не названа", "50 мс приписаны mosh", "факт про iOS без источника", "жирное выделение вне формата ADR", "правка внесла противоречие 0016 и 0014 про capture-pane"], "handoffs": 0, "finishedAt": "2026-09-12T20:42:22+03:00", "files": ["docs/adr/0013…0018 — шесть файлов"], "commit": "b3b6acb"},
    {"id": "02", "title": "Документ анализа и дорожная карта", "requirements": ["R05", "R08", "R10", "R11", "R12i", "R15i", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11", "R06", "R04"], "blockedBy": [], "wave": 1, "zone": ["docs/terminal-and-agents.ru.md", "README.md", "README.ru.md"], "status": "done", "startedAt": "2026-09-12T20:30:02+03:00", "retries": 0, "repairs": 2, "repairFindings": ["G05: потерян прыжок к следующей команде", "R06.3/R06.5 не прослеживаются до этапа", "G10: потерян способ распознавания речи", "50 мс приписаны mosh", "факт про iOS без источника", "23 строки длиннее 95 символов", "дословное дублирование ADR", "пересказ вместо ссылок на docs/", "правка вырезала решения прогона про гостя и очистку истории"], "handoffs": 0, "finishedAt": "2026-09-12T20:42:38+03:00", "files": ["docs/terminal-and-agents.ru.md", "README.md", "README.ru.md"], "commit": "dfff5f6"},
    {"id": "03", "title": "Исправить две формулировки замеров", "requirements": ["R12i"], "blockedBy": ["01", "02"], "wave": 2, "zone": ["docs/terminal-and-agents.ru.md", "docs/adr/0014-tmux-control-mode-instead-of-attach.md"], "status": "done", "startedAt": "2026-09-12T20:47:07+03:00", "retries": 0, "repairs": 0, "handoffs": 0, "finishedAt": "2026-09-12T20:48:21+03:00", "files": ["docs/terminal-and-agents.ru.md", "docs/adr/0014-tmux-control-mode-instead-of-attach.md"], "commit": "ecd1fd5"}
  ],
  "singlePass": null,
  "tests": { "note": "поставка документов — кода не касались; рабочее дерево чисто, кроме .claude/settings.json пользователя" },
  "debt": { "placeholders": [], "assumptions": [], "emptyEnv": [] },
  "additions": [
    "A01 — индикатор задержки до Mac числом, ради R06 (отзывчивость)",
    "A02 — размер локальной истории и кнопка очистки, ради R04 (история на устройстве)"
  ],
  "coverage": {
    "runs": 1, "found": 7, "fixed": 7, "deferred": 0,
    "extra": "«и другими» агентами → профили-данные §10a; второй alt-screen от TUI внутри панели → §2 + замер Claude/Codex/vim; «вdt» расшифровано; детектор рамки, распознавание вопроса, набор байт для эхо — доописаны"
  },
  "concerns": [
    "docs/terminal-and-agents.ru.md — после перестановки дорожной карты документ вырос с 414 до 430 строк: шесть строк на этап вернули в прозу то, что таблица держала двумя колонками",
    "профили агентов (§10a спецификации) отдельного ADR не имеют — зафиксированы внутри 0017"
  ],
  "reviewers": { "manifestSpec": "a64bcbfa22b0dd7db", "craft": "a085da7bf2429c5c3" },
  "blind": {
    "verdict": "agreed",
    "implemented": ["своё окно терминала — вердикт и ADR", "скролл в полноэкранных и офлайн", "отзывчивость — четыре точки", "скрытие полосы ввода", "открытый список фич закрыт", "mosh против tmux", "удобство работы с агентами"],
    "partial": ["скролл в настоящих полноэкранных приложениях (vim, htop) невозможен — названо свойством, не недоделкой"],
    "drift": ["history-limit в поставке читался как 4000 при реальных 50 000 — исправлено таском 03", "83 байта поданы как константа при зависимости от имени сессии — исправлено таском 03"],
    "notRunnable": "проект не запускался: поставка — документы, кода прогон не касался"
  }
}
