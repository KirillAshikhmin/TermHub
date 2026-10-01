// Шов 2: запуск/статус/остановка сборки на РЕАЛЬНОМ tmux с изолированным сокетом
// (-L termhub-test-<uniq>, kill-server в teardown). Настоящий Gradle не нужен —
// вместо него в папке проекта лежит ./gradlew-пустышка, поведение которой задаёт
// сам тест (спит, игнорирует Ctrl+C, падает с кодом).

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSessionName, runStatus, startRun, stopRun } from '../src/gradle.js';
import { runGradleAction } from '../src/gradle-action.js';
import { SessionService } from '../src/sessions.js';
import type { GradleRunState } from '@termhub/protocol';

/** Доступен ли tmux. Пропускать шов нельзя: без tmux продукт не работает, и молча
 *  снятый шов оставил бы прогон зелёным на непроверенном запуске сборки. */
let tmuxAvailable = false;
try {
  execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}
const NO_TMUX = 'tmux не найден: шов 2 (запуск сборки в tmux) не проверен — без tmux продукт не работает';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('gradle — запуск в tmux (изолированный сокет)', () => {
  const socketName = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
  const session = 'work';
  const buildName = buildSessionName(session);
  let root: string;
  let projectDir: string;

  function tmux(args: string[], socket: string = socketName): string {
    // stderr гасим: teardown зовёт kill-session/kill-server, которых может уже не быть.
    return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** Содержимое панели сборочной сессии. */
  function capture(): string {
    return tmux(['capture-pane', '-p', '-t', `=${buildName}:`]);
  }

  /** Рабочая папка панели сборочной сессии — та, из которой пошла команда. */
  function paneCwd(): string {
    return tmux(['display-message', '-p', '-t', `=${buildName}:`, '#{pane_current_path}']).trim();
  }

  /** Пустышка вместо gradlew: тело задаёт тест. */
  function fakeGradlew(body: string): void {
    fs.writeFileSync(path.join(projectDir, 'gradlew'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  /** Ждёт, пока в панели ПО-НАСТОЯЩЕМУ пойдёт команда (а не «вот-вот пойдёт»):
   *  login-оболочка читает ~/.zshrc не мгновенно. */
  async function waitBusy(timeoutMs: number, socket: string = socketName): Promise<string> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const cur = tmux(['display-message', '-p', '-t', `=${buildName}:`, '#{pane_current_command}'], socket).trim();
      if (cur === 'sleep' || Date.now() > until) return cur;
      await delay(100);
    }
  }

  /** Ждёт нужную фазу до timeoutMs и возвращает последнюю увиденную. */
  async function waitPhase(phase: string, timeoutMs: number): Promise<string> {
    const until = Date.now() + timeoutMs;
    let seen = '';
    for (;;) {
      seen = (await runStatus({ session, socketName })).phase;
      if (seen === phase || Date.now() > until) return seen;
      await delay(100);
    }
  }

  beforeAll(() => {
    if (!tmuxAvailable) throw new Error(NO_TMUX);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'termhub-gradle-'));
    projectDir = path.join(root, 'projectA');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'settings.gradle'), '');
  });

  afterAll(() => {
    try {
      tmux(['kill-server']);
    } catch {
      // сервер мог не подниматься — не ошибка
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    try {
      tmux(['kill-session', '-t', `=${buildName}`]);
    } catch {
      // сессии могло не быть
    }
  });

  it('tmux доступен — иначе шов проверять нечем', () => {
    expect(tmuxAvailable, NO_TMUX).toBe(true);
  });

  it('does not hide or stop a user session occupying a build name', async () => {
    fakeGradlew('exit 0');
    const name = buildSessionName(session);
    execFileSync('tmux', ['-L', socketName, 'new-session', '-d', '-s', name]);
    const svc = new SessionService({ roots: [projectDir], socketName });
    expect((await svc.list()).some((s) => s.name === name)).toBe(true);
    await expect(startRun({ session, dir: projectDir, tasks: ['build'], force: true, socketName })).rejects.toThrow(/occupied/);
    await expect(stopRun({ session, socketName })).rejects.toThrow(/occupied/);
    expect((await svc.list()).some((s) => s.name === name)).toBe(true);
  });

  it.each([undefined, 'some-other-source'])('rejects build metadata with source %s before reading or controlling it', async (owner) => {
    fakeGradlew('exit 0');
    tmux(['new-session', '-d', '-s', buildName]);
    tmux(['set-option', '-t', `=${buildName}:`, '@termhub_gradle_cmd', './gradlew privateTask']);
    tmux(['set-option', '-t', `=${buildName}:`, '@termhub_gradle_started', String(Date.now())]);
    if (owner !== undefined)
      tmux(['set-option', '-t', `=${buildName}:`, '@termhub_gradle_source', Buffer.from(owner).toString('base64')]);
    const before = tmux(['display-message', '-p', '-t', `=${buildName}:`, '#{session_id}']);
    await expect(runStatus({ session, socketName })).rejects.toThrow(/occupied/);
    await expect(stopRun({ session, socketName })).rejects.toThrow(/occupied/);
    await expect(stopRun({ session, socketName })).rejects.toThrow(/occupied/);
    await expect(startRun({ session, dir: projectDir, tasks: ['build'], force: true, socketName })).rejects.toThrow(/occupied/);
    expect(tmux(['display-message', '-p', '-t', `=${buildName}:`, '#{session_id}'])).toBe(before);
  });

  it('does not adopt or kill a pre-upgrade short-hash build', async () => {
    const legacyName = '_gradle_work_00e13e';
    tmux(['new-session', '-d', '-s', legacyName]);
    tmux(['set-option', '-t', `=${legacyName}:`, '@termhub_gradle_cmd', './gradlew oldTask']);
    const before = tmux(['display-message', '-p', '-t', `=${legacyName}:`, '#{session_id}']);
    try {
      fakeGradlew('exec sleep 20');
      await startRun({ session, dir: projectDir, tasks: ['newTask'], force: true, socketName });
      expect(tmux(['display-message', '-p', '-t', `=${legacyName}:`, '#{session_id}'])).toBe(before);
      expect(tmux(['show-options', '-qv', '-t', `=${legacyName}:`, '@termhub_gradle_cmd']).trim()).toBe('./gradlew oldTask');
      expect(tmux(['show-options', '-qv', '-t', `=${buildName}:`, '@termhub_gradle_source']).trim()).toBe('d29yaw==');
    } finally {
      tmux(['kill-session', '-t', `=${legacyName}`]);
    }
  });

  it('startRun поднимает сборочную сессию, доводит её до finished и печатает код выхода', async () => {
    fakeGradlew('exec sleep 2');

    const started = await startRun({ session, dir: projectDir, tasks: ['assembleDebug'], args: ['--offline'], socketName });
    expect(started.session).toBe(buildName);
    expect(started.command).toBe('./gradlew assembleDebug --offline');
    expect(started.startedAt).toBeGreaterThan(0);
    expect(started.phase).toBe('running');

    // Сессия живёт на изолированном сокете — и её панель стоит в папке проекта
    // (папка запуска — то, что здесь легко потерять, поэтому она тоже проверяется).
    expect(tmux(['list-sessions', '-F', '#{session_name}'])).toContain(buildName);
    expect(fs.realpathSync(paneCwd())).toBe(fs.realpathSync(projectDir));

    expect(await waitBusy(15000)).toBe('sleep');
    expect(await waitPhase('finished', 15000)).toBe('finished');
    // Хвост с printf доехал целиком — иначе кода выхода в панели не было бы.
    expect(capture()).toMatch(/\[termhub\] gradle exit=0/);
    // Завершившаяся сборка не убивает сессию: остаётся оболочка с выводом.
    expect(tmux(['list-sessions', '-F', '#{session_name}'])).toContain(buildName);
  }, 30000);

  it('запуск в подпапке берёт wrapper из КОРНЯ проекта, а не из папки запуска', async () => {
    // Многомодульная сборка: gradlew лежит только в корне, запуск идёт в <root>/app.
    fakeGradlew('echo wrapper-из-корня\nexec sleep 2');
    const appDir = path.join(projectDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'build.gradle'), '');

    const started = await startRun({
      session,
      root: projectDir,
      dir: appDir,
      tasks: [':app:assembleDebug'],
      socketName,
    });
    expect(started.command).toBe('../gradlew :app:assembleDebug');
    expect(started.phase).toBe('running');
    // Папка запуска — именно подпапка: wrapper адресуется из неё относительным путём.
    expect(fs.realpathSync(paneCwd())).toBe(fs.realpathSync(appDir));

    expect(await waitBusy(15000)).toBe('sleep');
    expect(await waitPhase('finished', 15000)).toBe('finished');
    const pane = capture();
    // Выполнился именно wrapper из корня, а не системный gradle.
    expect(pane).toContain('wrapper-из-корня');
    expect(pane).toMatch(/\[termhub\] gradle exit=0/);
  }, 30000);

  it('runStatus без сборочной сессии — idle', async () => {
    const st = await runStatus({ session, socketName });
    expect(st).toEqual({ phase: 'idle', session: null, command: null, startedAt: null });
  });

  it('нет ни ./gradlew, ни gradle в PATH login-оболочки — запуск отвергнут, сессия не создаётся', async () => {
    const bare = path.join(root, 'projectB');
    fs.mkdirSync(bare, { recursive: true });
    // Подменяем login-оболочку на такую же, но с пустым PATH: gradle в ней не найти.
    const shell = path.join(root, 'empty-path-shell');
    fs.writeFileSync(shell, '#!/bin/sh\nPATH=/nonexistent-termhub\nexport PATH\nexec /bin/sh -c "$2"\n', { mode: 0o755 });
    const prev = process.env.SHELL;
    process.env.SHELL = shell;
    try {
      await expect(startRun({ session, dir: bare, tasks: ['build'], socketName })).rejects.toThrow(
        /Neither \.\/gradlew nor gradle found/,
      );
    } finally {
      if (prev === undefined) delete process.env.SHELL;
      else process.env.SHELL = prev;
    }
    expect((await runStatus({ session, socketName })).phase).toBe('idle');
  }, 20000);

  it('запуск при идущей сборке: без force отдаёт её состояние, с force — перезапускает', async () => {
    fakeGradlew('exec sleep 20');

    const first = await startRun({ session, dir: projectDir, tasks: ['first'], socketName });
    expect(first.phase).toBe('running');
    expect(first.command).toBe('./gradlew first');

    // Ждём, пока команда реально займёт панель, и переживаем окно грации (5 с из §3
    // решения): дальше «running» может дать только живая команда в панели, а не отсрочка.
    expect(await waitBusy(15000)).toBe('sleep');
    await delay(Math.max(0, (first.startedAt ?? 0) + 6000 - Date.now()));
    const live = await runStatus({ session, socketName });
    expect(live.phase).toBe('running');
    expect(live.startedAt).toBe(first.startedAt);

    const again = await startRun({ session, dir: projectDir, tasks: ['second'], socketName });
    expect(again.phase).toBe('running');
    // Прежняя сборка не тронута: и команда, и время старта те же.
    expect(again.command).toBe('./gradlew first');
    expect(again.startedAt).toBe(first.startedAt);

    const forced = await startRun({ session, dir: projectDir, tasks: ['second'], socketName, force: true });
    expect(forced.phase).toBe('running');
    expect(forced.command).toBe('./gradlew second');
  }, 40000);

  it('stopRun шлёт Ctrl+C: сборка прерывается, сессия с выводом остаётся', async () => {
    fakeGradlew('exec sleep 30');
    await startRun({ session, dir: projectDir, tasks: ['longRun'], socketName });
    expect(await waitBusy(15000)).toBe('sleep');

    await stopRun({ session, socketName });
    expect(await waitPhase('finished', 10000)).toBe('finished');
    expect(tmux(['list-sessions', '-F', '#{session_name}'])).toContain(buildName);
  }, 30000);

  it('вторая «Стоп» подряд убивает сессию, если команда пережила Ctrl+C', async () => {
    fakeGradlew("trap '' INT\nexec sleep 30");
    await startRun({ session, dir: projectDir, tasks: ['stubborn'], socketName });
    expect(await waitBusy(15000)).toBe('sleep');

    await stopRun({ session, socketName });
    await delay(700);
    expect((await runStatus({ session, socketName })).phase).toBe('running');

    const killed = await stopRun({ session, socketName });
    expect(killed).toEqual({ phase: 'idle', session: null, command: null, startedAt: null });
    expect(await waitPhase('idle', 5000)).toBe('idle');
  }, 30000);

  it('startRun доносит JDK проекта (путь с пробелами) до сборочной сессии', async () => {
    // Ровно живой случай: JDK внутри Android Studio.app, записан в .gradle/config.properties.
    const jdkProject = path.join(root, 'projectC');
    const jdk = path.join(jdkProject, 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home');
    fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(jdk, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(jdkProject, 'settings.gradle'), '');
    fs.mkdirSync(path.join(jdkProject, '.gradle'), { recursive: true });
    fs.writeFileSync(path.join(jdkProject, '.gradle', 'config.properties'), `java.home=${jdk}\n`);
    // Пустышка печатает JAVA_HOME, который реально увидела команда.
    fs.writeFileSync(
      path.join(jdkProject, 'gradlew'),
      '#!/bin/sh\nprintf "JH=[%s]\\n" "$JAVA_HOME"\nexec sleep 1\n',
      { mode: 0o755 },
    );

    const started = await startRun({ session, dir: jdkProject, tasks: ['assembleDebug'], socketName });
    // Команда в статусе остаётся чистой: путь к JDK в неё не попадает.
    expect(started.command).toBe('./gradlew assembleDebug');
    // Переменная доехала до сессии значением, а не куском строки команды.
    expect(tmux(['show-environment', '-t', `=${buildName}`, 'JAVA_HOME']).trim()).toBe(`JAVA_HOME=${jdk}`);

    const until = Date.now() + 20000;
    let pane = '';
    for (;;) {
      // -J склеивает перенесённые строки: путь к JDK длиннее ширины панели.
      pane = tmux(['capture-pane', '-p', '-J', '-t', `=${buildName}:`]);
      if (pane.includes('JH=[') || Date.now() > until) break;
      await delay(200);
    }
    // JAVA_HOME, увиденный самой сборкой, — тот, что записан в проекте (а не из ~/.zshrc).
    expect(pane).toContain(`JH=[${jdk}]`);
  }, 40000);

  it('повторный export побеждает профиль оболочки, выставивший чужой JAVA_HOME', async () => {
    // Профиль пользователя (~/.zshrc и т.п.) читается уже ПОСЛЕ старта оболочки и
    // перебивает окружение сессии. Здесь это не свойство машины, а свойство теста:
    // сборочной сессии подсунута своя оболочка, которая заведомо экспортирует чужой JDK.
    const hostileShell = path.join(root, 'hostile-shell');
    fs.writeFileSync(hostileShell, '#!/bin/sh\nJAVA_HOME=/nonexistent/hostile-jdk\nexport JAVA_HOME\nexec /bin/sh -i\n', {
      mode: 0o755,
    });
    const projectD = path.join(root, 'projectD');
    const jdk = path.join(projectD, 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home');
    fs.mkdirSync(path.join(jdk, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(jdk, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
    fs.writeFileSync(path.join(projectD, 'settings.gradle'), '');
    fs.mkdirSync(path.join(projectD, '.gradle'), { recursive: true });
    fs.writeFileSync(path.join(projectD, '.gradle', 'config.properties'), `java.home=${jdk}\n`);
    fs.writeFileSync(path.join(projectD, 'gradlew'), '#!/bin/sh\nprintf "JH=[%s]\\n" "$JAVA_HOME"\nexec sleep 1\n', {
      mode: 0o755,
    });

    // Сервер без сессий не живёт, а set-option ему нужен живым — держим заглушкой.
    tmux(['new-session', '-d', '-s', 'keeper', '-c', root]);
    tmux(['set-option', '-g', 'default-command', hostileShell]);
    let pane = '';
    try {
      await startRun({ session, dir: projectD, tasks: ['assembleDebug'], socketName });
      const until = Date.now() + 20000;
      for (;;) {
        pane = tmux(['capture-pane', '-p', '-J', '-t', `=${buildName}:`]);
        if (pane.includes('JH=[') || Date.now() > until) break;
        await delay(200);
      }
    } finally {
      tmux(['set-option', '-gu', 'default-command']);
      tmux(['kill-session', '-t', '=keeper']);
    }
    expect(pane).toContain(`JH=[${jdk}]`);
    expect(pane).not.toContain('JH=[/nonexistent/hostile-jdk]');
  }, 40000);

  it('«Стоп уже слали» помнится отдельно для каждого сокета tmux', async () => {
    // Одно и то же имя рабочей сессии на двух сокетах — это две РАЗНЫЕ сборки. Общий
    // флаг превратил бы первый «Стоп» на втором сокете во второй: убил бы сессию,
    // не дав команде шанса завершиться по Ctrl+C.
    const otherSocket = `termhub-test-${crypto.randomBytes(4).toString('hex')}`;
    fakeGradlew("trap '' INT\nexec sleep 30");
    try {
      await startRun({ session, dir: projectDir, tasks: ['onFirst'], socketName });
      await startRun({ session, dir: projectDir, tasks: ['onSecond'], socketName: otherSocket });
      expect(await waitBusy(15000)).toBe('sleep');
      expect(await waitBusy(15000, otherSocket)).toBe('sleep');

      // Первый «Стоп» на первом сокете: Ctrl+C, сессия остаётся.
      await stopRun({ session, socketName });
      // На втором сокете это тоже ПЕРВЫЙ «Стоп» — значит тоже Ctrl+C, а не kill.
      const second = await stopRun({ session, socketName: otherSocket });
      expect(second.session).toBe(buildName);
      expect(second.command).toBe('./gradlew onSecond');
      expect(tmux(['list-sessions', '-F', '#{session_name}'], otherSocket)).toContain(buildName);
    } finally {
      try {
        tmux(['kill-server'], otherSocket);
      } catch {
        // сервер мог не подниматься — не ошибка
      }
    }
  }, 40000);

  it('стоп идущей сборки не требует каталога сессии: папку удалили — сборка всё равно останавливается', async () => {
    // Живой случай: сборка идёт, а каталог сессии переименовали или снесли. Резолв
    // корня нужен, чтобы ЗАПУСТИТЬ сборку, — статус и стоп относятся к tmux-сессии.
    const doomed = path.join(root, 'projectF');
    fs.mkdirSync(doomed, { recursive: true });
    fs.writeFileSync(path.join(doomed, 'settings.gradle'), '');
    fs.writeFileSync(path.join(doomed, 'gradlew'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    tmux(['new-session', '-d', '-s', session, '-c', doomed]);
    try {
      await startRun({ session, dir: doomed, tasks: ['longRun'], socketName });
      expect(await waitBusy(15000)).toBe('sleep');
      fs.rmSync(doomed, { recursive: true, force: true });

      const deps = { sessions: new SessionService({ roots: [root], socketName }), roots: [root], socketName };
      const st = (await runGradleAction(deps, { action: 'status', session })) as GradleRunState;
      expect(st.phase).toBe('running');
      const stopped = (await runGradleAction(deps, { action: 'stop', session })) as GradleRunState;
      expect(stopped.session).toBe(buildName);
      expect(await waitPhase('finished', 10000)).toBe('finished');
    } finally {
      try {
        tmux(['kill-session', '-t', `=${session}`]);
      } catch {
        // сессии могло не быть
      }
    }
  }, 30000);

  it('SessionService.list() не показывает сборочные сессии', async () => {
    fakeGradlew('exec sleep 20');
    tmux(['new-session', '-d', '-s', 'plain', '-c', projectDir]);
    await startRun({ session, dir: projectDir, tasks: ['hidden'], socketName });

    const svc = new SessionService({ roots: [root], socketName });
    const names = (await svc.list()).map((s) => s.name);
    expect(names).toContain('plain');
    expect(names).not.toContain(buildName);
    // Сессия при этом жива — её просто не показывают.
    expect(tmux(['list-sessions', '-F', '#{session_name}'])).toContain(buildName);

    tmux(['kill-session', '-t', '=plain']);
  }, 30000);
});
