import { describe, it, expect, afterAll, beforeEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSessionName,
  checkArgs,
  checkTaskName,
  detectProject,
  isBuildSessionName,
  listRunConfigs,
  jdkSources,
  listTasks,
  parseRunConfigXml,
  parseTasksOutput,
  propertyValue,
} from '../src/gradle.js';
import { runGradleAction } from '../src/gradle-action.js';
import type { SessionService } from '../src/sessions.js';

// Единственная внешняя команда модуля — чтение тасок; подменяем её целиком.
vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const mockExecFile = vi.mocked(execFile);

/** Ответ подменённой login-оболочки. */
function stubShell(handler: (cmd: string) => { err?: unknown; stdout?: string; stderr?: string }): void {
  mockExecFile.mockImplementation(((
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (e: unknown, o: string, s: string) => void,
  ) => {
    const r = handler(args[1] ?? '');
    cb(r.err ?? null, r.stdout ?? '', r.stderr ?? '');
    return {} as never;
  }) as never);
}

beforeEach(() => {
  mockExecFile.mockReset();
});

const tmpDirs: string[] = [];

/** Временный каталог под один тест (убирается в afterAll). */
async function mkTmp(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'termhub-gradle-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const d of tmpDirs) await fsp.rm(d, { recursive: true, force: true });
});

/** Кусок реального вывода `gradle tasks --all --console=plain -q` многомодульной сборки.
 *  «Other tasks» намеренно напечатана НЕ последней — порядок групп должен её опустить вниз. */
const MULTI_MODULE_OUTPUT = [
  '------------------------------------------------------------',
  "Tasks runnable from root project 'demo'",
  '------------------------------------------------------------',
  '',
  'Build tasks',
  '-----------',
  'assemble - Assembles the outputs of this project.',
  'app:assemble - Assembles the outputs of this project.',
  'app:assembleDebug - Assembles main outputs for all Debug variants.',
  'core:data:build - Assembles and tests this project.',
  '',
  'Other tasks',
  '-----------',
  'lint',
  'app:lintFix - Runs lint and applies safe suggestions.',
  'bad name! - Строка, не прошедшая проверку имени таски: в результат не попадает.',
  '',
  'Help tasks',
  '----------',
  "tasks - Displays the tasks runnable from root project 'demo'.",
  '',
  'Rules',
  '-----',
  'Pattern: clean<TaskName>: Cleans the output files of a task.',
  '',
  'To see more detail about a task, run gradle help --task <task>',
  '',
].join('\n');

describe('parseTasksOutput', () => {
  it('разбирает многомодульный вывод: подпроекты, группы, описания', () => {
    const r = parseTasksOutput(MULTI_MODULE_OUTPUT, 1700000000000);
    expect(r.fetchedAt).toBe(1700000000000);
    expect(r.groupOrder).toEqual(['Build tasks', 'Help tasks', 'Other tasks']);
    expect(r.tasks).toEqual([
      {
        name: 'assemble',
        project: ':',
        group: 'Build tasks',
        description: 'Assembles the outputs of this project.',
      },
      {
        name: ':app:assemble',
        project: ':app',
        group: 'Build tasks',
        description: 'Assembles the outputs of this project.',
      },
      {
        name: ':app:assembleDebug',
        project: ':app',
        group: 'Build tasks',
        description: 'Assembles main outputs for all Debug variants.',
      },
      {
        name: ':core:data:build',
        project: ':core:data',
        group: 'Build tasks',
        description: 'Assembles and tests this project.',
      },
      { name: 'lint', project: ':', group: 'Other tasks', description: '' },
      {
        name: ':app:lintFix',
        project: ':app',
        group: 'Other tasks',
        description: 'Runs lint and applies safe suggestions.',
      },
      {
        name: 'tasks',
        project: ':',
        group: 'Help tasks',
        description: "Displays the tasks runnable from root project 'demo'.",
      },
    ]);
  });
});

describe('detectProject', () => {
  it('находит маркеры и исполняемый wrapper', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'settings.gradle.kts'), '');
    await fsp.writeFile(path.join(dir, 'build.gradle.kts'), '');
    await fsp.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
    const p = await detectProject(dir);
    expect(p).toEqual({
      dir: path.resolve(dir),
      wrapper: true,
      markers: ['settings.gradle.kts', 'build.gradle.kts', 'gradlew'],
    });
  });

  it('видит неисполняемый gradlew как отсутствие wrapper', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'build.gradle'), '');
    await fsp.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n', { mode: 0o644 });
    const p = await detectProject(dir);
    expect(p?.markers).toEqual(['build.gradle', 'gradlew']);
    expect(p?.wrapper).toBe(false);
  });

  it('для обычной папки возвращает null', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'README.md'), 'hi');
    expect(await detectProject(dir)).toBeNull();
  });
});

describe('buildSessionName / isBuildSessionName', () => {
  it('separates source names with a known truncated SHA-256 collision', () => {
    expect(buildSessionName('aaaaaaaaaaaaaaaaaaaaaaaa3129'))
      .not.toBe(buildSessionName('aaaaaaaaaaaaaaaaaaaaaaaa6972'));
  });
  it('детерминирован, укладывается в контракт имени и не сталкивается при обрезке', () => {
    const a = buildSessionName('my-project');
    expect(a).toBe(buildSessionName('my-project'));
    expect(a.startsWith('_gradle_my-project_')).toBe(true);
    expect(a).toMatch(/^[\w-]+_[a-f0-9]{64}$/);

    const long1 = buildSessionName('очень-длинное-имя-сессии-номер-один');
    const long2 = buildSessionName('очень-длинное-имя-сессии-номер-два');
    expect(long1.length).toBeLessThanOrEqual(97);
    expect(long2.length).toBeLessThanOrEqual(97);
    expect(long1).toMatch(/^[\w-]+_[a-f0-9]{64}$/);
    expect(long1).not.toBe(long2);

    expect(isBuildSessionName(long1)).toBe(true);
    expect(isBuildSessionName('my-project')).toBe(false);
  });
});

describe('валидация тасок и аргументов', () => {
  it('пропускает нормальные и отвергает опасные значения', () => {
    expect(() => checkTaskName(':app:assembleDebug')).not.toThrow();
    expect(() => checkTaskName('clean')).not.toThrow();
    expect(() => checkTaskName('build; rm -rf /')).toThrow();
    expect(() => checkTaskName('$(whoami)')).toThrow();
    expect(() => checkTaskName('')).toThrow();
    expect(() => checkTaskName('a'.repeat(201))).toThrow();

    expect(() => checkArgs(['--offline', '-Pfoo=bar', '--tests=a.b.C'])).not.toThrow();
    expect(() => checkArgs([])).not.toThrow();
    expect(() => checkArgs(['-Pmsg=hello world'])).toThrow();
    expect(() => checkArgs(['`id`'])).toThrow();
    expect(() => checkArgs(new Array(33).fill('--offline'))).toThrow();
    expect(() => checkArgs(new Array(32).fill('--offline'))).not.toThrow();
  });
});

/** `.run/*.xml` — обёртка ProjectRunConfigurationManager. */
const RUN_BUILD_APP = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Build App" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="executionName" />
      <option name="externalProjectPath" value="$PROJECT_DIR$/app" />
      <option name="externalSystemIdString" value="GRADLE" />
      <option name="scriptParameters" value="--offline -Pfoo=bar" />
      <option name="taskDescriptions">
        <list />
      </option>
      <option name="taskNames">
        <list>
          <option value="clean" />
          <option value=":app:assembleDebug" />
        </list>
      </option>
      <option name="vmOptions" />
    </ExternalSystemSettings>
    <method v="2" />
  </configuration>
</component>
`;

const RUN_CONFIGURATIONS_TESTS = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Run &amp; Test" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="taskNames">
        <list>
          <option value="test" />
        </list>
      </option>
    </ExternalSystemSettings>
  </configuration>
</component>
`;

/** `.run`-конфигурация, чья папка запуска лежит ВНЕ корня проекта. */
const RUN_OUTSIDE = `<component name="ProjectRunConfigurationManager">
  <configuration default="false" name="Outside" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="externalProjectPath" value="$PROJECT_DIR$/../outside" />
      <option name="taskNames">
        <list>
          <option value="build" />
        </list>
      </option>
    </ExternalSystemSettings>
  </configuration>
</component>
`;

const WORKSPACE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="ChangeListManager">
    <configuration name="Not a run config" type="GradleRunConfiguration" />
  </component>
  <component name="RunManager" selected="Gradle.Build App">
    <configuration name="Build App" type="GradleRunConfiguration" factoryName="Gradle">
      <ExternalSystemSettings>
        <option name="taskNames">
          <list>
            <option value="wrongOne" />
          </list>
        </option>
      </ExternalSystemSettings>
    </configuration>
    <configuration name="App Main" type="Application" factoryName="Application">
      <option name="MAIN_CLASS_NAME" value="com.example.Main" />
    </configuration>
    <configuration name="Empty" type="GradleRunConfiguration" factoryName="Gradle" />
    <configuration name="Lint" type="GradleRunConfiguration" factoryName="Gradle">
      <ExternalSystemSettings>
        <option name="externalProjectPath" value="$PROJECT_DIR$" />
        <option name="scriptParameters" value="" />
        <option name="taskNames">
          <list>
            <option value="lint" />
          </list>
        </option>
      </ExternalSystemSettings>
    </configuration>
    <configuration name="Outside" type="GradleRunConfiguration" factoryName="Gradle">
      <ExternalSystemSettings>
        <option name="externalProjectPath" value="$PROJECT_DIR$" />
        <option name="taskNames">
          <list>
            <option value="build" />
          </list>
        </option>
      </ExternalSystemSettings>
    </configuration>
  </component>
</project>
`;

describe('parseRunConfigXml', () => {
  it('битый номер символа в сущности не роняет разбор файла', () => {
    // `&#99999999;` вне диапазона Unicode: раньше он бросал RangeError, и файл
    // пропадал целиком вместе с исправными конфигурациями рядом.
    const xml = `<component name="ProjectRunConfigurationManager">
  <configuration name="Bad &#99999999; entity" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="taskNames"><list><option value="build" /></list></option>
    </ExternalSystemSettings>
  </configuration>
</component>`;
    const configs = parseRunConfigXml(xml, { projectDir: '/tmp/proj', source: '.run' });
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toContain('&#99999999;');
    expect(configs[0].tasks).toEqual(['build']);
  });
});

describe('propertyValue (.properties по правилам java.util.Properties)', () => {
  it('разделителем ключа и значения служат «=», «:» и пробел', () => {
    expect(propertyValue('org.gradle.java.home=/opt/jdk\n', 'org.gradle.java.home')).toBe('/opt/jdk');
    expect(propertyValue('org.gradle.java.home:/opt/jdk\n', 'org.gradle.java.home')).toBe('/opt/jdk');
    expect(propertyValue('org.gradle.java.home /opt/jdk\n', 'org.gradle.java.home')).toBe('/opt/jdk');
    expect(propertyValue('org.gradle.java.home = /opt/jdk  \n', 'org.gradle.java.home')).toBe('/opt/jdk');
  });

  it('пробелы внутри значения сохраняются, а хвостовые отбрасываются', () => {
    expect(propertyValue('java.home=/Applications/Android Studio.app/Contents/jbr  \n', 'java.home')).toBe(
      '/Applications/Android Studio.app/Contents/jbr',
    );
  });

  it('комментарии «#» и «!» и пустые строки пропускаются', () => {
    const text = '#Wed Nov 06 11:05:39 MSK 2024\n\n!java.home=/wrong\n  java.home=/right\n';
    expect(propertyValue(text, 'java.home')).toBe('/right');
  });

  it('повторённый ключ берётся ПОСЛЕДНИЙ', () => {
    expect(propertyValue('k=first\nother=x\nk=last\n', 'k')).toBe('last');
  });

  it('значение, перенесённое хвостовым «\\», склеивается без ведущих пробелов продолжения', () => {
    expect(propertyValue('java.home=/opt/jdk-\\\n    21\n', 'java.home')).toBe('/opt/jdk-21');
    // Чётное число слэшей — это экранированный слэш, а не перенос.
    expect(propertyValue('java.home=/opt/jdk\\\\\nk=v\n', 'java.home')).toBe('/opt/jdk\\');
  });

  it('escape-последовательности значения разворачиваются (в том числе windows-путь)', () => {
    expect(propertyValue('java.home=C\\:\\\\Program Files\\\\jdk\n', 'java.home')).toBe('C:\\Program Files\\jdk');
    expect(propertyValue('k=a\\tb\\u0041\n', 'k')).toBe('a\tbA');
  });

  it('экранированный разделитель остаётся частью ключа', () => {
    expect(propertyValue('a\\ b=v\n', 'a b')).toBe('v');
    expect(propertyValue('a\\ b=v\n', 'a')).toBeNull();
  });

  it('ключ без значения даёт пустую строку, отсутствующий — null', () => {
    expect(propertyValue('java.home=\n', 'java.home')).toBe('');
    expect(propertyValue('java.home\n', 'java.home')).toBe('');
    expect(propertyValue('other=1\n', 'java.home')).toBeNull();
  });
});

describe('listRunConfigs', () => {
  it('читает три источника, фильтрует по типу, схлопывает дубли и режет выход за корень', async () => {
    const base = await mkTmp();
    const root = path.join(base, 'project');
    await fsp.mkdir(path.join(root, 'app'), { recursive: true });
    await fsp.mkdir(path.join(base, 'outside'), { recursive: true });
    await fsp.mkdir(path.join(root, '.run'), { recursive: true });
    await fsp.mkdir(path.join(root, '.idea', 'runConfigurations'), { recursive: true });

    await fsp.writeFile(path.join(root, '.run', 'build-app.xml'), RUN_BUILD_APP);
    // Битый файл: конфигурация не закрыта — пропускается, остальные читаются.
    await fsp.writeFile(
      path.join(root, '.run', 'broken.xml'),
      '<component><configuration name="Broken" type="GradleRunConfiguration">',
    );
    // Огромный файл (> 256 КБ) не читается вовсе.
    await fsp.writeFile(
      path.join(root, '.run', 'huge.xml'),
      `<!--${'x'.repeat(300 * 1024)}-->\n<configuration name="Huge" type="GradleRunConfiguration"/>`,
    );
    await fsp.writeFile(path.join(root, '.run', 'outside.xml'), RUN_OUTSIDE);
    await fsp.writeFile(path.join(root, '.idea', 'runConfigurations', 'tests.xml'), RUN_CONFIGURATIONS_TESTS);
    await fsp.writeFile(path.join(root, '.idea', 'workspace.xml'), WORKSPACE_XML);

    const configs = await listRunConfigs(root);
    // «Outside» отвергнута в .run за выход из корня — и НЕ воскресает из workspace.xml,
    // где под тем же именем лежит конфигурация внутри корня. «Empty» — без тасок,
    // «App Main» — не Gradle, «Not a run config» — вне компонента RunManager.
    expect(configs.map((c) => c.name)).toEqual(['Build App', 'Run & Test', 'Lint']);
    expect(configs[0]).toEqual({
      name: 'Build App',
      tasks: ['clean', ':app:assembleDebug'],
      args: '--offline -Pfoo=bar',
      dir: path.join(root, 'app'),
      source: '.run',
    });
    expect(configs[1]).toEqual({
      name: 'Run & Test',
      tasks: ['test'],
      args: '',
      dir: root,
      source: 'runConfigurations',
    });
    expect(configs[2]).toEqual({
      name: 'Lint',
      tasks: ['lint'],
      args: '',
      dir: root,
      source: 'workspace',
    });
  });

  it('читает не больше 100 файлов конфигураций', async () => {
    const root = await mkTmp();
    const runDir = path.join(root, '.run');
    await fsp.mkdir(runDir, { recursive: true });
    for (let i = 0; i <= 100; i += 1) {
      const n = String(i).padStart(3, '0');
      await fsp.writeFile(
        path.join(runDir, `cfg-${n}.xml`),
        `<component name="ProjectRunConfigurationManager">
  <configuration name="cfg-${n}" type="GradleRunConfiguration" factoryName="Gradle">
    <ExternalSystemSettings>
      <option name="taskNames"><list><option value="build" /></list></option>
    </ExternalSystemSettings>
  </configuration>
</component>`,
      );
    }
    const configs = await listRunConfigs(root);
    expect(configs).toHaveLength(100);
    expect(configs[0].name).toBe('cfg-000');
    expect(configs.at(-1)?.name).toBe('cfg-099');
  });

  it('не читает workspace.xml больше 4 МБ', async () => {
    const root = await mkTmp();
    await fsp.mkdir(path.join(root, '.idea'), { recursive: true });
    const padded = WORKSPACE_XML.replace('<project version="4">', `<project version="4">\n<!--${'x'.repeat(4 * 1024 * 1024)}-->`);
    expect(Buffer.byteLength(padded)).toBeGreaterThan(4 * 1024 * 1024);
    await fsp.writeFile(path.join(root, '.idea', 'workspace.xml'), padded);
    expect(await listRunConfigs(root)).toEqual([]);
  });

  it('без конфигураций отдаёт пустой список', async () => {
    const root = await mkTmp();
    await fsp.writeFile(path.join(root, 'build.gradle'), '');
    expect(await listRunConfigs(root)).toEqual([]);
  });
});

describe('runGradleAction — резолв путей', () => {
  /** Список сессий агента без tmux: обработчику нужен только name → path. */
  function stubSessions(name: string, dir: string): SessionService {
    return {
      list: async () => [
        { name, path: dir, command: 'zsh', activityTs: 1, attached: 0, bell: false, title: '' },
      ],
    } as unknown as SessionService;
  }

  it('называет НАСТОЯЩУЮ причину нечитаемости: файл в середине пути — это не отказ в правах', async () => {
    const root = await mkTmp();
    const projectDir = path.join(root, 'proj');
    await fsp.mkdir(projectDir);
    await fsp.writeFile(path.join(projectDir, 'settings.gradle'), '');
    // Обычный файл на месте каталога: realpath отвечает ENOTDIR, а не EACCES.
    await fsp.writeFile(path.join(projectDir, 'notadir'), 'x');
    const deps = { sessions: stubSessions('work', projectDir), roots: [root] };

    const call = runGradleAction(deps, {
      action: 'run',
      session: 'work',
      subdir: path.join('notadir', 'app'),
      tasks: ['help'],
    });
    await expect(call).rejects.toThrow(/Run directory is not a directory/);
    await expect(call).rejects.not.toThrow(/is not readable/);
  });
});

const TINY_TASKS_OUTPUT = ['Build tasks', '-----------', 'assemble - Assembles the outputs.', ''].join('\n');

describe('listTasks', () => {
  it('зовёт login-оболочку с константной строкой в папке проекта', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'settings.gradle'), '');
    await fsp.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    const r = await listTasks(dir);
    expect(r.tasks).toEqual([
      { name: 'assemble', project: ':', group: 'Build tasks', description: 'Assembles the outputs.' },
    ]);
    const [bin, args, opts] = mockExecFile.mock.calls[0] as [string, string[], { cwd: string; timeout: number }];
    expect(bin).toBe(process.env.SHELL || '/bin/sh');
    expect(args).toEqual(['-lc', './gradlew tasks --all --console=plain -q']);
    expect(opts.cwd).toBe(path.resolve(dir));
    expect(opts.timeout).toBe(180_000);
  });

  it('без исполняемого wrapper зовёт gradle из PATH', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'build.gradle.kts'), '');
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect((mockExecFile.mock.calls[0] as [string, string[]])[1]).toEqual([
      '-lc',
      'gradle tasks --all --console=plain -q',
    ]);
  });

  it('кэширует по mtime build-файлов; refresh и правка файла сбрасывают кэш', async () => {
    const dir = await mkTmp();
    const build = path.join(dir, 'build.gradle');
    await fsp.writeFile(build, '');
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    await listTasks(dir);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    await listTasks(dir, { refresh: true });
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    await listTasks(dir);
    expect(mockExecFile).toHaveBeenCalledTimes(2);

    const later = new Date(Date.now() + 60_000);
    await fsp.utimes(build, later, later);
    await listTasks(dir);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it('ошибку Gradle отдаёт как ошибку с хвостом stderr', async () => {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'build.gradle'), '');
    stubShell(() => ({
      err: Object.assign(new Error('Command failed'), { code: 1 }),
      stderr: 'FAILURE: Build failed with an exception.\n\n* What went wrong:\nCould not resolve all files.\n',
    }));

    await expect(listTasks(dir)).rejects.toThrow(/Could not resolve all files\./);
  });

  it('не читает таски у не-Gradle папки', async () => {
    const dir = await mkTmp();
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));
    await expect(listTasks(dir)).rejects.toThrow();
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('JDK проекта (§6): выбор источника и передача в listTasks', () => {
  const savedGradleUserHome = process.env.GRADLE_USER_HOME;
  let userHome: string;

  /** Каталог, похожий на настоящий JDK: с исполняемым bin/java. */
  async function fakeJdk(parent: string, ...segments: string[]): Promise<string> {
    const home = path.join(parent, ...segments);
    await fsp.mkdir(path.join(home, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(home, 'bin', 'java'), '#!/bin/sh\n', { mode: 0o755 });
    return home;
  }

  /** Папка Gradle-проекта с wrapper'ом. */
  async function gradleProject(): Promise<string> {
    const dir = await mkTmp();
    await fsp.writeFile(path.join(dir, 'settings.gradle'), '');
    await fsp.writeFile(path.join(dir, 'gradlew'), '#!/bin/sh\n', { mode: 0o755 });
    return dir;
  }

  /** `.gradle/config.properties` проекта — то, на что ссылается `#GRADLE_LOCAL_JAVA_HOME`. */
  async function writeConfigProperties(dir: string, javaHome: string): Promise<void> {
    await fsp.mkdir(path.join(dir, '.gradle'), { recursive: true });
    await fsp.writeFile(path.join(dir, '.gradle', 'config.properties'), `#Wed Nov 06 11:05:39 MSK 2024\njava.home=${javaHome}\n`);
  }

  /** Окружение и строка команды первого вызова оболочки. */
  function firstCall(): { cmd: string; env: NodeJS.ProcessEnv | undefined } {
    const [, args, opts] = mockExecFile.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    return { cmd: args[1], env: opts.env };
  }

  beforeEach(async () => {
    // Настоящий ~/.gradle/gradle.properties разработчика не должен влиять на тест.
    userHome = await mkTmp();
    process.env.GRADLE_USER_HOME = userHome;
  });

  afterAll(() => {
    if (savedGradleUserHome === undefined) delete process.env.GRADLE_USER_HOME;
    else process.env.GRADLE_USER_HOME = savedGradleUserHome;
  });

  it('источник 1: org.gradle.java.home из gradle.properties проекта', async () => {
    const dir = await gradleProject();
    const jdk = await fakeJdk(dir, 'jdk-project');
    await fsp.writeFile(path.join(dir, 'gradle.properties'), `org.gradle.jvmargs=-Xmx2048m\norg.gradle.java.home=${jdk}\n`);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    const call = firstCall();
    expect(call.env?.JAVA_HOME).toBe(jdk);
    // Перед самой командой JAVA_HOME экспортируется ещё раз — из отдельной переменной,
    // а не из строки: профиль пользователя успевает перебить переданное окружение.
    expect(call.env?.TERMHUB_JAVA_HOME).toBe(jdk);
    expect(call.cmd).toBe('export JAVA_HOME="$TERMHUB_JAVA_HOME"; ./gradlew tasks --all --console=plain -q');
  });

  it('источник 2: org.gradle.java.home из ~/.gradle/gradle.properties', async () => {
    const dir = await gradleProject();
    const jdk = await fakeJdk(userHome, 'jdk-user');
    await fsp.writeFile(path.join(userHome, 'gradle.properties'), `org.gradle.java.home=${jdk}\n`);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(jdk);
  });

  it('источник 3: java.home из <проект>/.gradle/config.properties', async () => {
    const dir = await gradleProject();
    const jdk = await fakeJdk(dir, 'jdk-config');
    await writeConfigProperties(dir, jdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(jdk);
  });

  it('источник 4: без единого файла окружение login-оболочки не трогается', async () => {
    const dir = await gradleProject();
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    const call = firstCall();
    expect(call.env).toBeUndefined();
    expect(call.cmd).toBe('./gradlew tasks --all --console=plain -q');
  });

  it('приоритет: проектный gradle.properties сильнее пользовательского и config.properties', async () => {
    const dir = await gradleProject();
    const projectJdk = await fakeJdk(dir, 'jdk-project');
    const userJdk = await fakeJdk(userHome, 'jdk-user');
    const configJdk = await fakeJdk(dir, 'jdk-config');
    await fsp.writeFile(path.join(dir, 'gradle.properties'), `org.gradle.java.home=${projectJdk}\n`);
    await fsp.writeFile(path.join(userHome, 'gradle.properties'), `org.gradle.java.home=${userJdk}\n`);
    await writeConfigProperties(dir, configJdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(projectJdk);
  });

  it('приоритет: пользовательский gradle.properties сильнее config.properties', async () => {
    const dir = await gradleProject();
    const userJdk = await fakeJdk(userHome, 'jdk-user');
    const configJdk = await fakeJdk(dir, 'jdk-config');
    await fsp.writeFile(path.join(userHome, 'gradle.properties'), `org.gradle.java.home=${userJdk}\n`);
    await writeConfigProperties(dir, configJdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(userJdk);
  });

  it('путь с пробелами доезжает целиком и в строку команды не попадает', async () => {
    const dir = await gradleProject();
    // Ровно тот случай, ради которого таск и заведён: JDK внутри Android Studio.app.
    const jdk = await fakeJdk(dir, 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home');
    await writeConfigProperties(dir, jdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    const call = firstCall();
    expect(call.env?.JAVA_HOME).toBe(jdk);
    expect(jdk).toContain('Android Studio.app');
    expect(call.cmd).not.toContain('Android Studio');
  });

  it('несуществующий путь из файла игнорируется — берётся следующий источник', async () => {
    const dir = await gradleProject();
    const userJdk = await fakeJdk(userHome, 'jdk-user');
    await fsp.writeFile(path.join(dir, 'gradle.properties'), `org.gradle.java.home=${path.join(dir, 'no-such-jdk')}\n`);
    await fsp.writeFile(path.join(userHome, 'gradle.properties'), `org.gradle.java.home=${userJdk}\n`);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(userJdk);
  });

  it('неисполняемый bin/java игнорируется — берётся следующий источник', async () => {
    const dir = await gradleProject();
    const broken = path.join(dir, 'jdk-broken');
    await fsp.mkdir(path.join(broken, 'bin'), { recursive: true });
    await fsp.writeFile(path.join(broken, 'bin', 'java'), '', { mode: 0o644 });
    const configJdk = await fakeJdk(dir, 'jdk-config');
    await fsp.writeFile(path.join(dir, 'gradle.properties'), `org.gradle.java.home=${broken}\n`);
    await writeConfigProperties(dir, configJdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env?.JAVA_HOME).toBe(configJdk);
  });

  it('ни один источник не подошёл — окружение остаётся как было', async () => {
    const dir = await gradleProject();
    await fsp.writeFile(path.join(dir, 'gradle.properties'), `org.gradle.java.home=${path.join(dir, 'no-such-jdk')}\n`);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    expect(firstCall().env).toBeUndefined();
  });

  it('кэш перечитывается при правке ЛЮБОГО источника JDK — списком источников служит сам jdkSources', async () => {
    // Перебираем ровно те источники, по которым JDK и выбирается: четвёртый, если его
    // однажды добавят, попадёт сюда сам — и обязан будет сбрасывать кэш наравне с этими.
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));
    const lastEnv = (): NodeJS.ProcessEnv | undefined =>
      (mockExecFile.mock.calls.at(-1) as [string, string[], { env?: NodeJS.ProcessEnv }])[2].env;

    for (let i = 0; i < jdkSources('/probe').length; i += 1) {
      const dir = await gradleProject();
      // Свой каталог настроек пользователя на итерацию: источник 2 живёт именно там.
      process.env.GRADLE_USER_HOME = await mkTmp();
      const src = jdkSources(dir)[i];
      const before = await fakeJdk(dir, `jdk-${i}-before`);
      const after = await fakeJdk(dir, `jdk-${i}-after-and-longer`);
      await fsp.mkdir(path.dirname(src.file), { recursive: true });
      await fsp.writeFile(src.file, `${src.key}=${before}\n`);

      const calls = mockExecFile.mock.calls.length;
      await listTasks(dir);
      expect(lastEnv()?.JAVA_HOME, `источник ${i}: JDK не подхватился`).toBe(before);
      await listTasks(dir);
      expect(mockExecFile.mock.calls.length, `источник ${i}: кэш не сработал`).toBe(calls + 1);

      await fsp.writeFile(src.file, `${src.key}=${after}\n`);
      await listTasks(dir);
      expect(mockExecFile.mock.calls.length, `источник ${i}: правка не сбросила кэш`).toBe(calls + 2);
      expect(lastEnv()?.JAVA_HOME, `источник ${i}: подставлен прежний JDK`).toBe(after);
    }
  });

  it('попадание в кэш не читает ни одного файла .properties — ключ дешевле того, что кэш экономит', async () => {
    const dir = await gradleProject();
    const jdk = await fakeJdk(dir, 'jdk-config');
    await writeConfigProperties(dir, jdk);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));
    await listTasks(dir);

    const reads = vi.spyOn(fsp, 'readFile');
    try {
      // Промах читает .properties — этим же проверяется, что спай вообще ловит чтения.
      await listTasks(dir, { refresh: true });
      expect(reads.mock.calls.filter((c) => String(c[0]).endsWith('.properties')).length).toBeGreaterThan(0);
      reads.mockClear();

      await listTasks(dir);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(reads.mock.calls.map((c) => String(c[0]))).toEqual([]);
    } finally {
      reads.mockRestore();
    }
  });

  it('сменился JDK — список перечитывается, хотя build-файлы не тронуты', async () => {
    const dir = await gradleProject();
    const first = await fakeJdk(dir, 'jdk-first');
    const second = await fakeJdk(dir, 'jdk-second');
    await writeConfigProperties(dir, first);
    stubShell(() => ({ stdout: TINY_TASKS_OUTPUT }));

    await listTasks(dir);
    await listTasks(dir);
    expect(mockExecFile).toHaveBeenCalledTimes(1);

    await writeConfigProperties(dir, second);
    await listTasks(dir);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
    const [, args, opts] = mockExecFile.mock.calls[1] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(opts.env?.JAVA_HOME).toBe(second);
    expect(args[1]).toContain('tasks --all');
  });
});
