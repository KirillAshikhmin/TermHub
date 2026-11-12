# Действия чата на настоящих агентах — проверка 12.11.2026

Проверялись `sessionLive`, `sessionAct`, `sessionCommands` из собранного `packages/agent/dist`
на живых Claude Code и Codex в панели tmux. Только наблюдения.

| Что | Версия |
|---|---|
| Claude Code | 2.1.322 (запуск `claude --model haiku`, модель на экране — Haiku 5.5) |
| Codex CLI | 0.167.2 (`-c tui.animations=false --no-alt-screen`, усилие low, доверие каталогу через `-c projects=…`; для разрешений — второй запуск с `-s read-only -a on-request -c approvals_reviewer="user"`) |
| tmux | 3.7c |

Сокет `-L termhub-live-lc1`, пробный каталог `<probe>/work` (свой `git init`, три нейтральных
файла). Панель 200×50, затем проход 100×30. Одна сессия на агента одновременно.

Материалы рядом:
- `journal.jsonl` — каждая проверка: метка, действие, что ушло в панель (`sent`: `paste` — вставка,
  `keys` — байты в hex, `t` — мс от начала), ответ функции;
- `shots/<метка>.txt` — экран панели (`capture-pane -p -e`) после действия;
- `act.mjs`, `k.sh`, `q.sh`, `run-ro.sh` — чем запускалось.

Метки: `c…` — Claude 200×50, `cn…` — Claude 100×30, `x…` — Codex 200×50, `xn…` — Codex 100×30.

## Таблица

| # | Сценарий | Claude Code | Codex |
|---|---|---|---|
| 1 | `sessionLive` на ждущем | работает | **не работает до первого сообщения беседы**; после — работает |
| 2 | `prompt` ждущему: короткий / три строки / кириллица+эмодзи | работает | **не работает до первого сообщения**; после — работает |
| 3 | `prompt` работающему (очередь) | работает; **`queued` не назван на короткой беседе в высокой панели** | работает |
| 4 | непустая строка: `stale`, `take-input`, `over` | работает | работает |
| 5 | вопрос: чтение, кнопка, свой текст, устаревший отпечаток | работает | работает |
| 5 | несколько отметок, серия из двух и `step` | работает (два замечания по чтению) | не проверялось (в задании — только Claude) |
| 6 | разрешение: один раз / отклонить | работает | работает |
| 7 | `interrupt` на работающем | работает | работает (замечание про очередь) |
| 8 | `mode`: план и обратно | работает | работает |
| 9 | `model`: меню открылось | работает | работает |
| 10 | `compact` | работает | работает |
| 11 | слэш-команда ждущему | команда уходит; **экран `/help` не узнан** (`unknown`) | работает (`/status`) |
| 11 | слэш-команда работающему | команда уходит сразу, не в очередь; экран `/help` не узнан | **отказ `busy`**, команда не ушла |
| 12 | `sessionCommands` | работает (`verified: true`) | **первая сверка `verified: false`**, повторная — `true` |
| — | проход 100×30 (1, 2, 3, 5, 6, 7, 8, 9, 11, 12) | работает | работает |

## Не работает — подробности

### Codex: до первого сообщения беседы — `no-agent` (сценарии 1, 2)
- Действие: `sessionLive` и `prompt {text:"Reply with exactly: pong"}` на только что запущенном Codex.
- Вернуло: `{ok:false, reason:"no-agent", detail:"В панели cx:@0.%0 нет агента, пишущего транскрипт"}` — оба.
- Ушло в панель: ничего (`sent: []`).
- На экране: обычная пустая строка ввода Codex («› Ask Codex to do anything», подвал «Ready · Context 100% left»).
- Файла rollout у процесса в этот момент нет (открыты только базы состояния). После первого
  сообщения, набранного в панели вручную, `sessionLive` отвечает `ok:true`, и всё дальнейшее работает.
- Повторилось на втором запуске (метка `x01c-fresh-readonly`).
- Снимки: `shots/x01-fresh-screen.txt`, `shots/x01-live-idle.txt`, `shots/x01c-fresh-readonly.txt`.
- У Claude свежая сессия без беседы отвечает `ok:true` (`c01-live-idle`).

### Claude: `queued` не назван, хотя очередь на экране (сценарий 3)
- Действие: `prompt {text:"Reply with exactly: queued-ok"}` во время хода (шла команда оболочки).
- Вернуло: `ok:true`, `screen {kind:"working", status:"Quantumizing…", elapsed:17, input:""}` — поля `queued` нет.
- Ушло: вставка текста, затем `0d`.
- На экране: блок очереди «❯ Reply with exactly: queued-ok / ctrl+x ctrl+s to send now» стоит в строках
  15–16 экрана, строка работы — в строке 45 (между ними 28 пустых строк: беседа короткая, панель
  50 строк). Сообщение после конца хода отправилось само.
- То же действие при заполненном экране (`c07c-queue-full-screen`) и на 100×30 (`cn03b-queue`) — `queued: 1`.
- Снимок: `shots/c03c-prompt-while-working.txt`; для сравнения `shots/c07c-queue-full-screen.txt`.

### Claude: экран `/help` не узнан (сценарий 11)
- Действие: `prompt {text:"/help"}` ждущему и работающему агенту.
- Вернуло: `ok:true`, `screen {kind:"unknown", why:"dialog not recognized"}`; `sessionLive` затем — то же.
- Ушло: вставка `/help`, `0d`.
- На экране: окно справки Claude («Shortcuts … Esc to cancel»). У работающего агента окно открылось
  сразу, поверх идущего хода (в очередь команда не встала); пока оно открыто, `sessionLive` даёт
  `unknown`, хотя ход идёт. После Esc (нажат через tmux) — снова `working`/`idle`.
- `prompt {text:"/clear"}` ждущему: `ok:true`, `idle`, беседа очищена (`c11c-slash-clear`).
- Снимки: `shots/c11a-slash-help-idle.txt`, `shots/c11b-slash-while-working.txt`, `shots/c03d-live-queued.txt`.

### Codex: слэш-команда работающему — `busy` (сценарий 11)
- Действие: `prompt {text:"/status"}` во время хода.
- Вернуло: `{ok:false, reason:"busy", detail:"the agent shows a completion list at its input line and the text is not the command it would run: the command can be sent when the agent finishes its turn; the pasted text was removed from the agent input line"}`.
- Ушло: вставка `/status`, затем `15` (Ctrl+U). Enter и Tab не уходили.
- На экране после: строка ввода пуста, ход идёт, прежняя очередь на месте.
- Ждущему агенту та же команда: `ok:true`, вывод `/status` на экране (`x11a-slash-idle`, `xn11-slash`).
- Снимок: `shots/x11b-slash-while-working.txt`.

### Codex: первая сверка списка команд — `verified: false` (сценарий 12)
- Действие: `sessionCommands` (первый вызов, кэша нет; шла сразу после `compact`, в подвале ещё
  стояло «1 background terminal running»).
- Вернуло: `{ok:true, verified:false}`, 58 команд (55 builtin, 3 screen); заняло 5,8 с.
- Ушло: `2f` («/»), 65 раз `1b 5b 42` (стрелка вниз, шаг ~85 мс), в конце `7f`.
- На экране после: строка ввода пуста, файл кэша не записан.
- Второй вызов через минуту: 71 клавиша за 1,1 с, `verified:true`, кэш записан; строка пуста.
  На 100×30 — ответ из кэша, клавиш нет.
- Снимки: `shots/x12a-commands.txt`, `shots/x12c-commands-midway.txt` (середина второй сверки).
- У Claude: первый вызов — 150 клавиш за 2,2 с, `verified:true`, 139 команд (70 builtin, 3 skill,
  66 screen), строка пуста; после сверки Claude показал справа подсказку «Scroll wheel is sending
  arrow keys · use PgUp/PgDn to scroll» (`shots/c12a-commands.txt`).

## Работает — что именно наблюдалось

**1. `sessionLive`.** Claude: `agent:"claude"`, `version:"2.1.322"`, `tested:true`, `screen {kind:"idle",
mode:"auto", input:"", agentCount:2}` (в подвале Claude «← 2 agents» — не от проверки), `model` появился
после первого хода («Haiku 5.5»), 4 режима, 4 модели. Серая подсказка Claude в строке ввода («Повтори
команду…») за текст не принята: `input:""`. Codex (после первого сообщения): `version:"0.167.2"`,
`tested:true`, `model:"GPT-6-Astra"`, `mode:"default"`, 2 режима, 8 моделей.
Экран доверия каталогу Claude (до принятия): `no-agent` (`c00-trust`).

**2. `prompt` ждущему.** Оба: вставка + `0d`, `ok:true`, `kind:"working"`. Три строки дошли одним
запросом (транскрипт Claude — одна запись `user` с двумя `\n`; rollout Codex — одно сообщение).
Кириллица и эмодзи дошли без искажений. На 100×30 — так же.

**3. `prompt` работающему.** Claude: вставка + `0d`, сообщение в очереди Claude, после хода ушло само.
Codex: вставка + `09` (Tab), `queued:1`; второе сообщение с переносом — `queued:2`; после хода
отправилось. `compact` и `model` работающему — `busy` у обоих, клавиш нет. `take-input` работающему при
пустой строке — `ok:true, taken:""` у обоих (не `busy`), клавиш нет.

**4. Непустая строка.** `sessionLive` — `input:"ab"`. `prompt` без `over` — `stale` («agent input line
already has text»), клавиш нет. `take-input` — `taken:"ab"`, строка пуста (Claude: два `1b`; Codex: `03`).
`prompt … over` — стирание тем же способом, вставка, `0d`; отправлен только новый текст.
Codex: `take-input` вернул и многострочный текст (три строки) целиком.

**5. Вопросы.** Claude (AskUserQuestion): вопрос прочитан с подписями и пояснениями (в том числе
переносящимися на 100×30), `answer option:"2"` — клавиша `32`, ответ «Banana» в беседе. Свой текст —
`34`, текст, `0d`; в беседе «Груша 🍐 pear». Несколько отметок `options:["1","3"]` — `31`, `33`,
`1b 5b 43`, `31`; в беседе «Red, Blue». Серия из двух: ответ на первый перевёл на второй (`step:2`),
`step to:1` — `1b 5b 44`, `step to:2` — `1b 5b 43`, после второго ответа экран отправки
(«Ready to submit your answers?», `step:3`), `answer "1"` отправил; в беседе «Large, Slow».
Чужой отпечаток — `stale`, клавиш нет; `prompt` при вопросе на экране — `stale`
(«agent is not at its input line»), клавиш нет.
Codex (`request_user_input` в режиме плана): вопрос прочитан, четвёртым стоит «None of the above»,
`freeText:true`; кнопка — `32`, «answer: Banana». Свой текст — три стрелки вниз, `09`, текст, `0d`;
в беседе «answer: None of the above / note: Груша 🍐 pear». Чужой отпечаток — `stale`, клавиш нет.

Замечания по чтению (Claude):
- вопрос с отметками: у варианта «Type something» `hint:"Submit"` — строка кнопки отправки прочитана
  его пояснением (`shots/c05h-live-multi.txt`);
- серия: при возврате на отвеченный вопрос подпись выбранного варианта читается «Large ✔», отпечаток
  вопроса другой, чем при первом показе (`b4c10049a64bc6c7` → `581d6b80e1f7bc1a`), у шага стоят и
  `done`, и `current` (`shots/c05n-step-back.txt`).

**6. Разрешения.** Claude (режим manual; запись файла инструментом Write разрешения не попросила —
«Made 1 scratchpad edit», попросила команда оболочки): `kind:"permission"`, тело — команда и пояснение,
4 варианта. «Yes» — `31`, файл создан. «No» — `34`, файл не создан, в беседе «Interrupted · What should
Claude do instead?». Codex (запуск «только чтение»): карточка «Would you like to run the following
command?» с причиной и командой, 3 варианта. «Yes, proceed» — `31`, файл создан. «No…» — `33`,
«You canceled the request…», файл не создан. Постоянные разрешения не выбирались.

**7. `interrupt`.** Ждущему — `ok:true`, клавиш нет (оба). Работающему — один `1b`. Claude: «Interrupted ·
What should Claude do instead?»; сообщение из очереди Claude после этого отправил сам. Codex:
«Conversation interrupted»; **оба сообщения из очереди вернулись текстом в строку ввода** (не отправлены),
`sessionLive` показал их как `input` из трёх строк (`shots/xn07-interrupt.txt`). Команда оболочки Codex
после прерывания доработала в фоне («1 background terminal running» в подвале; поля `shells` в ответе нет).

**8. `mode`.** Claude: auto → plan — три `1b 5b 5a`, `mode:"plan"`, в подвале «plan mode on»; plan → auto —
один; → manual — один/два; несуществующий режим — `unsupported`, клавиш нет. Codex: default ↔ plan — по
одному `1b 5b 5a`, подвал «Plan mode» (на 100×30 подвал обрезан, режим читается верно).

**9. `model`.** Оба: `/model` + `0d`, `ok:true`, `screen {kind:"menu", menu:"model"}`; меню на экране
(Claude — «Select model», Codex — «Select Model and Effort»). Esc через tmux — `idle`, модель прежняя.

**10. `compact`.** Оба: `/compact` + `0d`. Claude: `status:"Compacting conversation…"`, затем «Compacted».
Codex: в ответе `status:"Working"`, на экране «Compacting context», затем «Context compacted · 15s».
Отказа на короткой беседе не было.

## Не воспроизведено

- Длинная команда `sleep 40` у Claude: её заблокировал хук владельца, а Claude отказался от замен
  (`python3 -c "…sleep…"`, `ping -c 50`). «Работающий агент» получен после `/clear` запуском пробного
  скрипта `primes.py` (считает простые числа заданное время).
- Запрос разрешения Claude на создание файла инструментом Write — не появился; разрешение проверено на
  команде оболочки.
- Несколько отметок и серия вопросов у Codex — не вызывались.
- `show-question` (ожидающий вопрос) — не вызывался.

## Следы вне репозитория

- `~/.claude.json` — запись о доверии пробному каталогу (принят экран доверия Claude).
- `~/.claude/projects/<ключ пробного каталога>/` — два файла бесед (до и после `/clear`) и каталог `memory`;
  в пробной сессии Claude создал `probe-a.txt` в собственном временном каталоге.
- `~/.codex/sessions/2026/11/12/` — два rollout пробных бесед (22:10 и 22:16) и строки в базах состояния
  Codex; там же в 22:18 и 22:19 появились два файла `guardian_review` — чьи они, не установлено.
- Codex при старте сам поднял свои MCP-серверы и `git clone` плагина из настроек владельца — завершились
  вместе с ним.
- `~/.termhub` не тронут: кэш сверки команд писался в `<probe>/state`.
- Репозиторий не менялся.

## Закрытие

Сессии закрывались сразу после своего агента (`cl` → `cx` → `cx2`). В конце `kill-server`:
`tmux -L termhub-live-lc1 list-sessions` → «no server running»; файл сокета удалён;
`ps` — процессов `claude --model haiku`, `codex …model_reasoning_effort=low`, `primes.py`, `run-ro.sh` нет.
