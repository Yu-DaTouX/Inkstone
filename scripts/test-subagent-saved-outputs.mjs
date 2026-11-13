import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const electronFixture = {
  name: 'electron-fixture',
  setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: [
      'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
      'export const BrowserWindow = class {}',
      'export const safeStorage = { isEncryptionAvailable: () => false }',
      'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
      'export const session = { defaultSession: {}, fromPartition: () => ({}) }'
    ].join('\n') }))
  }
}

const makeRpc = () => {
  const handlers = new Map()
  const rpc = {
    running: false,
    on(event, listener) {
      handlers.set(event, [...(handlers.get(event) ?? []), listener])
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

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((done) => setTimeout(done, 20))
  }
  return predicate()
}

function initRepo(dir) {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q'])
  git(['config', 'user.name', 'Inkstone Test'])
  git(['config', 'user.email', 'test@example.invalid'])
  git(['config', 'commit.gpgsign', 'false'])
  return git
}

await runSuite(import.meta.url, async (ok, compile) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-saved-outputs-'))
  process.env.YAN_DATA_DIR = join(root, 'data')
  process.env.YAN_PI_DIR = join(root, 'pi')
  const leftovers = []
  try {
    const isolation = await compile('src/main/subagent-isolation.ts')
    const notice = await compile('src/shared/subagent-notice.ts')
    const service = await compile('src/main/subagent-service.ts', { plugins: [electronFixture], external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] })
    const { SubagentController } = await compile('src/main/subagents.ts', { plugins: [electronFixture], external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'] })

    const picked = isolation.pickIgnoredOutputs([
      { rel: 'runs/cache.bin', size: 5, rank: isolation.ignoredOutputRank('runs/cache.bin') },
      { rel: 'shots/a.png', size: 6, rank: isolation.ignoredOutputRank('shots/a.png') },
      { rel: 'result.md', size: 4, rank: isolation.ignoredOutputRank('result.md') }
    ], 10)
    ok(picked.kept.map((file) => file.rel).join(',') === 'result.md,shots/a.png' && picked.dropped[0]?.rel === 'runs/cache.bin', '上限内先保说明文件和截图，再按体积挑其他文件', JSON.stringify(picked))
    const sessionCopy = isolation.pickIgnoredOutputs([
      { rel: 'debug/runs/r1/pi-agent/sessions/s.jsonl', size: 1, rank: isolation.ignoredOutputRank('debug/runs/r1/pi-agent/sessions/s.jsonl') },
      { rel: '.tmp/shots/b.png', size: 9, rank: isolation.ignoredOutputRank('.tmp/shots/b.png') }
    ], 9)
    ok(sessionCopy.kept[0]?.rel === '.tmp/shots/b.png' && sessionCopy.dropped[0]?.rel.endsWith('.jsonl'), '会话副本等 jsonl 数据排在截图之后，不挤掉证据', JSON.stringify(sessionCopy))

    const disposable = ['node_modules', 'tsconfig.web.tsbuildinfo', 'debug/runs/r1/yan', 'debug/runs/r1/electron/Cache/x', 'debug/runs/r1/pi-agent/sessions/s.jsonl']
    const kept = ['.tmp', 'debug/runs', 'debug/runs/r1/report.json', 'debug/runs/r1/shot.png', 'debug/yan/a.md']
    ok(disposable.every(isolation.isDisposableOutput) && !kept.some(isolation.isDisposableOutput), '调试实例数据和 tsbuildinfo 不算产物，run 根目录的报告与截图算')
    ok(isolation.ignoredOutputsOf('.tmp/\ntsconfig.node.tsbuildinfo\ndebug/runs/r1/yan/\ndebug/runs/\n').join(',') === '.tmp,debug/runs', '可丢弃的顶层路径不进待另存清单')

    const repo = join(root, 'repo')
    await mkdir(repo, { recursive: true })
    const git = initRepo(repo)
    await writeFile(join(repo, '.gitignore'), '.tmp/\nnode_modules/\ndebug/runs/\n*.tsbuildinfo\n', 'utf8')
    await writeFile(join(repo, 'base.txt'), 'base\n', 'utf8')
    git(['add', '-A'])
    git(['commit', '-q', '-m', 'base'])

    const work = await isolation.prepareWorkspace(repo, 'pick', 'worktree')
    leftovers.push(work.worktreePath)
    await mkdir(join(work.cwd, '.tmp', 'task', 'shots'), { recursive: true })
    await mkdir(join(work.cwd, '.tmp', 'task', 'runs'), { recursive: true })
    await writeFile(join(work.cwd, '.tmp', 'task', 'result.md'), '# 结果\n', 'utf8')
    await writeFile(join(work.cwd, '.tmp', 'task', 'shots', 'a.png'), Buffer.alloc(40, 1))
    await writeFile(join(work.cwd, '.tmp', 'task', 'runs', 'huge.bin'), Buffer.alloc(30, 2))
    await writeFile(join(work.cwd, 'base.txt'), 'changed\n', 'utf8')
    await mkdir(join(work.cwd, 'debug', 'runs', 'r1', 'yan', 'attachments'), { recursive: true })
    await writeFile(join(work.cwd, 'debug', 'runs', 'r1', 'report.json'), '{}', 'utf8')
    await writeFile(join(work.cwd, 'debug', 'runs', 'r1', 'yan', 'attachments', 'big.png'), Buffer.alloc(5, 3))
    await writeFile(join(work.cwd, 'tsconfig.web.tsbuildinfo'), Buffer.alloc(5, 4))
    const collected = await isolation.collectDiff(work, join(root, 'archive-pick'), 'pick')
    ok(!!collected.patchPath && collected.ignoredOutputs?.includes('.tmp'), '有补丁时也列出被忽略的产物，供完成通知提示', JSON.stringify(collected))
    const saved = await isolation.preserveIgnoredOutputs(work, join(root, 'archive-pick'), 'pick', 60)
    ok(saved.ok && saved.path && saved.files.includes('.tmp') && saved.skipped?.includes('.tmp'), '目录超限时逐个文件挑选，部分另存也如实列出', JSON.stringify(saved))
    ok(saved.ok && existsSync(join(saved.path, '.tmp', 'task', 'result.md')) && existsSync(join(saved.path, '.tmp', 'task', 'shots', 'a.png')), '说明文件和截图保住了')
    ok(saved.ok && !existsSync(join(saved.path, '.tmp', 'task', 'runs', 'huge.bin')), '超限的大运行文件没有另存')
    ok(saved.ok && existsSync(join(saved.path, 'debug', 'runs', 'r1', 'report.json')) && !existsSync(join(saved.path, 'debug', 'runs', 'r1', 'yan')), '调试报告另存，实例数据目录不另存', JSON.stringify(saved))
    ok(saved.ok && !saved.files.some((rel) => rel.endsWith('.tsbuildinfo')) && !saved.skipped?.some((rel) => rel.endsWith('.tsbuildinfo') || rel.startsWith('debug')), 'tsbuildinfo 与实例数据不进另存清单，也不报超限', JSON.stringify(saved))
    await isolation.cleanupWorkspace(work)

    const pendingText = notice.buildSubagentNotice({
      id: 'sub-a1b2c3d4', task: '修界面', status: 'done', isolation: 'worktree', review: 'pending',
      diff: { files: 1, additions: 1, deletions: 1, paths: ['a.ts'], truncated: false },
      resultPath: 'C:/tmp/worktree', pendingOutputs: { path: 'D:/data/subagents/sub-a1b2c3d4-outputs', files: ['.tmp'] }
    })
    ok(pendingText.includes('D:/data/subagents/sub-a1b2c3d4-outputs') && pendingText.includes('.tmp') && pendingText.includes('合并或放弃时'), '完成通知说明合并或放弃时另存到哪里', pendingText)
    const onlyIgnored = notice.buildSubagentNotice({
      id: 'sub-a1b2c3d4', task: '截图', status: 'done', isolation: 'worktree', review: 'pending',
      diff: { files: 0, additions: 0, deletions: 0, paths: [], truncated: false },
      pendingOutputs: { path: 'D:/data/subagents/sub-a1b2c3d4-outputs', files: ['.tmp'] }
    })
    ok(onlyIgnored.includes('yan subagent discard --id sub-a1b2c3d4') && onlyIgnored.includes('sub-a1b2c3d4-outputs'), '只有被忽略产物时通知给出处置方式与另存位置', onlyIgnored)
    const savedText = notice.buildSubagentNotice({ id: 'sub-a1b2c3d4', task: '归档', status: 'done', isolation: 'worktree', review: 'archived', savedOutputsPath: 'D:/data/subagents/sub-a1b2c3d4-outputs' })
    ok(savedText.includes('已按原相对路径另存') && savedText.includes('sub-a1b2c3d4-outputs'), '已另存时通知直接给出位置', savedText)
    const plain = notice.buildSubagentNotice({ id: 'sub-a1b2c3d4', task: '只读', status: 'done', isolation: 'controlled-cwd', review: 'none' })
    ok(!plain.includes('另存'), '没有被忽略产物时不加这句')

    const summary = service.subagentOutputsSummary({ savedOutputsPath: 'D:/x-outputs' }, { ok: true, path: 'D:/x-outputs', files: ['.tmp', 'reports'], skipped: ['debug'] })
    ok(summary.savedOutputs === 'D:/x-outputs' && summary.savedOutputsFiles?.includes('.tmp') && summary.savedOutputsSkipped?.includes('debug') && /200MB/.test(summary.savedOutputsSkippedNote), '回执摘要写明位置、另存了哪些、哪些超限', JSON.stringify(summary))
    ok(/没能另存/.test(service.subagentOutputsSummary(undefined, { ok: false, error: 'EBUSY' }).savedOutputsError ?? ''), '另存失败写进摘要')
    ok(/没有需要另存/.test(service.subagentOutputsSummary({}, { ok: true, files: [] }).savedOutputs ?? ''), '没有被忽略产物时明说，不让人以为丢了')

    const archiveDir = join(root, 'archive')
    const rpc = makeRpc()
    const ctrl = new SubagentController({
      cwd: repo,
      archiveDir,
      createRpc: () => rpc,
      prepare: (cwd, id, mode) => isolation.prepareWorkspace(cwd, id, mode),
      onChange: () => {}
    })
    try {
      const started = await ctrl.start('改代码并截图', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-1' })
      ok(started.ok === true && started.run?.isolation === 'worktree', '起一个 worktree 子代理', started.error ?? '')
      const id = started.run.id
      const live = ctrl.get(id)
      leftovers.push(live.cwd)
      await writeFile(join(live.cwd, 'base.txt'), 'subagent\n', 'utf8')
      await mkdir(join(live.cwd, '.tmp', 'F2'), { recursive: true })
      await writeFile(join(live.cwd, '.tmp', 'F2', 'result.md'), '# 说明\n', 'utf8')
      await writeFile(join(live.cwd, '.tmp', 'F2', 'shot.png'), Buffer.from([1, 2, 3]))
      rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '结果在 .tmp/F2/result.md' }], stopReason: 'stop' } })
      rpc.emit('event', { type: 'agent_settled' })
      ok(await waitFor(() => ctrl.get(id)?.review === 'pending'), '有改动的 worktree 进入待审阅', ctrl.get(id)?.review)
      const pending = ctrl.get(id)
      const expected = join(archiveDir, `${id}-outputs`)
      ok(pending.pendingOutputs?.path === expected && pending.pendingOutputs.files.includes('.tmp'), '运行记录带上待另存的位置', JSON.stringify(pending.pendingOutputs))
      ok(notice.buildSubagentNotice(pending).includes(expected), '完成通知里有将要另存的位置')

      const svc = new service.SubagentService({})
      svc.get = async () => ctrl
      const context = { cwd: repo, parentSessionId: ctrl.get(id).parentSessionId }
      const before = await svc.capabilityHost.run('subagent.get', { id }, context)
      ok(before.summary.ignoredOutputsSaveTo === expected && before.summary.ignoredOutputs?.includes('.tmp'), 'get 摘要在合并前说明另存位置', JSON.stringify(before.summary))

      const merged = await svc.capabilityHost.run('subagent.merge', { id }, context)
      ok(merged.summary.savedOutputs === expected && merged.summary.savedOutputsFiles?.includes('.tmp'), 'merge 回执写明另存位置与顶层路径', JSON.stringify(merged.summary))
      ok(merged.data.savedOutputs?.path === expected && merged.data.savedOutputsPath === expected, 'merge 结果文件里也有另存信息', JSON.stringify(merged.data.savedOutputs))
      ok(!existsSync(live.cwd), '合并后工作树照常清理', live.cwd)
      ok((await readFile(join(expected, '.tmp', 'F2', 'result.md'), 'utf8')) === '# 说明\n' && existsSync(join(expected, '.tmp', 'F2', 'shot.png')), '说明文件和截图在另存位置')
      const after = await svc.capabilityHost.run('subagent.get', { id }, context)
      ok(after.summary.savedOutputs === expected && !after.summary.ignoredOutputs, 'get 摘要在合并后给出另存位置', JSON.stringify(after.summary))

      const rpc2 = makeRpc()
      const ctrl2 = new SubagentController({
        cwd: repo,
        archiveDir,
        createRpc: () => rpc2,
        prepare: (cwd, runId, mode) => isolation.prepareWorkspace(cwd, runId, mode),
        onChange: () => {}
      })
      try {
        const second = await ctrl2.start('只截图', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-1' })
        const id2 = second.run.id
        const live2 = ctrl2.get(id2)
        leftovers.push(live2.cwd)
        await mkdir(join(live2.cwd, '.tmp', 'shots'), { recursive: true })
        await writeFile(join(live2.cwd, '.tmp', 'shots', 'b.png'), Buffer.from([4, 5]))
        rpc2.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '截好了' }], stopReason: 'stop' } })
        rpc2.emit('event', { type: 'agent_settled' })
        ok(await waitFor(() => ctrl2.get(id2)?.review === 'pending'), '只写了被忽略文件的 worktree 保留待处置', ctrl2.get(id2)?.review)
        const svc2 = new service.SubagentService({})
        svc2.get = async () => ctrl2
        const discarded = await svc2.capabilityHost.run('subagent.discard', { id: id2 }, { cwd: repo, parentSessionId: ctrl2.get(id2).parentSessionId })
        const expected2 = join(archiveDir, `${id2}-outputs`)
        ok(discarded.summary.savedOutputs === expected2 && existsSync(join(expected2, '.tmp', 'shots', 'b.png')), 'discard 也先另存被忽略的产物并在回执写明', JSON.stringify(discarded.summary))
        ok(!existsSync(live2.cwd), '放弃后工作树照常清理', live2.cwd)
      } finally {
        await ctrl2.stopAll()
      }
    } finally {
      await ctrl.stopAll()
    }
  } finally {
    for (const path of leftovers) if (path && existsSync(path)) await rm(path, { recursive: true, force: true }).catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
})
