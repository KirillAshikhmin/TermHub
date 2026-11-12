window.STATE =
{
  "version": 2,
  "slug": "native-agent-ui",
  "dir": "2026-11-12-native-agent-ui--wip",
  "title": "Нативный интерфейс к Claude и Codex поверх терминала",
  "mode": "interview",
  "depth": "deep",
  "tier": "T2",
  "briefFile": "2026-11-12-brief.md",
  "memoryFile": "CLAUDE.md",
  "memoryOwner": "autopilot",
  "skillDir": "/Users/asihminkirill/.agents/skills/autopilot",
  "baseCommit": null,
  "startedAt": "2026-11-12T16:46:07+03:00",
  "updatedAt": "2026-11-12T17:29:03+03:00",
  "finishedAt": null,
  "stages": [
    {
      "id": "preflight",
      "status": "done",
      "startedAt": "2026-11-12T16:46:07+03:00",
      "finishedAt": "2026-11-12T16:46:27+03:00"
    },
    {
      "id": "manifest",
      "status": "done",
      "startedAt": "2026-11-12T16:46:27+03:00",
      "finishedAt": "2026-11-12T16:46:39+03:00"
    },
    {
      "id": "briefing",
      "status": "done",
      "startedAt": "2026-11-12T16:46:39+03:00",
      "finishedAt": "2026-11-12T17:18:52+03:00"
    },
    {
      "id": "spec",
      "status": "done",
      "startedAt": "2026-11-12T17:18:52+03:00",
      "finishedAt": "2026-11-12T17:29:03+03:00"
    },
    {
      "id": "plan",
      "status": "active",
      "startedAt": "2026-11-12T17:29:03+03:00"
    },
    {
      "id": "build",
      "status": "pending"
    },
    {
      "id": "review",
      "status": "pending"
    },
    {
      "id": "final",
      "status": "pending"
    }
  ],
  "requirements": {
    "total": 28,
    "done": 0,
    "inTicket": 28,
    "inSpec": 0,
    "placeholder": 0,
    "deferred": 0,
    "dropped": 0
  },
  "tickets": [
    {
      "id": "01",
      "title": "Замеры, профили агентов и распознавание экрана",
      "requirements": [
        "R01",
        "R02",
        "R17i",
        "G09"
      ],
      "blockedBy": [],
      "wave": 1,
      "zone": [
        "packages/protocol/",
        "packages/agent/src/agent-profiles.ts",
        "packages/agent/src/agent-screen.ts",
        "packages/agent/test/fixtures/screens/",
        "packages/agent/test/agent-screen.test.ts",
        "packages/agent/test/agent-profiles.test.ts",
        "docs/native-agent-ui.ru.md"
      ],
      "review": "да — фундамент",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "02",
      "title": "Агент: экран панели и действия чата на обоих транспортах",
      "requirements": [
        "R03",
        "R05",
        "R10",
        "R15i",
        "R16i",
        "R18i",
        "G02",
        "G05",
        "G03",
        "G09"
      ],
      "blockedBy": [
        "01"
      ],
      "wave": 2,
      "zone": [
        "packages/agent/src/pane-io.ts",
        "packages/agent/src/agent-live.ts",
        "packages/agent/src/chat-request.ts",
        "packages/agent/src/server.ts",
        "packages/agent/src/relay-link.ts",
        "packages/agent/src/cli.ts",
        "packages/agent/test/"
      ],
      "review": "нет",
      "model": "сильная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "03",
      "title": "Агент: команды для подсказок, подробности действий, контекст, любые файлы",
      "requirements": [
        "R12",
        "R13",
        "R08",
        "G03",
        "G06",
        "R11",
        "G09"
      ],
      "blockedBy": [
        "01",
        "02"
      ],
      "wave": 3,
      "zone": [
        "packages/agent/src/agent-commands.ts",
        "packages/agent/src/transcript-feed.ts",
        "packages/agent/src/transcript-usage.ts",
        "packages/agent/src/session-feed.ts",
        "packages/agent/src/feed-request.ts",
        "packages/agent/src/paste-image.ts",
        "packages/agent/src/server.ts",
        "packages/agent/src/relay-link.ts",
        "packages/agent/test/"
      ],
      "review": "нет",
      "model": "обычная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "04",
      "title": "Веб: чат-оболочка, переключатель вида и переписка с оформлением",
      "requirements": [
        "R06",
        "G01",
        "R07",
        "R08",
        "R09",
        "R04",
        "G08",
        "R19i",
        "R18i",
        "G09"
      ],
      "blockedBy": [
        "01"
      ],
      "wave": 2,
      "zone": [
        "packages/web/"
      ],
      "review": "нет",
      "model": "обычная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "05",
      "title": "Веб: состояние агента, вопросы кнопками, управление и окошко терминала",
      "requirements": [
        "R10",
        "R16i",
        "R15i",
        "R17i",
        "G02",
        "G03",
        "G05",
        "G07",
        "R03",
        "G04",
        "G09"
      ],
      "blockedBy": [
        "02",
        "04"
      ],
      "wave": 3,
      "zone": [
        "packages/web/"
      ],
      "review": "нет",
      "model": "обычная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    },
    {
      "id": "06",
      "title": "Веб: поле ввода, вложения и подсказки",
      "requirements": [
        "R14",
        "G04",
        "R11",
        "G06",
        "R12",
        "R13",
        "G09"
      ],
      "blockedBy": [
        "03",
        "05"
      ],
      "wave": 4,
      "zone": [
        "packages/web/"
      ],
      "review": "нет",
      "model": "обычная",
      "status": "pending",
      "retries": 0,
      "repairs": 0
    }
  ],
  "tests": null,
  "debt": {
    "placeholders": [],
    "assumptions": [],
    "emptyEnv": []
  },
  "additions": [],
  "coverage": {
    "found": 7,
    "fixed": 6,
    "deferred": 0,
    "items": [
      "провод и швы вынесены в interfaces.md намеренно — не расхождение"
    ]
  },
  "concerns": [],
  "blind": null,
  "beats": [
    "2026-11-12T16:46:07+03:00",
    "2026-11-12T16:46:27+03:00",
    "2026-11-12T16:46:39+03:00",
    "2026-11-12T16:47:10+03:00",
    "2026-11-12T16:54:09+03:00",
    "2026-11-12T16:57:25+03:00",
    "2026-11-12T17:00:00+03:00",
    "2026-11-12T17:18:14+03:00",
    "2026-11-12T17:18:52+03:00",
    "2026-11-12T17:27:06+03:00",
    "2026-11-12T17:29:03+03:00"
  ],
  "rev": 17,
  "waiting": null,
  "waits": [
    {
      "kind": "briefing",
      "from": "2026-11-12T16:47:10+03:00",
      "to": "2026-11-12T17:18:14+03:00"
    }
  ],
  "log": [
    {
      "t": "2026-11-12T16:46:07+03:00",
      "k": "init"
    },
    {
      "t": "2026-11-12T16:46:27+03:00",
      "k": "stage",
      "id": "manifest",
      "act": "start"
    },
    {
      "t": "2026-11-12T16:46:39+03:00",
      "k": "stage",
      "id": "briefing",
      "act": "start"
    },
    {
      "t": "2026-11-12T16:47:10+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "четыре вопроса — что считать результатом, источник сообщений, где живёт интерфейс, порядок агентов"
    },
    {
      "t": "2026-11-12T16:54:09+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "второй раунд — слэш-команды, незнакомый экран, вид инструментов, управление агентом"
    },
    {
      "t": "2026-11-12T16:57:25+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "третий раунд — вид по умолчанию, вложения, opencode, предупреждение о версии агента"
    },
    {
      "t": "2026-11-12T17:00:00+03:00",
      "k": "ask",
      "kind": "briefing",
      "note": "последний раунд — на что должен быть похож чат, деплой по завершении"
    },
    {
      "t": "2026-11-12T17:18:14+03:00",
      "k": "answered",
      "kind": "briefing"
    },
    {
      "t": "2026-11-12T17:18:52+03:00",
      "k": "gate",
      "g": "G1",
      "ok": false,
      "open": 28,
      "total": 28
    },
    {
      "t": "2026-11-12T17:18:52+03:00",
      "k": "stage",
      "id": "spec",
      "act": "start"
    },
    {
      "t": "2026-11-12T17:27:06+03:00",
      "k": "gate",
      "g": "G2",
      "ok": false,
      "found": 7,
      "fixed": 6,
      "deferred": 0
    },
    {
      "t": "2026-11-12T17:27:06+03:00",
      "k": "gate",
      "g": "G1",
      "ok": true,
      "open": 0,
      "total": 28
    },
    {
      "t": "2026-11-12T17:29:03+03:00",
      "k": "stage",
      "id": "plan",
      "act": "start"
    },
    {
      "t": "2026-11-12T17:29:03+03:00",
      "k": "tier",
      "v": "T2"
    },
    {
      "t": "2026-11-12T17:29:03+03:00",
      "k": "tickets",
      "n": 6
    },
    {
      "t": "2026-11-12T17:29:03+03:00",
      "k": "gate",
      "g": "G3",
      "ok": true,
      "problems": 0
    }
  ],
  "reqList": [
    {
      "id": "R01",
      "text": "«проанализируй, на сколько возможно реализовать такую фичу»",
      "status": "in-ticket"
    },
    {
      "id": "R02",
      "text": "«на бекенде claude и codex работают в терминале»",
      "status": "in-ticket"
    },
    {
      "id": "R03",
      "text": "«мы с нии через наш веб через нативный интерфейс, то есть по сути парсить терминал»",
      "status": "in-ticket"
    },
    {
      "id": "R04",
      "text": "«Что бы работать удобнее было»",
      "status": "in-ticket"
    },
    {
      "id": "R05",
      "text": "«использовать именно родной инструмент и не переписывать его»",
      "status": "in-ticket"
    },
    {
      "id": "R06",
      "text": "«осознаю что с обновлением это может сломаться, поэтому будет переключение между терминалом и нативным интерфейсом»",
      "status": "in-ticket"
    },
    {
      "id": "R07",
      "text": "«поддерживался вывод сообщений от консоли с всем форматированием»",
      "status": "in-ticket"
    },
    {
      "id": "R08",
      "text": "«командами и т.д.» (в выводе сообщений)",
      "status": "in-ticket"
    },
    {
      "id": "R09",
      "text": "«ссылками в тексте»",
      "status": "in-ticket"
    },
    {
      "id": "R10",
      "text": "«ответом на вопросы»",
      "status": "in-ticket"
    },
    {
      "id": "R11",
      "text": "«строкой ввода с изображениями»",
      "status": "in-ticket"
    },
    {
      "id": "R12",
      "text": "«слэш команды с подсказами»",
      "status": "in-ticket"
    },
    {
      "id": "R13",
      "text": "«автокомплит в поле ввода»",
      "status": "in-ticket"
    },
    {
      "id": "R14",
      "text": "«ну и соответсвенно нативное поле ввода запроса»",
      "status": "in-ticket"
    },
    {
      "id": "R15i",
      "text": "(подразумевается) видно, что агент сейчас делает (думает, работает, ждёт), и его можно прервать",
      "status": "in-ticket"
    },
    {
      "id": "R16i",
      "text": "(подразумевается) запросы разрешений агента (выполнить команду, править файл) тоже отвечаются из нативного интерфейса",
      "status": "in-ticket"
    },
    {
      "id": "R17i",
      "text": "(подразумевается) парсер не узнал экран (обновление агента) — пользователь это видит и не остаётся с пустым или лживым интерфейсом",
      "status": "in-ticket"
    },
    {
      "id": "R18i",
      "text": "(подразумевается) работает и в LAN, и через relay — как остальные функции TermHub",
      "status": "in-ticket"
    },
    {
      "id": "R19i",
      "text": "(подразумевается) нативный интерфейс пригоден с телефона",
      "status": "in-ticket"
    },
    {
      "id": "G01",
      "text": "«Тогда у вкладки терминала не просто кнопочка, а переключатель вида»",
      "status": "in-ticket"
    },
    {
      "id": "G02",
      "text": "«Модель» — показ текущей модели и её смена из чата",
      "status": "in-ticket"
    },
    {
      "id": "G03",
      "text": "«Контекст и расход» — сколько контекста занято и расход беседы рядом с полем ввода; сжатие контекста кнопкой",
      "status": "in-ticket"
    },
    {
      "id": "G04",
      "text": "«Очередь сообщений» — следующий запрос можно написать, пока агент работает; встаёт в очередь агента",
      "status": "in-ticket"
    },
    {
      "id": "G05",
      "text": "«Режим работы» — переключатель режима агента (план / авто-принятие правок / обычный) с показом текущего",
      "status": "in-ticket"
    },
    {
      "id": "G06",
      "text": "«…с миниатюрами и добавлением файлов» — к запросу прикладываются и произвольные файлы с устройства, не только картинки",
      "status": "in-ticket"
    },
    {
      "id": "G07",
      "text": "«Предупреждение и счётчик сбоев» — в сведениях о подключении счётчик неузнанных экранов по сессиям",
      "status": "in-ticket"
    },
    {
      "id": "G08",
      "text": "opencode: «Оставить ленту без ввода» — для него вкладка остаётся прежней лентой только для чтения",
      "status": "in-ticket"
    },
    {
      "id": "G09",
      "text": "деплой: «После каждого таска» — готовый таск сразу уезжает на relay (VPS) и в локальный агент",
      "status": "in-ticket"
    }
  ],
  "gates": {
    "G1": {
      "ok": true,
      "at": "2026-11-12T17:27:06+03:00",
      "open": 0,
      "total": 28
    },
    "G2": {
      "ok": false,
      "at": "2026-11-12T17:27:06+03:00",
      "found": 7,
      "fixed": 6,
      "deferred": 0
    },
    "G3": {
      "ok": true,
      "at": "2026-11-12T17:29:03+03:00",
      "problems": 0
    }
  },
  "result": null
}
