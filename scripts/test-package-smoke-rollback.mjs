import './lib/test-isolate.mjs'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const FAKE_PI = `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [cmd, ...rest] = process.argv.slice(2)
appendFileSync(process.env.FAKE_PI_LOG, JSON.stringify([cmd, ...rest]) + '\\n')
if (process.env.FAKE_PI_FAIL === '1') { console.error('npm ERR! network'); process.exit(1) }
const agent = process.env.PI_CODING_AGENT_DIR
const source = rest.filter((arg) => arg !== '-l').at(-1)
const name = source.replace(/^npm:/, '').replace(/@[^@/]+$/, '')
const dir = join(agent, 'npm', 'node_modules', name)
const settings = join(agent, 'settings.json')
const read = () => (existsSync(settings) ? JSON.parse(readFileSync(settings, 'utf8')) : {})
const write = (value) => writeFileSync(settings, JSON.stringify(value))
if (cmd === 'install' || cmd === 'update') {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: process.env.FAKE_PI_VERSION ?? '1.0.0' }))
  writeFileSync(join(dir, 'marker.txt'), process.env.FAKE_PI_BAD === '1' ? 'BAD' : 'GOOD')
  if (cmd === 'install') {
    const current = read()
    const nameOf = (entry) => entry.replace(/^npm:/, '').replace(/@[^@/]+$/, '')
    current.packages = [...(current.packages ?? []).filter((entry) => nameOf(entry) !== name), source]
    write(current)
  }
}
if (cmd === 'remove') {
  rmSync(dir, { recursive: true, force: true })
  const current = read()
  const nameOf = (entry) => entry.replace(/^npm:/, '').replace(/@[^@/]+$/, '')
  current.packages = (current.packages ?? []).filter((entry) => nameOf(entry) !== name)
  write(current)
}
`

await runSuite(import.meta.url, async (ok, compile) => {
  const packages = await compile('src/main/packages.ts', { packages: 'external' })
  const smoke = await compile('src/main/capabilities/pi-package-smoke.ts', { external: ['tar'] })
  const root = await mkdtemp(join(tmpdir(), 'yan-package-smoke-rollback-'))
  const saved = { ...process.env }
  try {
    process.env.YAN_DATA_DIR = join(root, 'data')
    const agentDir = join(root, 'pi')
    const project = join(root, 'project')
    const log = join(root, 'calls.jsonl')
    const fakePi = join(root, 'fake-pi.mjs')
    await mkdir(project, { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await writeFile(fakePi, FAKE_PI)
    process.env.FAKE_PI_LOG = log
    const calls = async () => (existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
    const smokeDirs = []
    let smokeMode = 'marker'
    const lockHolders = []
    let busyAny = false
    let busyCwd = false
    packages.configurePackageContext({
      bin: () => fakePi,
      agentDir: () => agentDir,
      hasRunningTask: () => busyCwd,
      hasAnyRunningTask: () => busyAny,
      isProjectTrusted: async () => true,
      isKnownProject: (cwd) => cwd === project,
      smoke: async (dir) => {
        smokeDirs.push(dir)
        if (smokeMode === 'throw') throw new Error('smoke crashed')
        if (smokeMode === 'timeout') return { ok: false, kind: 'inconclusive', problems: ['命令 get_commands 超时（20000ms）'] }
        if (smokeMode === 'lock') {
          const { spawn } = await import('node:child_process')
          const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore', windowsHide: true })
          lockHolders.push(holder)
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        if (smokeMode === 'skip') return { ok: true, problems: [], skipped: true }
        const marker = await readFile(join(dir, 'marker.txt'), 'utf8')
        return marker === 'BAD' ? { ok: false, problems: ['Failed to load extension "ext.js": boom'] } : { ok: true, problems: [] }
      }
    })
    const settingsPackages = async () => JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8').catch(() => '{}')).packages ?? []
    const run = (kind, source, extra = {}) => packages.runPackageAction({ kind, source, cwd: project, ...extra })
    const pkgDir = (name) => join(agentDir, 'npm', 'node_modules', name)
    const versionOf = async (name) => JSON.parse(await readFile(join(pkgDir(name), 'package.json'), 'utf8')).version

    {
      const result = await run('install', 'npm:good-pkg')
      ok(result.ok && smokeDirs.at(-1) === pkgDir('good-pkg'), '安装成功后对已安装的包目录跑加载试跑', result.error)
      ok(/加载试跑通过/.test(result.output ?? ''), '试跑通过写进结果输出', result.output)
    }
    {
      process.env.FAKE_PI_BAD = '1'
      const result = await run('install', 'npm:bad-pkg')
      ok(!result.ok && /已自动卸载/.test(result.error ?? ''), '试跑失败的新装包自动卸载', result.error)
      ok(/Failed to load extension "ext.js": boom/.test(result.detail ?? ''), '试跑输出放进详情', result.detail)
      ok(!existsSync(pkgDir('bad-pkg')) && !(await settingsPackages()).includes('npm:bad-pkg'), '回滚后包目录与 settings 里的来源都没有了')
      ok((await calls()).some((call) => call[0] === 'remove' && call.includes('npm:bad-pkg')), '回滚通过 pi remove 完成')
      ok(!result.listing.entries.some((entry) => entry.name === 'bad-pkg'), '返回的清单不含被撤销的包')
      delete process.env.FAKE_PI_BAD
    }
    {
      process.env.FAKE_PI_VERSION = '2.0.0'
      process.env.FAKE_PI_BAD = '1'
      const before = (await calls()).length
      const result = await run('update', 'npm:good-pkg')
      ok(!result.ok && /已恢复旧版本/.test(result.error ?? ''), '更新后试跑失败时恢复旧版本', result.error)
      ok((await versionOf('good-pkg')) === '1.0.0' && (await readFile(join(pkgDir('good-pkg'), 'marker.txt'), 'utf8')) === 'GOOD', '包目录回到更新前的内容')
      ok(!(await calls()).slice(before).some((call) => call[0] === 'remove'), '更新失败不会卸载原来能用的包')
      ok((await settingsPackages()).includes('npm:good-pkg'), '原来的包仍在 settings 里')
      ok(/Failed to load extension/.test(result.detail ?? ''), '更新失败的详情带试跑输出')
      const leftovers = await readdir(join(root, 'data', 'tmp', 'package-ops')).then((names) => names.filter((name) => name.startsWith('rollback-')), () => [])
      ok(leftovers.length === 0, '回滚完成后备份目录被清掉', leftovers.join())
      delete process.env.FAKE_PI_BAD
    }
    {
      const result = await run('update', 'npm:good-pkg')
      ok(result.ok && (await versionOf('good-pkg')) === '2.0.0', '更新后试跑通过时保留新版本', result.error)
      const leftovers = await readdir(join(root, 'data', 'tmp', 'package-ops')).then((names) => names.filter((name) => name.startsWith('rollback-')), () => [])
      ok(leftovers.length === 0, '成功后备份目录也被清掉')
      delete process.env.FAKE_PI_VERSION
    }
    {
      process.env.FAKE_PI_BAD = '1'
      const result = await run('install', 'npm:good-pkg')
      ok(!result.ok && /已恢复旧版本/.test(result.error ?? '') && (await settingsPackages()).includes('npm:good-pkg') && (await versionOf('good-pkg')) === '2.0.0',
        '重复安装已有的包失败时恢复旧版本，不卸载', result.error)
      delete process.env.FAKE_PI_BAD
    }
    {
      smokeMode = 'throw'
      const result = await run('install', 'npm:crashy-pkg')
      ok(result.ok && /smoke crashed/.test(result.output ?? '') && /已保留/.test(result.output ?? '') && existsSync(pkgDir('crashy-pkg')), '试跑自己出错（不是包的加载错误）时不回滚，保留包并提示用户', result.output)
      smokeMode = 'timeout'
      const slow = await run('install', 'npm:slow-pkg')
      ok(slow.ok && /超时/.test(slow.output ?? '') && existsSync(pkgDir('slow-pkg')) && (await settingsPackages()).includes('npm:slow-pkg'), '试跑超时不算加载失败：保留包并提示', slow.output)
      smokeMode = 'skip'
      const skipped = await run('install', 'npm:themes-only')
      ok(skipped.ok && /未做加载试跑/.test(skipped.output ?? '') && existsSync(pkgDir('themes-only')), '没有可加载内容时跳过试跑并如实说明', skipped.output)
      smokeMode = 'marker'
    }
    {
      process.env.FAKE_PI_VERSION = '3.0.0'
      process.env.FAKE_PI_BAD = '1'
      const before = (await calls()).length
      const result = await run('install', 'npm:good-pkg@3.0.0')
      ok(!result.ok && /已恢复旧版本/.test(result.error ?? ''), '已装同名包、换个版本号再装失败：按包名认出原来的包并恢复', result.error)
      ok(!(await calls()).slice(before).some((call) => call[0] === 'remove'), '同名包不执行 pi remove（pi 按包名匹配，会把原来的包一起删）')
      ok((await versionOf('good-pkg')) === '2.0.0', '目录回到操作前的版本')
      ok(/来源现在是 npm:good-pkg@3.0.0/.test(result.detail ?? ''), '来源写法被 pi 改了时在详情里说明', result.detail)
      const leftovers = (await readdir(join(agentDir, 'npm', 'node_modules'))).filter((name) => name.includes('.yan-old-'))
      ok(leftovers.length === 0, '恢复完成后移开的旧目录被清掉', leftovers.join())
      delete process.env.FAKE_PI_VERSION
      delete process.env.FAKE_PI_BAD
    }
    if (process.platform === 'win32') {
      process.env.FAKE_PI_VERSION = '4.0.0'
      process.env.FAKE_PI_BAD = '1'
      smokeMode = 'lock'
      const result = await run('update', 'npm:good-pkg')
      for (const holder of lockHolders) holder.kill()
      smokeMode = 'marker'
      ok(!result.ok && /自动回滚未完成/.test(result.error ?? ''), '目录被占用、恢复失败时如实报告', result.error)
      const keptBackup = /备份保留在 (.+?)，可手动复制/.exec(result.detail ?? '')?.[1]
      ok(!!keptBackup && existsSync(join(keptBackup, 'package.json')) && JSON.parse(await readFile(join(keptBackup, 'package.json'), 'utf8')).version === '2.0.0', '恢复失败时旧版本备份保留，路径写在结果里', result.detail)
      await new Promise((resolve) => setTimeout(resolve, 500))
      ok((await versionOf('good-pkg')) === '4.0.0', '恢复失败时目录原样保留，不是半成品')
      delete process.env.FAKE_PI_VERSION
      delete process.env.FAKE_PI_BAD
    }
    {
      process.env.FAKE_PI_FAIL = '1'
      const result = await run('install', 'npm:network-fails')
      ok(!result.ok && /安装失败/.test(result.error ?? '') && /network/.test(result.detail ?? ''), 'pi 自己安装失败时照旧报错')
      ok(!(await calls()).some((call) => call[0] === 'remove' && call.includes('npm:network-fails')), 'pi 安装失败不触发回滚')
      delete process.env.FAKE_PI_FAIL
    }
    {
      const before = (await calls()).length
      const dirsBefore = smokeDirs.length
      const removed = await run('remove', 'npm:good-pkg')
      ok(removed.ok && smokeDirs.length === dirsBefore, '卸载不跑试跑')
      ok((await calls()).length === before + 1, '卸载只调用一次 pi')
    }
    {
      busyAny = true
      const before = (await calls()).length
      const result = await run('install', 'npm:blocked-pkg')
      ok(!result.ok && /有会话正在运行/.test(result.error ?? '') && (await calls()).length === before, '用户级安装在任一会话忙时拒绝，且不调用 pi', result.error)
      const update = await run('update', 'npm:good-pkg')
      ok(!update.ok && /有会话正在运行/.test(update.error ?? ''), '用户级更新同样检查全部会话')
      const removal = await run('remove', 'npm:good-pkg')
      ok(!removal.ok && /有会话正在运行/.test(removal.error ?? ''), '用户级卸载同样检查全部会话')
      const local = await run('install', 'npm:local-pkg', { local: true })
      ok(local.ok, '项目级安装只看本项目目录是否忙', local.error)
      busyCwd = true
      const localBusy = await run('install', 'npm:local-pkg-2', { local: true })
      ok(!localBusy.ok && /这个目录有任务正在运行/.test(localBusy.error ?? ''), '本项目目录忙时项目级安装被拒绝')
      busyAny = false
      busyCwd = false
    }
    {
      packages.configurePackageContext({ bin: () => fakePi, agentDir: () => agentDir, hasRunningTask: () => true, isProjectTrusted: async () => true, isKnownProject: () => true })
      const blocked = await run('install', 'npm:cwd-only')
      ok(!blocked.ok && /这个目录有任务正在运行/.test(blocked.error ?? ''), '没有全局忙检查时回退为按目录检查')
      packages.configurePackageContext({ bin: () => fakePi, agentDir: () => agentDir, hasRunningTask: () => false, isProjectTrusted: async () => true, isKnownProject: () => true })
      const before = (await calls()).length
      const result = await run('install', 'npm:no-smoke')
      ok(result.ok && (await calls()).length === before + 1 && !/加载试跑/.test(result.output ?? ''), '没有配置试跑能力时保持原先的安装行为')
    }

    if (existsSync(join('resources', 'pi-runtime', 'current.json'))) {
      const fixtures = join(root, 'fixtures')
      const make = async (name, source) => {
        await mkdir(join(fixtures, name, 'extensions'), { recursive: true })
        await writeFile(join(fixtures, name, 'package.json'), JSON.stringify({ name, version: '1.0.0', pi: { extensions: ['./extensions'] }, dependencies: { 'left-pad': '^1.0.0' } }))
        await writeFile(join(fixtures, name, 'extensions', 'a.js'), source)
        return join(fixtures, name)
      }
      const good = await make('real-good', 'export default function (pi) {}\n')
      const missing = await make('real-missing', "import './not-there.js'\nexport default function (pi) {}\n")
      const boom = await make('real-boom', "export default function (pi) { pi.on('session_start', () => { throw new Error('boom-at-start') }) }\n")
      const themesOnly = join(fixtures, 'real-themes')
      await mkdir(themesOnly, { recursive: true })
      await writeFile(join(themesOnly, 'package.json'), JSON.stringify({ name: 'real-themes', version: '1.0.0', pi: { themes: ['./themes'] } }))
      const passed = await smoke.smokeInstalledPiPackage({ packageRoot: good })
      ok(passed.ok, '真实 pi：正常包（依赖由安装器放在包外也不被拒）通过试跑', passed.problems.join())
      const failedLoad = await smoke.smokeInstalledPiPackage({ packageRoot: missing })
      ok(!failedLoad.ok && /Failed to load extension/.test(failedLoad.problems[0]) && /not-there/.test(failedLoad.problems[0]), '真实 pi：扩展加载失败时详情带 pi 的 stderr', failedLoad.problems.join())
      const failedRuntime = await smoke.smokeInstalledPiPackage({ packageRoot: boom })
      ok(!failedRuntime.ok && /boom-at-start/.test(failedRuntime.problems[0]), '真实 pi：识别 extension_error 并带上原因', failedRuntime.problems.join())
      ok(failedLoad.kind === 'load-error' && failedRuntime.kind === 'load-error', '真实 pi：加载失败与 extension_error 都归为 load-error（才会自动回滚）')
      const tooSlow = await smoke.smokeInstalledPiPackage({ packageRoot: good, timeoutMs: 1 })
      ok(!tooSlow.ok && tooSlow.kind === 'inconclusive', '真实 pi：超时归为 inconclusive，不当作坏包', tooSlow.problems.join())
      const broken = await smoke.smokeInstalledPiPackage({ packageRoot: join(fixtures, 'does-not-exist') })
      ok(!broken.ok && broken.kind === 'inconclusive', '读不到包清单时归为 inconclusive')
      const skipped = await smoke.smokeInstalledPiPackage({ packageRoot: themesOnly })
      ok(skipped.ok && skipped.skipped === true, '只有主题的包不跑试跑，标记为跳过')
    }
  } finally {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    Object.assign(process.env, saved)
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})
