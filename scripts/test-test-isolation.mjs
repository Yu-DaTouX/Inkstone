import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverTests, hostEnvScripts } from './lib/test-catalog.mjs'
import { runSuite } from './lib/test-suite.mjs'

const isolateUrl = pathToFileURL(resolve('scripts/lib/test-isolate.mjs')).href

const probeSource = `
import ${JSON.stringify(isolateUrl)}
import fs, { createWriteStream, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { appendFile, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const real = join(homedir(), '.pi', 'agent')
const target = join(real, 'yan', 'subagents', 'sub-probe.json')
const outcome = {}
const attempt = async (name, run) => {
  try { await run(); outcome[name] = 'allowed' } catch (error) { outcome[name] = error.code === 'EINKSTONE_TEST_REAL_DATA' ? 'blocked' : 'other:' + error.code }
}
await attempt('writeFileSync', () => writeFileSync(target, '{}'))
await attempt('mkdirSync', () => mkdirSync(join(real, 'yan', 'x'), { recursive: true }))
await attempt('openSyncWrite', () => openSync(target, 'w'))
await attempt('openSyncRead', () => openSync(join(real, 'definitely-missing'), 'r'))
await attempt('createWriteStream', () => createWriteStream(target))
await attempt('writeFile', () => writeFile(target, '{}'))
await attempt('appendFile', () => appendFile(target, '{}'))
await attempt('mkdir', () => mkdir(join(real, 'yan', 'y'), { recursive: true }))
await attempt('openAppend', () => open(target, 'a'))
await attempt('renameInto', () => rename(join(process.env.YAN_DATA_DIR, 'none'), target))
await attempt('rm', () => rm(real, { recursive: true, force: true }))
await attempt('fsCallback', () => new Promise((resolve, reject) => { try { fs.writeFile(target, '{}', (error) => error ? reject(error) : resolve()) } catch (error) { reject(error) } }))
await attempt('readFileSync', () => readFileSync(join(real, 'definitely-missing')))
await attempt('writeInsideSandbox', () => writeFile(join(process.env.YAN_DATA_DIR, 'ok.json'), '{}'))
console.log(JSON.stringify({ outcome, data: process.env.YAN_DATA_DIR, pi: process.env.YAN_PI_DIR, apiKey: process.env.OPENAI_API_KEY ?? null }))
`

await runSuite(import.meta.url, async (ok) => {
  const work = await mkdtemp(join(tmpdir(), 'inkstone-isolation-probe-'))
  try {
    const fakeHome = join(work, 'home')
    const fakeReal = join(fakeHome, '.pi', 'agent')
    await mkdir(join(fakeReal, 'yan', 'subagents'), { recursive: true })
    const script = join(work, 'probe.mjs')
    await writeFile(script, probeSource)
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, YAN_DATA_DIR: join(fakeReal, 'yan'), YAN_PI_DIR: fakeReal, PI_CODING_AGENT_DIR: fakeReal, OPENAI_API_KEY: 'sk-host' }
    delete env.YAN_USER_DATA
    const run = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 })
    ok(run.status === 0, '探针进程正常退出', run.stderr)
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).pop())
    const blocked = ['writeFileSync', 'mkdirSync', 'openSyncWrite', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir', 'openAppend', 'renameInto', 'rm', 'fsCallback']
    for (const name of blocked) ok(result.outcome[name] === 'blocked', `写入真实数据目录被拦：${name}`, result.outcome[name])
    ok(result.outcome.openSyncRead === 'other:ENOENT' && result.outcome.readFileSync === 'other:ENOENT', '读取真实数据目录不受限')
    ok(result.outcome.writeInsideSandbox === 'allowed', '隔离目录内正常写入')
    ok(/inkstone-test-/.test(result.data) && /inkstone-test-/.test(result.pi), '宿主 YAN_* 被替换为临时隔离目录', result.data)
    ok(result.apiKey === null, '宿主凭据环境变量被清除')
    ok(!existsSync(join(fakeReal, 'yan', 'subagents', 'sub-probe.json')) && !existsSync(join(fakeReal, 'yan', 'x')), '被拦的写入没有留下文件')
    ok(!existsSync(result.data.replace(/[\\/]data$/, '')), '进程退出后临时隔离根目录已清理')
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 3 })
  }

  const catalog = await discoverTests()
  const unguarded = []
  const misplaced = []
  for (const { name } of catalog) {
    const text = await readFile(join('scripts', `${name}.mjs`), 'utf8')
    const declared = Object.hasOwn(hostEnvScripts, name)
    const usesSuite = text.includes('./lib/test-suite.mjs')
    const usesIsolate = text.includes('./lib/test-isolate.mjs')
    if (declared) {
      if (usesSuite || usesIsolate) misplaced.push(name)
    } else if (!usesSuite && !usesIsolate) {
      unguarded.push(name)
    } else if (!usesSuite) {
      const first = text.split(/\r?\n/).find((line, index) => !(index === 0 && line.startsWith('#!')) && line.trim())
      if (first !== "import './lib/test-isolate.mjs'") unguarded.push(`${name}（隔离导入必须是第一条语句）`)
    }
  }
  ok(unguarded.length === 0, '每个测试脚本都默认隔离，真正需要宿主环境的必须登记在 hostEnvScripts', unguarded.join(', '))
  ok(misplaced.length === 0, '登记为宿主环境的脚本不再导入隔离', misplaced.join(', '))
  ok(catalog.filter((test) => Object.hasOwn(hostEnvScripts, test.name)).every((test) => test.kind === 'excluded'), '宿主环境脚本都被排除在 test:unit 之外')
  ok((await readdir('scripts/lib')).includes('test-real-data-guard.mjs'), '保险模块存在')
})
