import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BUILD_DIR = '.tmp/audit-subagent'

await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagent-isolation.ts'],
    outfile: `${BUILD_DIR}/isolation-discard.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)
await import('../node_modules/esbuild/lib/main.js').then(({ build }) =>
  build({
    entryPoints: ['src/main/subagents.ts'],
    outfile: `${BUILD_DIR}/subagents-discard.mjs`,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
)

const { prepareWorkspace } = await import(`../${BUILD_DIR}/isolation-discard.mjs`)
const { SubagentController } = await import(`../${BUILD_DIR}/subagents-discard.mjs`)

let checks = 0
const ok = (condition, label, detail) => {
  assert.ok(condition, detail === undefined ? label : `${label}（${detail}）`)
  checks += 1
}

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 20))
  }
  return predicate()
}

const makeRpc = () => {
  const handlers = new Map()
  const rpc = {
    running: false,
    on(event, listener) {
      const list = handlers.get(event) ?? []
      list.push(listener)
      handlers.set(event, list)
      return rpc
    },
    spawn() { rpc.running = true },
    async command(type) {
      if (type === 'get_state') return { success: true, data: {} }
      return { success: true }
    },
    async close() { rpc.running = false },
    emit(event, ...payload) {
      for (const listener of handlers.get(event) ?? []) listener(...payload)
    }
  }
  return rpc
}

const root = await mkdtemp(join(tmpdir(), 'yan-discard-cleanup-'))
const repo = join(root, 'repo')
let workspace
try {
  await mkdir(repo, { recursive: true })
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.name', 'Inkstone Test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
  git(['add', '-A'])
  git(['commit', '-q', '-m', 'base'])

  const rpc = makeRpc()
  const ctrl = new SubagentController({
    cwd: repo,
    archiveDir: join(root, 'archive'),
    createRpc: () => rpc,
    prepare: (cwd, id, isolation) => prepareWorkspace(cwd, id, isolation),
    onChange: () => {}
  })
  try {
    const started = await ctrl.start('改一点东西', undefined, 'worktree')
    ok(started.ok === true && started.run?.isolation === 'worktree', '起一个 worktree 子代理', started.error ?? '')
    const id = started.run.id
    const live = ctrl.get(id)
    workspace = { worktreePath: live.cwd, containerPath: join(live.cwd, '..') }
    ok(existsSync(join(live.cwd, 'base.txt')), '工作树已就绪', live.cwd)

    await writeFile(join(live.cwd, 'changed.txt'), 'change\n', 'utf8')
    rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '改完了' }], stopReason: 'stop' } })
    rpc.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => ctrl.get(id)?.status === 'done'), '子代理正常结束', ctrl.get(id)?.status)
    ok(await waitFor(() => ctrl.get(id)?.review === 'pending' && !!ctrl.get(id)?.diff?.patchPath), '有改动的 worktree 进入待审阅', JSON.stringify({ review: ctrl.get(id)?.review, diff: ctrl.get(id)?.diff }))

    await rename(join(repo, '.git'), join(repo, '.git-away'))
    const failed = await ctrl.discard(id)
    const after = ctrl.get(id)
    ok(failed.ok === false, '清理工作树失败时放弃不能报成功', JSON.stringify(failed))
    ok(after.review === 'pending', '清理失败仍保持待审阅，不会假装已放弃', after.review)
    ok(/移除 worktree 失败/.test(after.error ?? ''), '失败原因写进运行记录', after.error)
    ok(existsSync(live.cwd), '清理失败时工作树保留', live.cwd)

    await rename(join(repo, '.git-away'), join(repo, '.git'))
    const retried = await ctrl.discard(id)
    ok(retried.ok === true && ctrl.get(id)?.review === 'discarded', '修好后重试放弃成功', JSON.stringify({ retried, review: ctrl.get(id)?.review }))
    ok(!existsSync(live.cwd), '重试成功后才移除工作树', live.cwd)
  } finally {
    await ctrl.stopAll()
  }
} finally {
  if (workspace?.worktreePath && existsSync(workspace.worktreePath)) await rm(workspace.worktreePath, { recursive: true, force: true }).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
}

console.log(`subagent-discard-cleanup: ${checks} checks passed`)
