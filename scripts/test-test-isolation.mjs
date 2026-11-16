import './lib/test-isolate.mjs'
import { spawnSync } from 'node:child_process'
import { existsSync, symlinkSync, utimesSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { discoverTests, hostEnvScripts } from './lib/test-catalog.mjs'
import { SANDBOX_PREFIX, sweepStaleSandboxes } from './lib/test-env.mjs'
import { reportSkip } from './lib/test-skip.mjs'
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
const bs = String.fromCharCode(92)
await attempt('verbatimPrefix', () => writeFileSync(bs + bs + '?' + bs + target, '{}'))
await attempt('junctionAlias', () => writeFileSync(join(process.env.PROBE_ALIAS, 'agent', 'yan', 'subagents', 'sub-probe.json'), '{}'))
if (process.env.PROBE_SHORT) await attempt('shortName', () => writeFileSync(join(process.env.PROBE_SHORT, 'yan', 'subagents', 'sub-probe.json'), '{}'))
await attempt('userDataWrite', () => writeFileSync(join(process.env.APPDATA, 'yan-desktop', 'guard-seal.bin'), 'x'))
await attempt('userDataMkdir', () => mkdirSync(join(process.env.APPDATA, 'yan-desktop', 'nested'), { recursive: true }))
await attempt('otherAppData', () => { mkdirSync(join(process.env.APPDATA, 'other-app'), { recursive: true }) })
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
    const alias = join(work, 'alias')
    symlinkSync(join(fakeHome, '.pi'), alias, 'junction')
    let shortReal = ''
    if (process.platform === 'win32') {
      const short = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${fakeReal}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 10_000 })
      const candidate = (short.stdout ?? '').trim()
      if (candidate && candidate.toLowerCase() !== fakeReal.toLowerCase()) shortReal = candidate
    }
    const appData = join(work, 'appdata')
    await mkdir(appData, { recursive: true })
    const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, APPDATA: appData, PROBE_ALIAS: alias, PROBE_SHORT: shortReal, YAN_DATA_DIR: join(fakeReal, 'yan'), YAN_PI_DIR: fakeReal, PI_CODING_AGENT_DIR: fakeReal, OPENAI_API_KEY: 'sk-host' }
    delete env.YAN_USER_DATA
    const run = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 30_000 })
    ok(run.status === 0, '探针进程正常退出', run.stderr)
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).pop())
    const blocked = ['writeFileSync', 'mkdirSync', 'openSyncWrite', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir', 'openAppend', 'renameInto', 'rm', 'fsCallback']
    for (const name of blocked) ok(result.outcome[name] === 'blocked', `写入真实数据目录被拦：${name}`, result.outcome[name])
    if (process.platform === 'win32') {
      for (const name of ['verbatimPrefix', 'junctionAlias', 'userDataWrite', 'userDataMkdir']) ok(result.outcome[name] === 'blocked', `换写法也拦得住：${name}`, result.outcome[name])
      ok(result.outcome.otherAppData === 'allowed', '%APPDATA% 下其他目录不受限')
      if (shortReal) ok(result.outcome.shortName === 'blocked', '8.3 短路径写法也被拦', result.outcome.shortName)
      else reportSkip('本机卷没有启用 8.3 短名，未验证短路径写法')
    }
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
    } else {
      const lines = text.split(/\r?\n/)
      const at = lines.findIndex((line) => /^import[\s{*'"]/.test(line))
      const specifier = /^import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/m.exec(lines.slice(Math.max(at, 0)).join('\n'))?.[1]
      if (at < 0 || !['./lib/test-isolate.mjs', './lib/test-suite.mjs'].includes(specifier)) unguarded.push(`${name}（第一条 import 必须是 test-isolate 或 test-suite）`)
      else if (!usesSuite) {
        const first = lines.find((line, index) => !(index === 0 && line.startsWith('#!')) && line.trim())
        if (first !== "import './lib/test-isolate.mjs'") unguarded.push(`${name}（隔离导入必须是第一条语句）`)
      }
    }
  }
  ok(unguarded.length === 0, '每个测试脚本都默认隔离，真正需要宿主环境的必须登记在 hostEnvScripts', unguarded.join(', '))
  ok(misplaced.length === 0, '登记为宿主环境的脚本不再导入隔离', misplaced.join(', '))
  ok(catalog.filter((test) => Object.hasOwn(hostEnvScripts, test.name)).every((test) => test.kind === 'excluded'), '宿主环境脚本都被排除在 test:unit 之外')
  ok((await readdir('scripts/lib')).includes('test-real-data-guard.mjs'), '保险模块存在')
  const suiteLib = await readFile('scripts/lib/test-suite.mjs', 'utf8')
  ok(/^import '\.\/test-isolate\.mjs'\r?\n/.test(suiteLib), 'test-suite.mjs 自己把隔离导入放在第一条，经它隔离的脚本才不会被前面的导入绕过')

  const sweepRoot = await mkdtemp(join(tmpdir(), 'inkstone-sweep-probe-'))
  try {
    const day = 24 * 60 * 60 * 1000
    const now = Date.now()
    const age = (name, days) => utimesSync(join(sweepRoot, name), new Date(now - days * day), new Date(now - days * day))
    for (const name of [`${SANDBOX_PREFIX}old`, `${SANDBOX_PREFIX}fresh`, `${SANDBOX_PREFIX}old-busy`, 'other-old', `x${SANDBOX_PREFIX}old`]) {
      await mkdir(join(sweepRoot, name, 'data'), { recursive: true })
      await writeFile(join(sweepRoot, name, 'data', 'f.json'), '{}')
    }
    await writeFile(join(sweepRoot, `${SANDBOX_PREFIX}file`), 'x')
    age(`${SANDBOX_PREFIX}old`, 2)
    age(`${SANDBOX_PREFIX}old-busy`, 1.5)
    age(`${SANDBOX_PREFIX}fresh`, 0.5)
    age('other-old', 30)
    age(`x${SANDBOX_PREFIX}old`, 30)
    age(`${SANDBOX_PREFIX}file`, 30)
    const removed = sweepStaleSandboxes({ dir: sweepRoot, now }).map((path) => path.slice(sweepRoot.length + 1)).sort()
    ok(removed.join(',') === `${SANDBOX_PREFIX}old,${SANDBOX_PREFIX}old-busy`, '清扫只删除前缀匹配且超过 1 天的目录', removed.join(','))
    const left = (await readdir(sweepRoot)).sort()
    ok(left.join(',') === [`${SANDBOX_PREFIX}file`, `${SANDBOX_PREFIX}fresh`, 'other-old', `x${SANDBOX_PREFIX}old`].sort().join(','), '不到 1 天的、其他前缀的和同前缀的普通文件都保留', left.join(','))
    ok(sweepStaleSandboxes({ dir: join(sweepRoot, 'missing'), now }).length === 0, '目录不存在时清扫不报错')
  } finally {
    await rm(sweepRoot, { recursive: true, force: true, maxRetries: 3 })
  }
})
