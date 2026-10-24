import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseGradleRuns,
  parseJunit,
  planGameTests,
  requiredJavaFor,
  runGameTests,
  summarizeGameTestPlan,
  summarizeGameTests,
  type GradleRunner
} from '../src/core/dev/gametest.ts'
import { createTestTools } from '../mcp/tools-test.ts'
import type { McpContext } from '../mcp/tools.ts'
import type { ToolResult } from '../mcp/protocol.ts'

let passed = 0
function test(name: string, run: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(run()).then(
    () => {
      passed += 1
      console.log(`✓ ${name}`)
    },
    (error: unknown) => {
      console.error(`✗ ${name}`)
      throw error
    }
  )
}

const PIT_BUILD = [
  'plugins {',
  '\tid \'net.fabricmc.fabric-loom\' version "${loom_version}"',
  '}',
  '',
  'loom {',
  '\tsplitEnvironmentSourceSets()',
  '',
  '\truns {',
  '\t\tgametest {',
  '\t\t\tserver()',
  '\t\t\tname = "Game Test"',
  '\t\t\tvmArg "-Dfabric-api.gametest"',
  '\t\t\tvmArg "-Dfabric-api.gametest.report-file=${project.layout.buildDirectory.get()}/junit.xml"',
  '\t\t\t// 只跑名字匹配的测试：./gradlew runGametest -Pfilters="thepit:*berserker*"',
  '\t\t\t// 值是通配符（* 与 ?，不是正则）；必须带命名空间。',
  '\t\t\tif (project.hasProperty("filters")) {',
  '\t\t\t\tvmArg "-Dfabric-api.gametest.filter=" + project.property("filters")',
  '\t\t\t}',
  '\t\t\trunDir "build/gametest"',
  '\t\t}',
  '\t\tclientGametest {',
  '\t\t\tclient()',
  '\t\t\tname = "Client Game Test"',
  '\t\t\tvmArg "-Dfabric.client.gametest"',
  '\t\t\tvmArg "-Dfabric.client.gametest.modid=thepit"',
  '\t\t\t// 这里是子串匹配（忽略大小写），匹配测试里列的场景别名',
  '\t\t\tString clientFilter = project.hasProperty("cfilters") ? project.property("cfilters")',
  '\t\t\t\t\t: (project.hasProperty("filters") ? project.property("filters") : null)',
  '\t\t\tif (clientFilter != null) {',
  '\t\t\t\tvmArg "-Dthepit.client.gametest.filter=" + clientFilter',
  '\t\t\t}',
  '\t\t\trunDir "build/client-gametest"',
  '\t\t}',
  '\t}',
  '}',
  '',
  'tasks.withType(JavaCompile).configureEach { it.options.release = 25 }',
  'java { sourceCompatibility = JavaVersion.VERSION_25 }'
].join('\n')

const NATIVE_BUILD = [
  "plugins { id 'fabric-loom' version '1.9-SNAPSHOT' }",
  'loom {',
  '    runs {',
  '        gametest {',
  '            server()',
  '            vmArg "-Dfabric-api.gametest"',
  '            runDir "build/gametest"',
  '        }',
  '    }',
  '}',
  'tasks.withType(JavaCompile).configureEach { it.options.release = 21 }'
].join('\n')

const KTS_BUILD = ['loom {', '    runs {', '        create("gametest") {', '            server()', '            vmArg("-Dfabric-api.gametest")', '        }', '    }', '}'].join('\n')

const JUNIT_MIXED = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<testsuite>',
  '<testsuite time="2.6" timestamp="2026-10-24T08:01:31Z">',
  '<testcase classname="fabric-gametest-api-v1:empty" name="thepit:a_passes" time="0.01"/>',
  '<testcase classname="fabric-gametest-api-v1:empty" name="thepit:b_fails" time="0.02">',
  '<failure message="Expected &quot;8s&quot; but was &quot;9s&quot;&#10;at com.thepit.Test.b(Test.java:42)">stack</failure>',
  '</testcase>',
  '<testcase name="thepit:c_error"><error message="boom"/></testcase>',
  '<testcase name="thepit:d_skipped"><skipped/></testcase>',
  '</testsuite>',
  '</testsuite>'
].join('\n')

const JUNIT_PASS = '<testsuite><testsuite><testcase name="thepit:one"/><testcase name="thepit:two"/></testsuite></testsuite>'
const JUNIT_ONE_FAIL = '<testsuite><testsuite><testcase name="thepit:one"/><testcase name="thepit:two"><failure message="nope"/></testcase></testsuite></testsuite>'
const JUNIT_EMPTY = '<testsuite><testsuite time="0.1"></testsuite></testsuite>'

function fixture(root: string, name: string, build: string, properties: string, file = 'build.gradle'): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), build)
  writeFileSync(join(dir, 'gradle.properties'), properties)
  return dir
}

function fakeRunner(calls: string[], xml: string, output = 'BUILD SUCCESSFUL in 9s\n'): GradleRunner {
  return async (projectDir, tasks, args) => {
    calls.push(`${tasks.join(' ')}|${args.join(' ')}`)
    await mkdir(join(projectDir, 'build'), { recursive: true })
    await writeFile(join(projectDir, 'build', 'junit.xml'), xml)
    return { ok: true, code: 0, durationMs: 1200, output }
  }
}

const root = mkdtempSync(join(tmpdir(), 'inkstone-gametest-'))
try {
  const pit = fixture(root, 'pit', PIT_BUILD, 'minecraft_version=26.1.2\nloom_version=1.18.4\n')
  const native = fixture(root, 'native', NATIVE_BUILD, 'minecraft_version=1.21.1\n')
  const nativeClient = fixture(root, 'native-client', NATIVE_BUILD.replace('server()', 'client()'), 'minecraft_version=1.21.1\n')
  await test('parseGradleRuns：项目自定义 -Pfilters / -Pcfilters 与原生键都识别', () => {
    const runs = parseGradleRuns(PIT_BUILD, pit)
    assert.equal(runs.length, 2)
    const [server, client] = runs
    assert.equal(server.task, 'runGametest')
    assert.equal(server.side, 'server')
    assert.equal(server.filterProperty, 'filters')
    assert.equal(server.filterKey, 'fabric-api.gametest.filter')
    assert.equal(server.filterKind, 'wildcard')
    assert.equal(server.reportFile, join(pit, 'build', 'junit.xml'))
    assert.equal(server.runDir, join(pit, 'build', 'gametest'))
    assert.equal(client.task, 'runClientGametest')
    assert.equal(client.side, 'client')
    assert.equal(client.filterProperty, 'cfilters')
    assert.equal(client.filterKey, 'thepit.client.gametest.filter')
    assert.equal(client.filterKind, 'substring')
    assert.equal(client.reportFile, null)
  })

  await test('parseGradleRuns：只有 Fabric 原生 vmArg 时没有 -P 属性', () => {
    const [run] = parseGradleRuns(NATIVE_BUILD, native)
    assert.equal(run.task, 'runGametest')
    assert.equal(run.side, 'server')
    assert.equal(run.filterProperty, null)
    assert.equal(run.filterKey, null)
    assert.equal(run.reportFile, null)
    const [clientRun] = parseGradleRuns(NATIVE_BUILD.replace('server()', 'client()'), nativeClient)
    assert.equal(clientRun.side, 'client')
    assert.equal(clientRun.task, 'runGametest')
  })

  await test('parseGradleRuns：kts 的 create("gametest") 也能认', () => {
    const [run] = parseGradleRuns(KTS_BUILD, pit)
    assert.equal(run.name, 'gametest')
    assert.equal(run.task, 'runGametest')
    assert.equal(run.filterKey, null)
  })

  await test('parseJunit：通过、失败、错误、跳过与实体解码', () => {
    const report = parseJunit(JUNIT_MIXED)
    assert.deepEqual(
      { total: report.total, passed: report.passed, failed: report.failed, errors: report.errors, skipped: report.skipped },
      { total: 4, passed: 1, failed: 1, errors: 1, skipped: 1 }
    )
    assert.equal(report.cases[1].message, 'Expected "8s" but was "9s"')
    assert.equal(report.cases[2].status, 'error')
    assert.equal(report.cases[2].message, 'boom')
    assert.equal(report.cases[0].timeMs, 10)
  })

  await test('parseJunit：空报告不报错', () => {
    const report = parseJunit(JUNIT_EMPTY)
    assert.equal(report.total, 0)
  })

  await test('requiredJavaFor：release、toolchain、sourceCompatibility 与 Minecraft 版本', async () => {
    assert.equal(await requiredJavaFor(pit), 25)
    assert.equal(await requiredJavaFor(native), 21)
    const toolchain = fixture(root, 'toolchain', 'java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }', '')
    assert.equal(await requiredJavaFor(toolchain), 17)
    const legacy = fixture(root, 'legacy', 'java { sourceCompatibility = JavaVersion.VERSION_1_8 }', '')
    assert.equal(await requiredJavaFor(legacy), 8)
    const byMinecraft = fixture(root, 'by-mc', 'plugins { id "fabric-loom" }', 'minecraft_version=1.21.1\n')
    assert.equal(await requiredJavaFor(byMinecraft), 21)
    const modern = fixture(root, 'modern', 'plugins { id "fabric-loom" }', 'minecraft_version=26.1.2\n')
    assert.equal(await requiredJavaFor(modern), 25)
    const unknown = fixture(root, 'unknown', 'plugins { id "fabric-loom" }', '')
    assert.equal(await requiredJavaFor(unknown), 21)
  })

  await test('runGameTests：过滤走项目自定义属性，返回通过数与报告路径', async () => {
    const calls: string[] = []
    const result = await runGameTests({ projectDir: pit, filter: 'thepit:*combat*', runner: fakeRunner(calls, JUNIT_PASS) })
    assert.equal(result.ok, true)
    assert.deepEqual(result.totals, { tests: 2, passed: 2, failed: 0, errors: 0, skipped: 0 })
    assert.deepEqual(calls, ['runGametest|--no-configuration-cache -Pfilters=thepit:*combat*'])
    assert.equal(result.reports[0], join(pit, 'build', 'junit.xml'))
    assert.equal(result.requiredJava, 25)
    assert.match(result.javaPath, /java(\.exe)?$/i)
    assert.equal(summarizeGameTests(result).split('\n')[0], 'GameTest 通过：2/2')
  })

  await test('runGameTests：没有自定义属性时退回 Fabric 原生 -D 并说明', async () => {
    const calls: string[] = []
    const result = await runGameTests({ projectDir: native, filter: 'mymod:*sword*', runner: fakeRunner(calls, JUNIT_PASS) })
    assert.ok(calls[0].includes('-Dfabric-api.gametest.filter=mymod:*sword*'))
    assert.ok(result.notes.some((note) => note.includes('Fabric 原生')))
    assert.equal(result.ok, true)
  })

  await test('runGameTests：用户接管时拒绝、不停止客户端也不跑 Gradle', async () => {
    const calls: string[] = []
    const result = await runGameTests({
      projectDir: pit,
      runner: fakeRunner(calls, JUNIT_PASS),
      client: { running: true, owner: 'user' },
      stopClient: async () => {
        calls.push('stop')
      }
    })
    assert.equal(result.refused, true)
    assert.equal(result.outcomes.length, 0)
    assert.deepEqual(calls, [])
    assert.match(summarizeGameTests(result).split('\n')[0], /^没有跑 GameTest：用户正在操作/)
  })

  await test('runGameTests：Agent 控制时先停客户端，restart_after 时才重启', async () => {
    const first: string[] = []
    const stopped = await runGameTests({
      projectDir: pit,
      runner: fakeRunner(first, JUNIT_PASS),
      client: { running: true, owner: 'agent' },
      stopClient: async () => {
        first.push('stop')
      },
      restartClient: async () => {
        first.push('restart')
      }
    })
    assert.equal(stopped.stoppedClient, true)
    assert.equal(stopped.restartedClient, false)
    assert.deepEqual(first, ['stop', 'runGametest|--no-configuration-cache'])
    assert.ok(stopped.notes.some((note) => note.includes('mc_run action=start')))

    const second: string[] = []
    const restarted = await runGameTests({
      projectDir: pit,
      runner: fakeRunner(second, JUNIT_PASS),
      client: { running: true, owner: 'agent' },
      restartAfter: true,
      stopClient: async () => {
        second.push('stop')
      },
      restartClient: async () => {
        second.push('restart')
      }
    })
    assert.equal(restarted.restartedClient, true)
    assert.deepEqual(second, ['stop', 'runGametest|--no-configuration-cache', 'restart'])
  })

  await test('runGameTests：side=both 各跑一次，客户端用 -Pcfilters', async () => {
    const calls: string[] = []
    const result = await runGameTests({ projectDir: pit, side: 'both', filter: '过氧化物', runner: fakeRunner(calls, JUNIT_PASS) })
    assert.equal(result.outcomes.length, 2)
    assert.equal(result.outcomes[0].side, 'server')
    assert.equal(result.outcomes[1].side, 'client')
    assert.deepEqual(calls, ['runGametest|--no-configuration-cache -Pfilters=过氧化物', 'runClientGametest|--no-configuration-cache -Pcfilters=过氧化物'])
    assert.equal(result.totals.tests, 4)
  })

  await test('runGameTests：有失败项时给出失败名单并判为失败', async () => {
    const result = await runGameTests({ projectDir: pit, runner: fakeRunner([], JUNIT_ONE_FAIL) })
    assert.equal(result.ok, false)
    assert.equal(result.totals.failed, 1)
    assert.deepEqual(result.outcomes[0].failures, [{ name: 'thepit:two', message: 'nope' }])
    const text = summarizeGameTests(result)
    assert.equal(text.split('\n')[0], 'GameTest 失败：1 项失败，通过 1/2')
    assert.match(text, /失败：thepit:two：nope/)
  })

  await test('runGameTests：过滤器没匹配到测试时明确说明', async () => {
    const result = await runGameTests({ projectDir: pit, filter: 'thepit:*nothing*', runner: fakeRunner([], JUNIT_EMPTY) })
    assert.equal(result.ok, false)
    assert.equal(result.totals.tests, 0)
    assert.ok(result.notes.some((note) => note.includes('一项测试都没跑')))
    assert.match(summarizeGameTests(result).split('\n')[0], /^GameTest 没有跑起来/)
  })

  await test('runGameTests：项目没有 GameTest 配置时给出写法', async () => {
    const bare = fixture(root, 'bare', 'plugins { id "fabric-loom" }', 'minecraft_version=1.21.1\n')
    const calls: string[] = []
    const result = await runGameTests({ projectDir: bare, runner: fakeRunner(calls, JUNIT_PASS) })
    assert.equal(result.ok, false)
    assert.deepEqual(calls, [])
    assert.match(result.notes[0], /没有 GameTest 运行配置/)
  })

  const stubContext = (projectDir: string, owner: 'agent' | 'user' | null, calls: string[]): McpContext =>
    ({
      options: { runtimesDir: root, javaPaths: [], maxMemoryMb: 4096, log: () => undefined },
      project: () => ({
        projectDir,
        status: async () => ({ state: 'running', world: 'inkstone-test', control: owner ? { owner, changedAt: 0, changedBy: owner } : null }),
        stop: async () => {
          calls.push('stop')
        },
        launch: async () => {
          calls.push('launch')
        }
      })
    }) as unknown as McpContext

  const toolOf = (name: string, context: McpContext) => {
    const found = createTestTools(context).find((tool) => tool.name === name)
    assert.ok(found, `找不到工具 ${name}`)
    return found
  }
  const bodyOf = (result: ToolResult): string => result.content.map((item) => item.text ?? '').filter(Boolean).join('\n')

  await test('mc_test：action=list 列出运行配置、JDK 与客户端状态', async () => {
    const list = await toolOf('mc_test', stubContext(pit, 'agent', [])).run({ action: 'list' })
    assert.equal(list.isError, undefined)
    const body = bodyOf(list)
    assert.match(body, /runGametest/)
    assert.match(body, /runClientGametest/)
    assert.match(body, /-Pfilters=/)
    assert.match(body, /JDK：.*java(\.exe)?（25，项目需要 25）/)
    assert.match(body, /控制方 agent/)
  })

  await test('mc_test：用户接管时返回 isError 且首行是原因，不停止客户端', async () => {
    const calls: string[] = []
    const refused = await toolOf('mc_test', stubContext(pit, 'user', calls)).run({ filter: 'thepit:*combat*' })
    assert.equal(refused.isError, true)
    assert.match(bodyOf(refused).split('\n')[0], /^没有跑 GameTest：用户正在操作开发客户端/)
    assert.deepEqual(calls, [])
  })

  await test('planGameTests：ThePit 项目实参能给出 JDK 与两份配置', async () => {
    const plan = await planGameTests(pit, [])
    assert.equal(plan.requiredJava, 25)
    assert.equal(plan.runs.length, 2)
    assert.match(summarizeGameTestPlan(plan), /检测到 2 个 GameTest 运行配置/)
  })

  console.log(`inkstone-minecraft gametest: ${passed} 项通过`)
} finally {
  rmSync(root, { recursive: true, force: true })
}

const liveAt = process.argv.indexOf('--live')
if (liveAt >= 0) {
  const projectDir = process.argv[liveAt + 1]
  assert.ok(projectDir, '--live 需要项目目录，例如 --live .tmp/inkstone-minecraft/thepit-238/ThePitMod "thepit:*combat*"')
  const filter = process.argv[liveAt + 2] ?? null
  const started = Date.now()
  const plan = await planGameTests(projectDir, [])
  console.log(summarizeGameTestPlan(plan))
  const result = await runGameTests({
    projectDir,
    filter,
    side: 'server',
    javaPaths: [],
    onLog: (line) => {
      if (/GAME TEST|All \d+ required|BUILD (SUCCESSFUL|FAILED)|Task :runGametest/.test(line)) console.log(`  | ${line}`)
    }
  })
  console.log(summarizeGameTests(result))
  console.log(
    JSON.stringify({
      ok: result.ok,
      filter,
      totals: result.totals,
      reports: result.reports,
      outcomes: result.outcomes.map((item) => ({ task: item.task, tests: item.tests, passed: item.passed, failed: item.failed, code: item.code, ms: item.durationMs, filterArg: item.filterArg })),
      java: result.javaPath,
      requiredJava: result.requiredJava,
      notes: result.notes,
      ms: Date.now() - started
    })
  )
  process.exitCode = result.ok ? 0 : 1
}
