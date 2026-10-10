/** 非 Git 委派、模型传递、两档权限与子运行审批的回归；不连接模型服务。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-light-'))
const oldData = process.env.YAN_DATA_DIR
const oldEnv = Object.fromEntries(['YAN_CLI_URL', 'YAN_CLI_TOKEN', 'YAN_SESSION_ID', 'YAN_PROJECT_ID'].map(key => [key, process.env[key]]))
let checks = 0
const check = (value, message) => { assert(value, message); checks++ }
try {
  process.env.YAN_DATA_DIR = join(root, 'data')
  await mkdir(process.env.YAN_DATA_DIR)
  const load = async (name, file) => {
    const out = join(root, `${name}.mjs`)
    await build({ entryPoints: [resolve(file)], outfile: out, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    return import(pathToFileURL(out).href)
  }
  const isolation = await load('isolation', 'src/main/subagent-isolation.ts')
  const workspace = await isolation.prepareWorkspace(root, 'nongit', 'shared-cwd')
  check(workspace.cwd === root && !workspace.worktreePath, '非 Git 当前目录可执行，不创建 worktree')
  await writeFile(join(workspace.cwd, 'result.txt'), 'child result')
  await isolation.cleanupWorkspace(workspace)
  const { readFile } = await import('node:fs/promises')
  check(await readFile(join(root, 'result.txt'), 'utf8') === 'child result', '当前目录任务清理不会删除用户成果')
  const parser = await load('command', 'src/shared/subagent-command.ts')
  const parsed = parser.parseSubagentCommand('/subagent --model provider/model 审查 --read-only')
  check(parsed.model === 'provider/model' && parsed.task === '审查' && parsed.isolation === 'controlled-cwd', '模型和只读参数同时保留')
  check(parser.parseSubagentCommand('/subagent 修改文件').isolation === 'shared-cwd', '通用任务默认当前目录')
  check(parser.parseSubagentCommand('/subagent 修改文件 --worktree').isolation === 'worktree', 'Git 隔离显式选择')
  const launch = await load('launch', 'src/shared/subagent-pi-launch.ts')
  check(!!launch.subagentModelError('claude-bridge/claude-haiku-5-5', true), '只读订阅任务在创建子进程前明确拒绝')
  check(!launch.subagentModelError('claude-bridge/claude-haiku-5-5', false), '普通订阅子任务保留 Provider 发现')
  check(!launch.subagentModelError('anthropic/claude-haiku-5-5', true), '原生 Provider 仍可执行只读任务')
  for (const sessionDir of ['C:\\agent data\\会话', '/home/user/agent data/会话']) {
    const portable = launch.subagentPiArgs({ sessionDir, native: true, readOnly: false, model: 'fixture/model' })
    check(portable[portable.indexOf('--session-dir') + 1] === sessionDir, 'Windows/Unix 含空格与中文的会话路径作为单个参数传递')
  }
  const args = launch.subagentPiArgs({ sessionDir: root, native: true, readOnly: false, model: 'provider/child', extensions: ['/fixture/danger-guard.js'] })
  check(args[args.indexOf('--model') + 1] === 'provider/child', '指定模型到达 pi 启动参数')
  check(args.includes('/fixture/danger-guard.js') && !args.includes('--no-extensions'), '写入任务保留危险护栏与原生 Provider 发现')
  const readOnly = launch.subagentPiArgs({ sessionDir: root, native: true, readOnly: true })
  check(readOnly.includes('read,grep,find,ls') && readOnly.includes('--no-extensions'), '只读任务不能被自动发现扩展恢复写入工具')
  const { CapabilityServer } = await load('server', 'src/main/capability-server.ts')
  let confirmed = 0
  const server = new CapabilityServer({ opsDir: join(root, 'ops'), onlyCommands: ['danger.confirm'], handlers: {
    run: async () => { confirmed++; return { summary: { allowed: true } } }
  } })
  const endpoint = await server.start({ sessionId: 'child-1', projectId: 'project-1' })
  Object.assign(process.env, { YAN_CLI_URL: endpoint.url, YAN_CLI_TOKEN: endpoint.token, YAN_SESSION_ID: 'child-1', YAN_PROJECT_ID: 'project-1' })
  try {
    const guard = await load('guard', 'resources/pi-extensions/danger-guard.js')
    let hook
    guard.default({ on: (event, callback) => { if (event === 'tool_call') hook = callback } })
    const invoke = command => hook({ toolName: 'bash', input: { command } }, { cwd: root })
    await writeFile(join(process.env.YAN_DATA_DIR, 'desktop.json'), JSON.stringify({ permissionMode: 'danger', guardOutsideWrites: true }))
    check(await invoke('git status') === undefined && confirmed === 0, '危险档普通命令不审批')
    check(await invoke('git reset --hard HEAD') === undefined && confirmed === 1, '危险命令通过子运行审批通道获准')
    process.env.YAN_CLI_TOKEN = 'incorrect'
    check((await invoke('git reset --hard HEAD'))?.block === true && confirmed === 1, '无效令牌不能绕过审批')
    process.env.YAN_CLI_TOKEN = endpoint.token
    await writeFile(join(process.env.YAN_DATA_DIR, 'desktop.json'), JSON.stringify({ permissionMode: 'all' }))
    check(await invoke('rm -rf /') === undefined && confirmed === 1, '原生档不拦截删除，也不请求审批；测试仅调用钩子，不执行命令')
    const response = await fetch(endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ apiVersion: 1, command: 'subagent.start', params: {}, sessionId: 'child-1', projectId: 'project-1' }) })
    check((await response.json()).ok === false && confirmed === 1, '子审批令牌不能调用派活等其他宿主能力')
  } finally { server.stop() }
  console.log(`PASS: light client ${checks} checks; no credentials or model calls`)
} finally {
  if (oldData === undefined) delete process.env.YAN_DATA_DIR; else process.env.YAN_DATA_DIR = oldData
  for (const [key, value] of Object.entries(oldEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  await rm(root, { recursive: true, force: true })
}
