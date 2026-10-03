import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-hub-test-'))
for (const name of ['resources', 'workspaces', 'terminal-launch']) await build({ entryPoints: [`src/main/agent-hub/${name}.ts`], outfile: join(root, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { hubTerminalArgs } = await import(pathToFileURL(join(root, 'terminal-launch.mjs')))
for (const agent of ['codex', 'claude', 'pi', 'gemini', 'grok']) {
  assert.deepEqual(hubTerminalArgs([], { agent, prompt: '' }), [], `${agent} must open interactively without a synthetic prompt`)
  const text = '用户原文：只查看文件，包含 "quotes" 与 $variables'
  const args = hubTerminalArgs(['fixture-launcher'], { agent, prompt: text })
  assert.equal(args.at(-1), text, 'CLI receives one verbatim prompt argument, without host instructions')
}
assert.deepEqual(hubTerminalArgs([], { agent: 'codex', prompt: '', externalSessionId: 'native-session', model: 'chosen-model' }), ['resume', 'native-session', '--model', 'chosen-model'])
{
  /* 终端接入砚的 MCP 入口：Codex 用 -c 内联表且令牌只经 env_vars 转交；Claude 的 --mcp-config 排在初始指令之后。 */
  const bridge = { execPath: 'C:\\Program Files\\Inkstone\\Inkstone.exe', script: 'C:\\app\\yan-cli\\hub-mcp.mjs', claudeConfigPath: 'C:\\data\\mcp.json' }
  const codex = hubTerminalArgs(['launcher'], { agent: 'codex', prompt: 'do it', externalSessionId: 'sid' }, bridge)
  assert.deepEqual(codex.slice(0, 2), ['launcher', '-c'])
  assert.ok(codex[2].startsWith('mcp_servers.inkstone={command=') && codex[2].includes("env_vars=['INKSTONE_HUB_URL','INKSTONE_HUB_TOKEN'"), 'codex gets the inline MCP table')
  assert.ok(!codex[2].includes('Bearer') && !/TOKEN=/.test(codex[2]), 'token values never appear on the command line')
  assert.deepEqual(codex.slice(3), ['resume', 'sid', 'do it'])
  const claude = hubTerminalArgs([], { agent: 'claude', prompt: 'do it' }, bridge)
  assert.deepEqual(claude, ['do it', '--mcp-config', 'C:\\data\\mcp.json'])
  assert.deepEqual(hubTerminalArgs([], { agent: 'gemini', prompt: '' }, bridge), [], 'other CLIs are untouched')
}
{
  /* 会话接续：能预设会话 ID 的 CLI 首次用 --session-id，再次启动按各自方式恢复，且不重发初始指令。 */
  const uuid = '11111111-2222-3333-4444-555555555555'
  const fresh = (agent) => hubTerminalArgs([], { agent, prompt: 'go' }, undefined, { id: uuid, resume: false, uniqueCwd: true })
  const again = (agent, uniqueCwd = true) => hubTerminalArgs([], { agent, prompt: 'go' }, undefined, { id: uuid, resume: true, uniqueCwd })
  assert.deepEqual(fresh('claude'), ['--session-id', uuid, 'go'])
  assert.deepEqual(again('claude'), ['--resume', uuid])
  assert.deepEqual(fresh('grok'), ['--session-id', uuid, 'go'])
  assert.deepEqual(again('grok'), ['--resume', uuid])
  assert.deepEqual(fresh('gemini'), ['--session-id', uuid, '--prompt-interactive', 'go'])
  assert.deepEqual(again('gemini'), ['--resume', 'latest'])
  assert.deepEqual(fresh('antigravity'), ['-i', 'go'], 'agy takes the opening prompt through -i and cannot preset an id')
  assert.deepEqual(again('antigravity'), ['--continue'], 'agy resumes the directory\'s latest conversation')
  const legacy = (agent) => hubTerminalArgs([], { agent, prompt: 'go' }, undefined, { resume: true, uniqueCwd: true })
  assert.deepEqual(legacy('claude'), ['--continue'], 'tasks started before IDs were recorded resume by directory')
  assert.deepEqual(legacy('grok'), ['--continue'])
  assert.deepEqual(fresh('codex'), ['go'],'codex generates its own id; the first launch is plain')
  assert.deepEqual(again('codex'), ['resume', '--last'], 'a private worktree makes --last unambiguous')
  assert.deepEqual(again('codex', false), ['resume'], 'a shared project folder falls back to the picker')
}
const { ResourceCoordinator } = await import(pathToFileURL(join(root, 'resources.mjs')))
const { hubGit, createHubWorkspace, freezeHubWorkspace, applyHubArtifact } = await import(pathToFileURL(join(root, 'workspaces.mjs')))
const resources = new ResourceCoordinator()
const release = await resources.acquire('desktop', 'a')
const order = []
const b = resources.acquire('desktop', 'b', 1000).then((done) => { order.push('b'); done() })
const c = resources.acquire('desktop', 'c', 1000).then((done) => { order.push('c'); done() })
await assert.rejects(resources.acquire('desktop', 'expired', 5), { code: 'waiting_resource' })
assert.equal(resources.snapshot()[0].owner, 'a', 'waiting timeout must not release in-flight action')
release(); release(); await Promise.all([b, c]); assert.deepEqual(order, ['b', 'c'])
const unknown = await resources.acquire('desktop', 'unknown')
resources.markUncertain('desktop'); unknown()
await assert.rejects(resources.acquire('desktop', 'retry'), { code: 'waiting_resource' })
resources.resolveUncertain('desktop')
resources.setPaused('desktop', true)
await assert.rejects(resources.acquire('desktop', 'agent'), { code: 'waiting_resource' })
resources.setPaused('desktop', false)
const resumed = await resources.acquire('desktop', 'resumed'); resumed()

const journal = join(root, 'resource-journal.json')
const durable = new ResourceCoordinator(); durable.attachJournal(journal)
const inFlight = await durable.acquire('windows-interaction', 'crash-fixture')
const saved = JSON.parse(await readFile(journal, 'utf8'))
assert.equal(saved[0].owner, 'crash-fixture', 'grant must be persisted before caller sends an action')
const afterCrash = new ResourceCoordinator(); afterCrash.attachJournal(journal)
assert.equal(afterCrash.snapshot()[0].uncertain, true)
await assert.rejects(afterCrash.acquire('windows-interaction', 'replay'), { code: 'waiting_resource' })
afterCrash.resolveUncertain('windows-interaction')
const checked = await afterCrash.acquire('windows-interaction', 'checked'); checked()
const afterRelease = new ResourceCoordinator(); afterRelease.attachJournal(journal)
assert.equal(afterRelease.snapshot()[0].uncertain, false)
// 单独的实例模拟崩溃；旧实例不会再执行其释放回调。
void inFlight
await writeFile(journal, '{broken')
const corrupted = new ResourceCoordinator(); corrupted.attachJournal(journal)
assert.equal(corrupted.snapshot()[0].uncertain, true, 'corrupt journal must quarantine instead of replay')

const repo = join(root, 'repo'); await mkdir(repo)
await hubGit(repo, ['init'])
await hubGit(repo, ['config', 'user.name', 'Hub fixture'])
await hubGit(repo, ['config', 'user.email', 'fixture@example.invalid'])
await hubGit(repo, ['config', 'core.autocrlf', 'false'])
await writeFile(join(repo, 'tracked.txt'), 'base\n')
await hubGit(repo, ['add', 'tracked.txt']); await hubGit(repo, ['commit', '-m', 'fixture baseline'])
const worker = await createHubWorkspace(repo, join(root, 'worker'))
await writeFile(join(worker.cwd, 'tracked.txt'), 'committed\n')
await hubGit(worker.cwd, ['add', 'tracked.txt']); await hubGit(worker.cwd, ['commit', '-m', 'fixture worker change'])
await writeFile(join(worker.cwd, 'tracked.txt'), 'uncommitted\n')
await writeFile(join(worker.cwd, 'new.txt'), 'untracked\n')
await writeFile(join(worker.cwd, 'binary.bin'), Buffer.from([0, 1, 2, 255]))
const indexBefore = await hubGit(worker.cwd, ['write-tree'])
const statusBefore = await hubGit(worker.cwd, ['status', '--porcelain'])
const artifact = await freezeHubWorkspace(worker.cwd, worker.baseline, join(root, 'artifact'), 'fixture report')
assert.equal(await hubGit(worker.cwd, ['write-tree']), indexBefore)
assert.equal(await hubGit(worker.cwd, ['status', '--porcelain']), statusBefore)
const review = await createHubWorkspace(repo, join(root, 'review'), worker.baseline)
await applyHubArtifact(review.cwd, artifact)
assert.equal(await readFile(join(review.cwd, 'tracked.txt'), 'utf8'), 'uncommitted\n')
assert.equal(await readFile(join(review.cwd, 'new.txt'), 'utf8'), 'untracked\n')
assert.deepEqual(await readFile(join(review.cwd, 'binary.bin')), Buffer.from([0, 1, 2, 255]))
await writeFile(artifact.patchPath, 'tampered')
await assert.rejects(applyHubArtifact(review.cwd, artifact), /版本已改变/)
console.log('Agent Hub offline checks passed: FIFO, wait expiry, uncertain quarantine, user pause, frozen committed/uncommitted/untracked/binary changes, unchanged source index, exact review tree, tamper rejection.')
console.log(`Isolated fixture retained: ${root}`)
