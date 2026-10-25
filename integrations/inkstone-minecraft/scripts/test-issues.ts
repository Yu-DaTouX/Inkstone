import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { withOperations } from '../mcp/operations.ts'
import { text, type ToolDefinition } from '../mcp/protocol.ts'
import { createTools, type McpContext } from '../mcp/tools.ts'
import { createInteractTools } from '../mcp/tools-interact.ts'
import { CompanionError } from '../src/core/dev/companion.ts'
import { sendInput, sendScript, sendWait } from '../src/core/dev/interact.ts'
import { potentialJavaPaths } from '../src/core/dev/java.ts'
import { filterLogDetails } from '../src/core/dev/logs.ts'
import { DevProject } from '../src/core/dev/runner.ts'
import { argFileText, stablePlayerArgs, statePaths, writeJson, writeLaunchArgFile } from '../src/core/dev/session.ts'
import { readSource, searchSources, sourceRoots } from '../src/core/dev/sources.ts'

const root = await mkdtemp(join(tmpdir(), 'inkstone-issues-'))
const execute = promisify(execFile)
let passed = 0
let skipped = 0
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try { await run(); passed++; console.log(`✓ ${name}`) }
  catch (error) { console.error(`✗ ${name}`); throw error }
}
const body = (result: { content: Array<{ text?: string }> }) => result.content.map((item) => item.text ?? '').join('\n')
const context = (project: unknown) => ({ options: { runtimesDir: root, javaPaths: [], maxMemoryMb: 4096, log: () => undefined }, project: () => project, minecraft: async () => '26.1.2' }) as unknown as McpContext

try {
  await test('早期 Fabric ERROR 与堆栈保留，统计匹配数后取最后 N 行', () => {
    const log = '[WARN] [FabricLoader/Knot]: missing path\n[ERROR] [FabricLoader/GameProvider]: no game\n\tat sample.Mod.load(Mod.java:1)\n[12:00:00] [main/INFO]: info\n[12:00:01] [main/ERROR]: second\n'
    const result = filterLogDetails(log, { levels: ['ERROR'], lines: 2 })
    assert.equal(result.matchedLines, 3)
    assert.deepEqual(result.lines, ['\tat sample.Mod.load(Mod.java:1)', '[12:00:01] [main/ERROR]: second'])
  })
  await test('异常退出没有 crash-report 时返回启动日志', async () => {
    const paths = statePaths(root)
    const log = join(root, 'failed.log')
    await writeFile(log, '[ERROR] [FabricLoader/GameProvider]: could not locate game')
    await writeJson(paths.session, { pid: null, startedAt: Date.now() - 1000, stoppedAt: Date.now(), exitCode: 1, logFile: log, world: null })
    const project = new DevProject(root, { runtimesDir: root, javaPaths: [] })
    const result = await createTools(context(project)).find((tool) => tool.name === 'mc_logs')!.run({ crash: true })
    assert.match(body(result), /exitCode=1.*没有生成崩溃报告/s)
    assert.match(body(result), /could not locate game/)
  })
  await test('错误 rows 参数明确提示 grid，未写入贴图', async () => {
    const tools = createTools(context({ projectDir: root }))
    const result = await tools.find((tool) => tool.name === 'mc_texture')!.run({ action: 'write', texture: 'test.png', palette: { A: '#fff' }, rows: ['A'] })
    assert.equal(result.isError, true)
    assert.match(body(result), /未知参数：rows.*grid/)
    assert.equal(existsSync(join(root, 'test.png')), false)
  })
  await test('26.x 映射直接解释官方名，不发起映射下载', async () => {
    const result = await createTools(context({ projectDir: root })).find((tool) => tool.name === 'mc_mapping')!.run({ name: 'class_1571' })
    assert.match(body(result), /不再混淆.*mc_source/)
    assert.doesNotMatch(body(result), /先在项目里构建一次/)
  })
  await test('运行时 gen_sources 明确拒绝，保留既有客户端', async () => {
    let gradle = 0
    const project = { projectDir: root, status: async () => ({ pid: 123, state: 'running' }), gradle: async () => { gradle++; return { ok: true } } }
    const result = await createTools(context(project)).find((tool) => tool.name === 'mc_source')!.run({ action: 'gen_sources' })
    assert.equal(result.isError, true)
    assert.match(body(result), /已有源码可直接用 search\/read/)
    assert.equal(gradle, 0)
  })
  await test('mc_input 的拒绝、距离与 settle_ticks 保留到工具结果', async () => {
    const reply = await sendInput(async () => ({ ok: false, reason: 'out of reach', distance: 11, reach: 4.5 }), { action: 'use', target: { block: [0, 0, 0] } })
    assert.equal(reply.ok, false)
    assert.equal(reply.distance, 11)
    const project = { projectDir: root, companion: async (_path: string, request: Record<string, unknown>) => { assert.equal(request.settleTicks, 3); return { ok: false, reason: '目标超出可交互距离', distance: 11, reach: 4.5 } } }
    const result = await createInteractTools(context(project)).find((tool) => tool.name === 'mc_input')!.run({ action: 'attack', target_entity: '@e[limit=1]', settle_ticks: 3 })
    assert.equal(result.isError, true)
    assert.match(body(result), /操作未执行.*超出.*11\.00.*4\.50/s)
    assert.doesNotMatch(body(result), /已攻击|命中：/)
  })
  await test('in_world 在伴随 mod 未连接时重试，连接后完成', async () => {
    let calls = 0
    const reply = await sendWait(async () => { if (++calls === 1) throw new CompanionError(503, 'not ready'); return { ok: true, tick: 9, waitedMs: 5 } }, { until: 'in_world', timeoutMs: 1000 })
    assert.equal(reply.ok, true)
    assert.equal(calls, 2)
    assert.ok(reply.waitedMs >= 200)
  })
  await test('in_world 连接超时明确失败，用户接管与鉴权错误不重试', async () => {
    const reply = await sendWait(async () => { throw new Error('fetch failed: ECONNREFUSED') }, { until: 'in_world', timeoutMs: 25 })
    assert.equal(reply.reason, 'timeout')
    assert.equal(reply.ok, false)
    for (const status of [401, 423]) {
      let count = 0
      await assert.rejects(sendWait(async () => { count++; throw new CompanionError(status, 'denied') }, { until: 'in_world', timeoutMs: 1000 }))
      assert.equal(count, 1)
    }
  })
  await test('脚本命令的内层失败不会被旧伴随 mod 的 ok=true 掩盖', async () => {
    const reply = await sendScript(async () => ({ results: [{ index: 0, op: 'command', ok: true, result: { ok: false, output: ['测试失败'] } }] }), { steps: [{ op: 'command', command: 'execute if entity @e' }] })
    assert.equal(reply.results[0].ok, false)
    assert.match(reply.results[0].error!, /测试失败/)
    const allowed = await sendScript(async () => ({ results: [{ index: 0, op: 'command', ok: true, result: { ok: false } }] }), { steps: [{ op: 'command', expect: 'any', command: 'kill @e' }] })
    assert.equal(allowed.results[0].ok, true)
  })
  await test('脚本全局错误与条件等待参数向工具返回', async () => {
    let sent: Record<string, unknown> = {}
    const project = { projectDir: root, companion: async (_path: string, args: Record<string, unknown>) => { sent = args; return { ok: false, error: 'script timed out', results: [] } } }
    const result = await createInteractTools(context(project)).find((tool) => tool.name === 'mc_script')!.run({ steps: [{ op: 'wait', until: 'entity', selector: '@e[type=zombie]', timeout_ms: 500, poll_ticks: 3 }] })
    assert.equal(result.isError, true)
    assert.match(body(result), /脚本失败：script timed out/)
    const step = (sent.steps as Array<Record<string, unknown>>)[0]
    assert.equal(step.until, 'entity')
    assert.equal(step.timeoutMs, 500)
    assert.equal(step.pollTicks, 3)
  })
  await test('后台操作去重并保留最终结果；不同请求不串结果', async () => {
    let runs = 0
    const finishes = new Map<string, () => void>()
    const tool: ToolDefinition = { name: 'mc_build', title: 'build', description: '', inputSchema: { type: 'object' }, run: async (args) => { runs++; await new Promise<void>((resolve) => finishes.set(String(args.value), resolve)); return text(String(args.value)) } }
    const tools = withOperations([tool], () => root, 0)
    const first = await tools[0].run({ value: 'one' })
    const id = /operation_id=([^\n]+)/.exec(body(first))![1]
    assert.equal(body(await tools[0].run({ value: 'one', wait_ms: 0 })), body(first))
    const second = await tools[0].run({ value: 'two' })
    assert.notEqual(/operation_id=([^\n]+)/.exec(body(second))![1], id)
    finishes.get('one')!()
    finishes.get('two')!()
    const result = await tools[1].run({ operation_id: id, wait_ms: 1000 })
    assert.equal(body(result), 'one')
    assert.equal(runs, 2)
  })
  await test('后台错误明确可查询，未知 ID 提示先查实例状态', async () => {
    const tools = withOperations([{ name: 'mc_build', title: 'build', description: '', inputSchema: {}, run: async () => { throw new Error('build exploded') } }], () => root, 0)
    const first = await tools[0].run({})
    const id = /operation_id=([^\n]+)/.exec(body(first))![1]
    const failed = await tools[1].run({ operation_id: id, wait_ms: 1000 })
    assert.equal(failed.isError, true)
    assert.match(body(failed), /build exploded/)
    assert.match(body(await tools[1].run({ operation_id: 'missing' })), /先查询 mc_run action=status/)
  })
  await test('固定离线名字与 UUID 跨重启一致，保留登录身份', () => {
    const first = stablePlayerArgs(['--username', 'Player123', '--uuid', 'old', '--accessToken', '0'])
    const second = stablePlayerArgs(['--username', 'Player456', '--uuid', 'other', '--accessToken', '0'])
    assert.deepEqual(first, second)
    assert.equal(first[first.indexOf('--username') + 1], 'InkstoneAgent')
    assert.match(first[first.indexOf('--uuid') + 1], /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    const authenticated = ['--username', 'RealUser', '--uuid', 'real-uuid', '--accessToken', 'fixture-authenticated-token']
    assert.deepEqual(stablePlayerArgs(authenticated), authenticated)
    assert.throws(() => stablePlayerArgs(authenticated, 'Other'), /不能覆盖玩家身份/)
  })
  const java = [process.env.INKSTONE_TEST_JAVA, ...await potentialJavaPaths()].find((file): file is string => !!file && existsSync(join(dirname(file), process.platform === 'win32' ? 'javac.exe' : 'javac')))
  if (!java) { skipped += 3; console.log('SKIP: 3 个 JVM/JAR 夹具需要 JDK（可用 INKSTONE_TEST_JAVA 指定）') }
  else {
    const bin = dirname(java)
    const classes = join(root, '暮色 with space', 'classes')
    await mkdir(classes, { recursive: true })
    const source = join(root, 'Probe.java')
    await writeFile(source, 'public class Probe { public static void main(String[] args) { System.out.println("probe-ok"); System.out.println(java.util.UUID.nameUUIDFromBytes("OfflinePlayer:InkstoneAgent".getBytes(java.nio.charset.StandardCharsets.UTF_8))); } public void sampleMethod() {} }', 'utf8')
    await execute(join(bin, process.platform === 'win32' ? 'javac.exe' : 'javac'), ['-encoding', 'UTF-8', '-d', classes, source], { windowsHide: true })
    await test('后台 JVM 在含中文和空格的真实 classpath 上启动成功', async () => {
      const file = join(root, 'client.args')
      await writeLaunchArgFile(file, ['-cp', classes, 'Probe'])
      const result = await execute(java, [`@${file}`], { windowsHide: true })
      assert.match(result.stdout, /probe-ok/)
      const profile = stablePlayerArgs([])
      assert.ok(result.stdout.includes(profile[profile.indexOf('--uuid') + 1]))
      const settings = await execute(java, ['-XshowSettings:properties', '-version'], { windowsHide: true })
      const encoding = /native.encoding\s*=\s*(\S+)/.exec(settings.stderr)?.[1]
      if (process.platform === 'win32' && encoding && !/^UTF-?8$/i.test(encoding)) assert.notDeepEqual(await readFile(file), Buffer.from(argFileText(['-cp', classes, 'Probe']), 'utf8'))
    })
    const jar = join(root, 'fixture-api-1.0.jar')
    await execute(join(bin, process.platform === 'win32' ? 'jar.exe' : 'jar'), ['--create', '--file', jar, '-C', classes, '.'], { windowsHide: true })
    await test('依赖无源码时，按当前 classpath 读取 javap 公共 API 签名', async () => {
      const roots = await sourceRoots(root, join(root, 'cache'), null, [], ['deps'], { classpath: [jar], javaPath: java })
      const result = await readSource(roots, 'Probe')
      assert.match(result!.text, /公共 API 签名.*不是反编译源码/)
      assert.match(result!.text, /sampleMethod/)
      assert.ok(result!.file.startsWith('fixture-api-1.0.jar'))
      const found = await searchSources(roots, 'sampleMethod', { pathFilter: 'Probe.java' })
      assert.equal(found.filesScanned, 1)
      assert.ok(found.matches.some((match) => match.text.includes('sampleMethod')))
    })
    await test('完整 Java 文件路径与包名格式的 path_filter 一致', async () => {
      const dir = join(root, 'sources', 'net', 'example')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'Probe.java'), 'public class Probe { public void sampleMethod() {} }')
      const roots = [{ scope: 'project' as const, dir: join(root, 'sources'), label: 'fixture' }]
      for (const pathFilter of ['net/example/Probe.java', 'net.example.Probe', 'net\\example\\Probe.java', join(dir, 'Probe.java')]) {
        const result = await searchSources(roots, 'sampleMethod', { pathFilter })
        assert.equal(result.matches.length, 1)
        assert.equal(result.filesScanned, 1)
      }
    })
  }
  console.log(`Minecraft issues: ${passed} 项通过，${skipped} 项跳过`)
} finally { await rm(root, { recursive: true, force: true }) }
