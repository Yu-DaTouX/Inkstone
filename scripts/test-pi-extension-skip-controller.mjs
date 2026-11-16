import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

const root = await mkdtemp(join(tmpdir(), 'inkstone-ext-skip-'))
const piDir = join(root, 'pi')
const extDir = join(piDir, 'extensions')
await mkdir(extDir, { recursive: true })
process.env.YAN_PI_DIR = piDir
process.env.YAN_DATA_DIR = join(root, 'yan')
process.env.YAN_SESSIONS_DIR = join(root, 'sessions')

const models = JSON.stringify({ providers: { fixture: { baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: 'fixture-only', models: [{ id: 'native', name: 'Native fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } })
await writeFile(join(piDir, 'models.json'), models)
await writeFile(join(piDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'native' }))

const outDir = await mkdtemp(resolve('node_modules/.inkstone-test-build-'))
const electronStub = { name: 'electron-stub', setup(b) {
  b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
    loader: 'js',
    contents: [
      'export const shell = { openPath: async () => "" }',
      'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
      'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
      'export const ipcMain = { handle: () => undefined }',
      'export class BrowserWindow { constructor() { throw new Error("outside fixture") } }',
      'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
      'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
      'export const session = { defaultSession: {}, fromPartition() { throw new Error("outside fixture") } }'
    ].join('\n')
  }))
} }
await build({ entryPoints: ['src/main/agent.ts'], outfile: join(outDir, 'agent.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
await build({ entryPoints: ['src/main/subagents.ts'], outfile: join(outDir, 'subagents.mjs'), bundle: true, packages: 'external', format: 'esm', platform: 'node', logLevel: 'silent', plugins: [electronStub] })
await build({ entryPoints: ['src/main/pi-extension-skip.ts'], outfile: join(outDir, 'skip.mjs'), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent', plugins: [electronStub] })
const { AgentController } = await import(pathToFileURL(join(outDir, 'agent.mjs')).href)
const { SubagentController } = await import(pathToFileURL(join(outDir, 'subagents.mjs')).href)
const skipMain = await import(pathToFileURL(join(outDir, 'skip.mjs')).href)
const cli = join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist', 'bundle', 'cli.js')

let checks = 0
const ok = (condition, label, detail = '') => {
  assert.ok(condition, detail ? `${label}: ${detail}` : label)
  checks += 1
  console.log(`  ✓ ${label}`)
}

const tool = (name) => `export default function (pi) { pi.registerTool({ name: '${name}', label: '${name}', description: 'fixture', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }) }\n`
const command = (name) => `export default function (pi) { pi.registerCommand('${name}', { description: 'fixture', handler: async () => {} }) }\n`
const broken = "throw new Error('fixture-broken-extension')\n"

async function withController(options, body) {
  const cwd = await mkdtemp(join(root, 'cwd-'))
  const pushes = []
  const controller = new AgentController({ cwd, piBin: cli, push: (event) => pushes.push(structuredClone(event)), ...options })
  controller.maybeGenerateTitle = async () => null
  const starts = () => pushes.filter((event) => event.ch === 'proc' && event.payload.state === 'starting').length
  const conns = () => pushes.filter((event) => event.ch === 'proc' && event.payload.state !== 'stderr').map((event) => event.payload.state)
  try {
    await body({ controller, starts, conns, cwd })
  } finally {
    await controller.stop()
  }
}

const extensionArgs = (args) => args.filter((_, i) => i > 0 && args[i - 1] === '--extension')

try {
  console.log('\n--- 用户扩展坏：只跳过它 ---')
  await writeFile(join(extDir, 'broken-user.js'), broken)
  await writeFile(join(extDir, 'good-user.js'), command('good-fixture'))
  const namedDir = join(root, 'my-tools', 'pi-extensions')
  await mkdir(namedDir, { recursive: true })
  await writeFile(join(namedDir, 'named-user.js'), command('named-fixture'))
  const userSettings = JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'native', extensions: [join(namedDir, 'named-user.js')] })
  await writeFile(join(piDir, 'settings.json'), userSettings)
  await withController({}, async ({ controller, starts, conns }) => {
    const started = await controller.start()
    ok(started.ok === true, '跳过坏扩展后会话照常启动', started.error ?? '')
    ok(starts() === 2 && !conns().includes('error') && !conns().includes('exited'), '只重试一次，过程中不闪出错误或退出状态', JSON.stringify(conns()))
    const skip = controller.extensionSkip()
    ok(skip?.mode === 'some' && skip.extensions.length === 1 && skip.extensions[0].name === 'broken-user.js' && skip.extensions[0].reason.includes('fixture-broken-extension'), '记下跳过的是哪个扩展与原因', JSON.stringify(skip))
    const args = controller.rpc.launchOptions.args
    ok(args.includes('--no-extensions') && !extensionArgs(args).some((path) => path.endsWith('broken-user.js')), '重启时不再加载坏扩展')
    ok(extensionArgs(args).some((path) => path.endsWith('good-user.js')) && extensionArgs(args).includes('builtin:mcp'), '其他用户扩展与内置扩展照常加载', JSON.stringify(extensionArgs(args)))
    const commands = await controller.rpc.command('get_commands')
    ok(JSON.stringify(commands.data ?? '').includes('good-fixture'), '好的用户扩展确实加载了')
    ok(JSON.stringify(commands.data ?? '').includes('named-fixture'), '放在 pi-extensions 同名目录里的用户扩展也照常加载')
    ok(skip.builtinsSkipped !== true, '内置扩展照常加载')
    ok(controller.extensionSkipSource()?.skip === skip, '子代理可沿用本会话的跳过决定')

    await rm(join(extDir, 'broken-user.js'))
    await controller.stop()
    const restarted = await controller.start()
    ok(restarted.ok === true && controller.extensionSkip() === null, '修好后重启会话自动恢复，不再跳过')
    ok(!controller.rpc.launchOptions.args.includes('--no-extensions'), '恢复后回到 pi 原生发现')
  })
  ok(await readFile(join(piDir, 'settings.json'), 'utf8') === userSettings, '没有写入用户 pi 设置')

  console.log('\n--- 工具重名：跳过后加载的那个 ---')
  await writeFile(join(extDir, 'dup-a.js'), tool('dup_fixture'))
  await writeFile(join(extDir, 'dup-b.js'), tool('dup_fixture'))
  await withController({}, async ({ controller, starts }) => {
    const started = await controller.start()
    ok(started.ok === true && starts() === 2, '重名时跳过一方后照常启动', started.error ?? '')
    const skip = controller.extensionSkip()
    ok(skip?.mode === 'some' && skip.extensions.length === 1 && skip.extensions[0].conflict === true, '提示标明是重名', JSON.stringify(skip))
    const kept = extensionArgs(controller.rpc.launchOptions.args).filter((path) => /dup-[ab]\.js$/.test(path))
    ok(kept.length === 1 && !kept[0].endsWith(skip.extensions[0].name), '重名的另一方继续加载', JSON.stringify(kept))
  })
  await rm(join(extDir, 'dup-a.js'))
  await rm(join(extDir, 'dup-b.js'))

  console.log('\n--- 砚扩展坏：不跳过，照原样报错 ---')
  const hostDir = join(root, 'resources', 'pi-extensions')
  await mkdir(hostDir, { recursive: true })
  await writeFile(join(hostDir, 'broken-host.js'), broken)
  await withController({ dangerGuardExtension: join(hostDir, 'broken-host.js') }, async ({ controller, starts }) => {
    const started = await controller.start()
    ok(started.ok === false && starts() === 1, '砚扩展坏时不重试', started.error ?? '')
    ok(started.error.includes('broken-host.js') && !started.error.includes('跳过'), '报错指名砚扩展，不提跳过', started.error)
    ok(controller.extensionSkip() === null, '没有跳过记录')
  })

  console.log('\n--- 跳过后仍失败：不再重试 ---')
  await writeFile(join(extDir, 'broken-user.js'), broken)
  await writeFile(join(hostDir, 'second-run.js'), "if (process.argv.includes('--no-extensions')) throw new Error('fixture-second-run')\nexport default function () {}\n")
  await withController({ dangerGuardExtension: join(hostDir, 'second-run.js') }, async ({ controller, starts }) => {
    const started = await controller.start()
    ok(started.ok === false && starts() === 2, '跳过后仍失败只重试一次', `${starts()} ${started.error}`)
    ok(started.error.includes('broken-user.js') && started.error.includes('后仍失败，真正原因'), '报错说明跳过后仍失败及真正原因', started.error)
    ok(started.error.includes('second-run.js'), '报错带出第二次失败的真实原因', started.error)
    ok(controller.extensionSkip() === null, '失败时不保留跳过提示')
  })
  await rm(join(extDir, 'broken-user.js'))

  console.log('\n--- 探针不写配置 ---')
  const { readdir, stat } = await import('node:fs/promises')
  const { createHash } = await import('node:crypto')
  const probeRoot = await mkdtemp(join(tmpdir(), 'inkstone-probe-'))
  const probeAgent = join(probeRoot, 'agent')
  const probeProject = join(probeRoot, 'project')
  await mkdir(join(probeAgent, 'extensions'), { recursive: true })
  await mkdir(join(probeProject, '.pi', 'extensions'), { recursive: true })
  await writeFile(join(probeAgent, 'extensions', 'a.js'), command('probe-a'))
  await writeFile(join(probeAgent, 'settings.json'), JSON.stringify({ extensions: ['-builtin:llama.cpp'], packages: ['npm:not-installed-fixture', { source: join(probeRoot, 'pkg'), extensions: [] }], defaultProjectTrust: 'never' }))
  await writeFile(join(probeAgent, 'trust.json'), JSON.stringify({ [probeProject]: true }))
  await writeFile(join(probeProject, '.pi', 'settings.json'), JSON.stringify({ extensions: ['+extensions/p.js'], packages: ['npm:also-missing'] }))
  await writeFile(join(probeProject, '.pi', 'extensions', 'p.js'), command('probe-p'))
  const snapshot = async () => {
    const out = {}
    const walk = async (dir) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { out[path] = 'dir'; await walk(path) } else {
          const info = await stat(path)
          out[path] = `${info.mtimeMs}:${createHash('sha256').update(await readFile(path)).digest('hex')}`
        }
      }
    }
    await walk(probeRoot)
    return out
  }
  const before = await snapshot()
  await new Promise((r) => setTimeout(r, 50))
  const probed = await skipMain.resolvePiExtensions({ cwd: probeProject, piBin: cli, agentDir: probeAgent })
  const after = await snapshot()
  ok(Array.isArray(probed) && probed.some((item) => item.path.endsWith('a.js') && item.enabled) && probed.some((item) => item.path === 'builtin:llama.cpp' && !item.enabled), '探针按用户设置解析出扩展清单', JSON.stringify(probed))
  ok(JSON.stringify(after) === JSON.stringify(before), '探针前后 agentDir 与项目 .pi 的文件、mtime、内容都不变，也没有新文件', JSON.stringify({ before, after }))
  await rm(probeRoot, { recursive: true, force: true })

  console.log('\n--- 子代理沿用会话的跳过决定 ---')
  const parentCwd = join(root, 'parent')
  const worktree = join(root, 'worktree')
  await mkdir(join(parentCwd, '.pi', 'extensions'), { recursive: true })
  const skipped = { mode: 'some', extensions: [{ path: join(parentCwd, '.pi', 'extensions', 'bad.js'), name: 'bad.js', reason: 'boom', conflict: false }], othersSkipped: 0 }
  const resolvedFor = (cwd) => async () => [
    { path: join(cwd, '.pi', 'extensions', 'bad.js'), enabled: true },
    { path: join(cwd, '.pi', 'extensions', 'fine.js'), enabled: true },
    { path: 'builtin:mcp', enabled: true }
  ]
  const relocated = skipMain.reapplyPiExtensionSkip({ args: ['--extension', 'C:/app/resources/pi-extensions/preamble.js'], skip: skipped, resolved: await resolvedFor(worktree)(), sourceCwd: parentCwd, targetCwd: worktree })
  ok(!relocated.some((arg) => arg.endsWith('bad.js')) && relocated.some((arg) => arg === join(worktree, '.pi', 'extensions', 'fine.js')), 'worktree 子代理按相对位置跳过同一个项目扩展', JSON.stringify(relocated))
  const captured = []
  const ctrl = new SubagentController({
    cwd: parentCwd, archiveDir: join(root, 'archive'), piBin: cli,
    extensions: ['C:/app/resources/pi-extensions/preamble.js'],
    prepare: async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd }),
    resolveExtensions: resolvedFor(parentCwd),
    createRpc: ({ args }) => {
      captured.push(args)
      return { running: false, on() { return this }, spawn() {}, async command() { return { success: false } }, async close() {} }
    },
    onChange: () => {}
  })
  await ctrl.start('子代理任务', 'fixture/native', 'shared-cwd', undefined, undefined, { cwd: parentCwd, extensionSkip: { skip: skipped, cwd: parentCwd } })
  await ctrl.start('子代理任务', 'fixture/native', 'shared-cwd', undefined, undefined, { cwd: parentCwd })
  await ctrl.stopAll().catch(() => undefined)
  ok(captured.length === 2, '两次启动都走到创建进程', String(captured.length))
  ok(captured[0].includes('--no-extensions') && !captured[0].some((arg) => arg.endsWith('bad.js')) && captured[0].some((arg) => arg.endsWith('fine.js')), '父会话跳过了扩展时，子代理同样跳过', JSON.stringify(captured[0]))
  ok(!captured[1].includes('--no-extensions'), '父会话没跳过时子代理照常走 pi 原生发现')

  console.log(`\n${checks}/${checks} 通过`)
} finally {
  await rm(outDir, { recursive: true, force: true })
}
