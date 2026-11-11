import assert from 'node:assert/strict'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { discoverTests, selectTests, executionPlan, excludedScripts } from './lib/test-catalog.mjs'
import { legacyScripts } from './lib/test-legacy-scripts.mjs'
import { createTestSandbox } from './lib/test-env.mjs'
import { runTestProcess, runTestPool } from './lib/test-process.mjs'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok) => {
  const root = await mkdtemp(join(tmpdir(), 'inkstone-harness-check-'))
  let serial = 0
  const fixture = async (name, source) => {
    const path = join(root, `${name}.mjs`)
    await writeFile(path, source)
    return path
  }
  const run = (script, options = {}) => runTestProcess({ script, logPath: join(root, `${++serial}.log`), ...options })
  try {
    const catalog = await discoverTests()
    const queue = selectTests(catalog, ['queue'])
    ok(queue.length === 6 && queue.every((test) => test.kind === 'standalone'), '六个队列套件都能按域执行，包括本机假服务 RPC')
    ok(selectTests(catalog, ['queue', 'queue-items', 'test-queue']).length === queue.length, '重复和重叠选择只执行一次')
    ok(selectTests(catalog, ['agents-doc']).length === 1, '完整名称精确选择文档测试')
    assert.throws(() => selectTests(catalog, ['no-such-suite']), /没有匹配/)
    ok(true, '零匹配不是成功')
    assert.throws(() => selectTests(catalog, ['queue', 'no-such-suite']), /没有匹配/)
    ok(true, '已有匹配不能掩盖另一个拼错的前缀')
    assert.throws(() => selectTests(catalog, ['../queue']), /无效/)
    ok(true, '拒绝路径和通配符输入')
    assert.throws(() => executionPlan(selectTests(catalog, ['turns']), true), /尚未独立/)
    ok(true, '未迁移套件不会空跑，也不会偷偷变成全量测试')
    for (const prefix of ['cc-delegation-live', 'packaged', 'browser-frame-network', 'comfyui-video']) {
      assert.throws(() => executionPlan(selectTests(catalog, [prefix]), true))
      ok(true, `${prefix} 不进入定向单测`)
    }
    const plan = executionPlan(catalog, false)
    ok(plan.legacy && plan.parallel.length > 0, '完整入口保留一次兼容套件')
    ok(!plan.parallel.some((name) => legacyScripts.has(name) || Object.hasOwn(excludedScripts, name)), '完整扫描不重复运行兼容项和有门槛的测试')
    const source = await readFile('scripts/test-unit-legacy.mjs', 'utf8')
    const referenced = new Set([...source.matchAll(/\.\/(test-[a-z0-9-]+)\.mjs/g)].map((match) => match[1]))
    const inProcess = source.match(/const inProcessScripts = \[([\s\S]*?)\n\]/)?.[1]
    assert.ok(inProcess)
    for (const match of inProcess.matchAll(/'(test-[a-z0-9-]+)'/g)) referenced.add(match[1])
    assert.deepEqual([...referenced].sort(), [...legacyScripts].sort())
    ok(true, '兼容清单与真实调用一致，避免漏跑或双跑')
    for (const name of ['test-queue-items', 'test-queue-draft-images', 'test-agents-doc']) {
      ok(plan.parallel.includes(name) && !legacyScripts.has(name), `${name} 单跑和全跑走同一份入口`)
    }

    const sandbox = createTestSandbox({ PATH: 'keep', YAN_CLI_TOKEN: 'drop', PI_PROBE: 'drop', FAKE_API_KEY: 'drop', FAKE_TOKEN: 'drop', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'drop' })
    try {
      ok(sandbox.env.PATH === 'keep' && !sandbox.env.YAN_CLI_TOKEN && !sandbox.env.PI_PROBE && !sandbox.env.FAKE_API_KEY && !sandbox.env.FAKE_TOKEN && !sandbox.env.ELECTRON_RUN_AS_NODE && !sandbox.env.ELECTRON_RENDERER_URL, '子进程环境清除宿主能力、凭据和 Electron 启动参数')
      ok(sandbox.env.YAN_PI_DIR === sandbox.env.PI_CODING_AGENT_DIR && Object.entries(sandbox.env).filter(([key]) => /^(YAN|PI)_/.test(key)).every(([, path]) => path.startsWith(sandbox.root) && existsSync(path)), '所有用户数据路径指向新建沙箱')
      ok(process.platform !== 'win32' || (sandbox.env.TEMP === sandbox.env.TMP && sandbox.root.startsWith(sandbox.env.TEMP) && sandbox.env.TEMP === realpathSync.native(sandbox.env.TEMP)), 'Windows 下子进程临时目录是展开后的长路径，沙箱建在其中')
    } finally {
      await rm(sandbox.root, { recursive: true, force: true })
    }
    const pass = await fixture('pass', "console.log(JSON.stringify({ data: process.env.YAN_DATA_DIR, pi: process.env.YAN_PI_DIR }))\n")
    const results = await runTestPool([pass, await fixture('pass-two', await readFile(pass, 'utf8'))], (script) => run(script), 2)
    const envs = results.map((result) => JSON.parse(result.tail))
    ok(results.every((result) => result.ok) && envs[0].data !== envs[1].data, '并行子进程不共享数据目录')
    ok(envs.every((env) => !existsSync(dirname(env.data))), '成功退出后沙箱被回收')
    ok((await readFile(results[0].logPath, 'utf8')).includes(envs[0].data.replaceAll('\\', '\\\\')), '成功测试也留下完整日志')
    const failure = await run(await fixture('failure', "console.error('fixture failure'); process.exitCode = 7\n"))
    ok(!failure.ok && failure.code === 7 && failure.tail.includes('fixture failure'), '非零退出与错误输出都保留')
    const thrown = await run(await fixture('thrown', "throw new Error('fixture exception')\n"))
    ok(!thrown.ok && thrown.tail.includes('fixture exception'), '未捕获异常使测试失败')
    const failedStart = await run(pass, { cwd: join(root, 'missing') })
    ok(!failedStart.ok && failedStart.error?.includes('ENOENT'), '启动错误只形成一条失败结果')
    const occupied = join(root, 'occupied.log')
    await writeFile(occupied, 'keep')
    const logFailure = await run(pass, { logPath: occupied })
    ok(!logFailure.ok && (await readFile(occupied, 'utf8')) === 'keep', '日志写入失败不能报通过，也不覆盖旧证据')

    const hang = await fixture('hang', `import { spawn } from 'node:child_process'
if (process.argv[2] === 'child') {
  console.log(JSON.stringify({ childPid: process.pid }))
} else {
  spawn(process.execPath, [process.argv[1], 'child'], { stdio: 'inherit' })
}
setInterval(() => {}, 1000)
`)
    const timeout = await run(hang, { timeoutMs: 3000 })
    ok(!timeout.ok && timeout.timedOut, '超时按失败处理')
    const childPid = JSON.parse(timeout.tail.trim()).childPid
    let alive = true
    try { process.kill(childPid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
    ok(!alive, '超时连同测试派生的子进程一起终止')

    const suiteUrl = pathToFileURL(resolve('scripts/lib/test-suite.mjs')).href
    const empty = await run(await fixture('empty', `import { runSuite } from ${JSON.stringify(suiteUrl)}\nawait runSuite(import.meta.url, () => {})\n`))
    ok(!empty.ok && empty.tail.includes('没有执行任何断言'), '导出式套件执行零条断言必须失败')
    const entry = join(root, 'module.ts')
    await writeFile(entry, 'export const where: string = import.meta.url\n')
    const compiledFixture = async (name, condition) => fixture(name, `import { runSuite } from ${JSON.stringify(suiteUrl)}
await runSuite(import.meta.url, async (ok, compile) => {
  const mod = await compile(${JSON.stringify(entry)})
  console.log('COMPILED=' + mod.where)
  ok(${condition}, 'fixture assertion')
})
`)
    const compiled = await runTestPool([await compiledFixture('compiled-a', true), await compiledFixture('compiled-b', true)], (script) => run(script), 2)
    const compiledPaths = compiled.map((result) => fileURLToPath(result.tail.match(/COMPILED=(.+)/)[1]))
    ok(compiled.every((result) => result.ok) && compiledPaths[0] !== compiledPaths[1], '并行编译不读写共享 out/test 产物')
    ok(compiledPaths.every((path) => !existsSync(dirname(path))), '成功套件清理自己的编译目录')
    const assertionFailure = await run(await compiledFixture('compiled-fail', false))
    ok(!assertionFailure.ok && !existsSync(dirname(fileURLToPath(assertionFailure.tail.match(/COMPILED=(.+)/)[1]))), '断言失败也清理自己的编译目录')
    const brokenEntry = join(root, 'broken.ts')
    await writeFile(brokenEntry, 'export const =')
    const broken = await run(await fixture('broken', `import { runSuite } from ${JSON.stringify(suiteUrl)}\nawait runSuite(import.meta.url, async (ok, compile) => { await compile(${JSON.stringify(brokenEntry)}); ok(true, 'unreachable') })\n`))
    ok(!broken.ok && broken.tail.includes('Build failed'), '编译失败不报成功')

    const cli = pathToFileURL(resolve('scripts/test-unit.mjs')).href
    const cliFixture = (name, args) => fixture(name, `process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, ...${JSON.stringify(args)}]\nawait import(${JSON.stringify(cli)})\n`)
    const listed = await run(await cliFixture('list', ['queue', '--list']))
    ok(listed.ok && listed.tail.includes('共 6 项') && !listed.tail.includes('个脚本通过'), '--list 只列清单，不执行')
    const noMatch = await run(await cliFixture('no-match', ['missing-test-prefix']))
    ok(!noMatch.ok && noMatch.tail.includes('没有匹配'), 'CLI 零匹配返回非零退出码')
    const badOption = await run(await cliFixture('bad-option', ['--wat']))
    ok(!badOption.ok && badOption.tail.includes('未知选项'), 'CLI 拼错参数不会退回全量执行')
    const legacyOnly = await run(await cliFixture('legacy', ['turns']))
    ok(!legacyOnly.ok && legacyOnly.tail.includes('尚未独立'), 'CLI 明确拒绝未迁移定向套件')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
