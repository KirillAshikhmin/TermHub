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
  listTasks,
  parseTasksOutput,
} from '../src/gradle.js';

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
  it('детерминирован, укладывается в контракт имени и не сталкивается при обрезке', () => {
    const a = buildSessionName('my-project');
    expect(a).toBe(buildSessionName('my-project'));
    expect(a.startsWith('_gradle_my-project_')).toBe(true);
    expect(a).toMatch(/^[\w-]{1,40}$/);

    const long1 = buildSessionName('очень-длинное-имя-сессии-номер-один');
    const long2 = buildSessionName('очень-длинное-имя-сессии-номер-два');
    expect(long1.length).toBeLessThanOrEqual(40);
    expect(long2.length).toBeLessThanOrEqual(40);
    expect(long1).toMatch(/^[\w-]{1,40}$/);
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
