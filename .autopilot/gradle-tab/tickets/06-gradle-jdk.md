# 06 — JDK проекта: выбирать так же, как его выбирает IDEA

**Требования:** D01 (служит R04, R07, R11i)
**Blocked by:** —
**Зона:** `packages/agent/src/gradle.ts`, `packages/agent/test/gradle.unit.test.ts`, `packages/agent/test/gradle.tmux.test.ts`
**Волна:** 6
**Status:** ready

## Что должно заработать

Список тасок и запуск сборки идут на том JDK, который для этого проекта выбрала бы
IDEA, а не на том, что случайно оказался в `JAVA_HOME` login-оболочки. На типичном
Android-проекте это разница между работающей вкладкой и пустым экраном с ошибкой.

## Что доказала сборка (D01)

Живая проверка 2026-08-22 на `~/AndroidStudioProjects/MyApplication`:

- `JAVA_HOME` пользователя — JDK 25, wrapper проекта — Gradle 8.9;
- `./gradlew tasks --all` через login-оболочку падает: `BUG! exception in phase
  'semantic analysis' … Unsupported class file major version 69`;
- в `.idea/gradle.xml` у проекта `gradleJvm = #GRADLE_LOCAL_JAVA_HOME`, а сам путь
  лежит в `<проект>/.gradle/config.properties`: `java.home=/Applications/Android Studio.app/Contents/jbr/Contents/Home`;
- тот же вызов с этим `JAVA_HOME` отрабатывает и печатает ровно тот формат,
  который парсит `parseTasksOutput`.

## Из брифа, дословно

> «На вкладке выбор таски для запуска»
> «с возможностью их запуска»

(Без правильного JDK ни то, ни другое на настоящем Android-проекте не работает.)

## Разделы спецификации

«Решения по реализации» §4 и §6 (§6 уже исправлен под это, абзац «Исправлено после
таска 05»); истории 5, 7, 8, 14, 17.

## Критерии приёмки

- [ ] JDK выбирается в порядке: `org.gradle.java.home` из `<проект>/gradle.properties` → то же из `~/.gradle/gradle.properties` → `java.home` из `<проект>/.gradle/config.properties` → окружение login-оболочки как раньше
- [ ] Выбранный JDK применяется и к `listTasks`, и к `startRun` — не только к списку
- [ ] Путь с пробелами (`/Applications/Android Studio.app/…`) работает. Для `startRun` передавай переменную через `tmux new-session -e JAVA_HOME=…`: это argv у `execFile`, никакой оболочечной кавычки не нужно. НЕ вклеивай присваивание в строку `send-keys`
- [ ] Несуществующий или неисполняемый путь из файла игнорируется как будто его нет (падение назад к следующему источнику), а не роняет вкладку
- [ ] Сигнатура кэша списка тасок учитывает выбранный JDK: сменился JDK — список перечитывается
- [ ] Тесты на шве 1: все четыре источника по порядку, приоритет, путь с пробелами, неисполняемый путь; на шве 2 — что `startRun` действительно доносит JAVA_HOME до панели (проверяемо `tmux show-environment` или эхом в команде-пустышке)
- [ ] `npx vitest run` зелёный целиком (было 564)
