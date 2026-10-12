import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const scratch = await mkdtemp(join(tmpdir(), 'inkstone-review-host-'))
const keys = ['YAN_DATA_DIR', 'YAN_PI_DIR', 'YAN_SESSIONS_DIR']
const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
for (const key of keys) process.env[key] = join(scratch, key)
let checks = 0
const ok = (condition, label) => { assert.ok(condition, label); checks++ }
try {
  const compile = async (entry, name, options = {}) => {
    const outfile = join(scratch, `${name}.mjs`)
    await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', ...options })
    return import(pathToFileURL(outfile).href)
  }
  const { isAuthorizedFileCwd } = await compile('src/main/file-context.ts', 'file-context')
  const project = join(scratch, 'project'), other = join(scratch, 'other'), nested = join(project, 'nested')
  await mkdir(nested, { recursive: true }); await mkdir(other)
  ok(await isAuthorizedFileCwd(project, [project]), '项目自身可作为预览根')
  ok(!await isAuthorizedFileCwd(other, [project]), '存在的未授权目录不能作为预览根')
  ok(!await isAuthorizedFileCwd(nested, [project]), '项目子目录不能扩大为新的授权根')
  ok(!await isAuthorizedFileCwd(dirname(project), [project]), '项目父目录不继承授权')
  ok(!await isAuthorizedFileCwd('.', [project]), '相对 cwd 不作为授权根')

  const handlers = new Map()
  const rpc = { running: false, closed: false, on(event, listener) { handlers.set(event, [...(handlers.get(event) ?? []), listener]); return rpc },
    spawn() { rpc.running = true }, async command() { return { success: true, data: {} } },
    async close() { rpc.closed = true; rpc.running = false }, emit(event, value) { for (const listener of handlers.get(event) ?? []) listener(value) } }
  const { SubagentController } = await compile('src/main/subagents.ts', 'subagents')
  const ctrl = new SubagentController({ cwd: project, archiveDir: join(scratch, 'archive'), prepare: async (rootCwd, id, isolation) => ({ rootCwd, cwd: rootCwd, isolation }), createRpc: () => rpc, onChange: () => {} })
  try {
    const started = await ctrl.start('review-host fixture', undefined, 'controlled-cwd')
    assert.ok(started.ok)
    rpc.emit('event', { type: 'agent_settled' })
    await ctrl.stopAll()
    ok(rpc.closed, 'settled 安静期内退出也等待 RPC 关闭')
    const run = ctrl.runs.get(started.run.id)
    const originalWorkspace = run.workspace
    const marker = join(project, 'keep.txt'); await writeFile(marker, 'unreviewed')
    run.workspace = { ...originalWorkspace, isolation: 'worktree', worktreePath: project }
    run.isolation = 'worktree'; run.review = 'pending'; run.diff = { files: 1, additions: 1, deletions: 0 }; run.worktreeDone = false
    const missing = await ctrl.merge(run.id)
    ok(!missing.ok && existsSync(marker), '缺补丁的待审阅任务拒绝合并并保留工作区')
    run.review = 'discarded'; run.diff.patchPath = join(scratch, 'absent.patch')
    ok(!(await ctrl.merge(run.id)).ok && existsSync(marker), '非待合并状态不能以 merge 删除工作区')
    run.workspace = originalWorkspace; run.worktreeDone = true
  } finally { await ctrl.stopAll() }

  let spawnCalls = 0
  globalThis.__reviewPty = { spawn() { if (++spawnCalls === 1) throw new Error('temporary shell failure'); return { onData() {}, onExit() {}, kill() {} } } }
  const terminalFile = join(scratch, 'terminal.cjs')
  await build({ entryPoints: ['src/main/terminal.ts'], outfile: terminalFile, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [{ name: 'fake-pty-loader', setup(builder) {
    builder.onResolve({ filter: /^node:module$/ }, () => ({ path: 'fake-pty-loader', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const createRequire = () => () => globalThis.__reviewPty', loader: 'js' }))
  } }] })
  const terminal = createRequire(import.meta.url)(terminalFile)
  ok(terminal.terminalAvailable(), '假 PTY 模块可用')
  ok(terminal.startTerminal({ cwd: project }) === null, '首次壳启动失败如实返回失败')
  ok(terminal.terminalAvailable(), '临时壳启动失败不会永久禁用 PTY 模块')
  ok(terminal.startTerminal({ cwd: project })?.alive && !terminal.terminalLoadError(), '再次启动成功并清除临时诊断')
  terminal.disposeTerminals(); delete globalThis.__reviewPty

  const packages = await compile('src/main/packages.ts', 'packages', { plugins: [{ name: 'electron-package-fixture', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "en-US" }', loader: 'js' }))
  } }] })
  for (const source of ['npm:--ignore-scripts', 'git:--upload-pack=bad', 'ssh:-oProxyCommand=bad']) ok(!!packages.validatePackageSource(source), '包来源拒绝协议内部的选项注入')
  for (const source of ['npm:fixture@^1.2.3', 'npm:@scope/fixture@~2.0.0', './fixture']) ok(packages.validatePackageSource(source) === null, '合法包来源和版本范围不被误拒绝')
  packages.configurePackageContext({ isProjectTrusted: () => false, bin: () => 'must-not-execute', agentDir: () => join(scratch, 'pi') })
  ok(!(await packages.runPackageAction({ kind: 'install', source: 'npm:fixture', local: true })).ok, '项目安装缺 cwd 拒绝且不启动外部安装器')
  ok(!(await packages.runPackageAction({ kind: 'install', source: 'npm:fixture', cwd: project, local: true })).ok, '未信任项目安装拒绝且不启动外部安装器')

  const image = await readFile('src/main/image-generation.ts', 'utf8')
  ok(!image.includes('|| openAiKey') && image.includes("process.env.YAN_IMAGE_API_KEY?.trim() : await credentials.secret('openai')"), '静态边界：自定义生图端点不回退到 OpenAI 凭证')
  const protocol = await readFile('src/main/protocol.ts', 'utf8')
  ok(protocol.includes('delete env.YAN_REMOTE_TOKEN'), '静态边界：pi 不继承远程接入令牌')
  console.log(`宿主审查定向回归通过：${checks} 项（临时目录、假 RPC/PTY；生图/环境为静态断言）`)
} finally {
  delete globalThis.__reviewPty
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key] }
  await rm(scratch, { recursive: true, force: true })
}
