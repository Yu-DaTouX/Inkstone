import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmdirSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const DAY = 24 * 60 * 60 * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

function rpcFactory() {
  const created = []
  const createRpc = ({ cwd, args }) => {
    const handlers = new Map()
    const rpc = {
      cwd,
      args,
      commands: [],
      running: false,
      closed: false,
      on(event, listener) {
        handlers.set(event, [...(handlers.get(event) ?? []), listener])
        return rpc
      },
      spawn() { rpc.running = true },
      async command(type, payload) {
        rpc.commands.push({ type, payload })
        return { success: true, data: type === 'get_state' ? {} : undefined }
      },
      async close() {
        rpc.running = false
        rpc.closed = true
      },
      emit(event, ...payload) {
        for (const listener of handlers.get(event) ?? []) listener(...payload)
      }
    }
    created.push(rpc)
    return rpc
  }
  return { created, createRpc }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()

async function newRepo(base, name) {
  const repo = join(base, name)
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'keep@example.invalid')
  git(repo, 'config', 'user.name', 'keep')
  git(repo, 'config', 'core.autocrlf', 'false')
  await writeFile(join(repo, '.gitignore'), 'reports/\nnode_modules/\n')
  await writeFile(join(repo, 'a.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

function listFiles(dir) {
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : []
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { SubagentController } = await compile('src/main/subagents.ts')
  const base = await mkdtemp(join(tmpdir(), 'inkstone-exit-keep-'))
  const controllers = []
  const trees = []
  const track = (started) => {
    if (started?.run?.isolation === 'worktree' && /yan-subagent-/.test(started.run.cwd)) trees.push(started.run.cwd)
    return started
  }
  const make = (cwd, archive, factory) => {
    const ctrl = new SubagentController({ cwd, archiveDir: archive, createRpc: factory.createRpc, onChange: () => {}, onFinished: () => {} })
    ctrl.waitTranscriptQuiet = async () => {}
    controllers.push(ctrl)
    return ctrl
  }
  const sessionFor = async (archive, id) => {
    const dir = join(archive, 'sessions', id)
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'native.jsonl')
    await writeFile(file, '{}\n')
    return file
  }
  try {
    {
      const repo = await newRepo(base, 'repo-running')
      const archive = join(base, 'archive-running')
      const first = rpcFactory()
      const ctrl = make(repo, archive, first)
      const started = track(await ctrl.start('改 a.txt 并写报告', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-a' }))
      ok(started.ok && started.run.status === 'running', 'worktree 子代理启动并在运行', started.error ?? '')
      const id = started.run.id
      const worktree = started.run.cwd
      await writeFile(join(worktree, 'a.txt'), 'changed before exit\n')
      await mkdir(join(worktree, 'reports'), { recursive: true })
      await writeFile(join(worktree, 'reports', 'notes.md'), 'ignored output\n')
      const sessionFile = await sessionFor(archive, id)

      await ctrl.stopAll()
      const exited = ctrl.get(id)
      ok(first.created[0].commands.some((c) => c.type === 'abort') && first.created[0].closed, '退出时先中止并关掉子代理进程')
      ok(exited.status === 'cancelled' && exited.endReason === 'interrupted', '退出时运行中的子代理记为「已中断」', JSON.stringify({ status: exited.status, endReason: exited.endReason }))
      ok(exited.review === 'pending' && existsSync(worktree), '退出时工作树保留，审阅状态仍可合并、放弃、续接')
      ok(!!exited.diff?.patchPath && existsSync(exited.diff.patchPath) && (await readFile(exited.diff.patchPath, 'utf8')).includes('changed before exit'), '退出时照旧把改动存成补丁备份')
      ok(listFiles(join(archive, `${id}-outputs`)).some((f) => f.replace(/\\/g, '/') === 'reports/notes.md'), '退出时照旧另存被忽略的产物备份')
      ok(!exited.savedOutputsPath && exited.pendingOutputs?.files.includes('reports'), '备份不改变「合并或放弃时另存」的说明')
      ok(exited.resumable?.ok === true, '退出后同一进程里也标明可续接', JSON.stringify(exited.resumable))
      const saved = JSON.parse(await readFile(join(archive, `${id}.json`), 'utf8'))
      ok(saved.status === 'cancelled' && saved.endReason === 'interrupted' && saved.review === 'pending' && saved.resume?.workspace?.worktreePath === worktree, '落盘记录带中断状态与原工作树')

      const second = rpcFactory()
      const reopened = make(repo, archive, second)
      await reopened.loadHistory()
      const loaded = reopened.get(id)
      ok(loaded.status === 'cancelled' && loaded.endReason === 'interrupted' && loaded.review === 'pending', '重启后仍是已中断、待处置')
      ok(loaded.resumable?.ok === true && existsSync(worktree), '重启后可续接，工作树还在', JSON.stringify(loaded.resumable))
      ok(loaded.parentSessionId === 'parent-a', '重启后会话归属不变')

      const stranger = await reopened.send(id, '别的会话来续', 'steer', { parentSessionId: 'parent-b', from: 'parent' })
      ok(!stranger.ok && second.created.length === 0, '别的会话不能续接，也不起进程', stranger.error)

      const sending = reopened.send(id, '继续把报告写完', 'steer', { parentSessionId: 'parent-a', from: 'parent' })
      const twice = await reopened.send(id, '并发再来一条', 'steer', { parentSessionId: 'parent-a', from: 'parent' })
      ok(!twice.ok && /启动/.test(twice.error ?? ''), '续接进行中时第二条并发续接被拒', twice.error)
      const resumed = await sending
      ok(resumed.ok && resumed.delivery === 'resumed', '重启后 send 续接成功', JSON.stringify(resumed))
      ok(second.created.length === 1, '只起一个续接进程')
      const rpc = second.created[0]
      ok(rpc.cwd === worktree, '续接在原工作树里运行', rpc.cwd)
      const at = rpc.args.indexOf('--session')
      ok(at >= 0 && rpc.args[at + 1] === sessionFile, '续接沿用原 pi 会话文件', JSON.stringify(rpc.args))
      const prompt = rpc.commands.find((c) => c.type === 'prompt')?.payload?.message ?? ''
      ok(/被中断/.test(prompt) && prompt.endsWith('继续把报告写完'), '续接消息说明上一轮被中断，按打断的回合接着做', prompt)
      ok(reopened.get(id).status === 'running' && reopened.get(id).endReason === undefined, '续接后回到运行中')
      const merging = await reopened.merge(id)
      ok(!merging.ok && existsSync(worktree), '运行中不能合并，工作树不动', merging.error)

      await writeFile(join(worktree, 'b.txt'), 'after resume\n')
      rpc.emit('event', { type: 'agent_settled' })
      ok(await waitFor(() => reopened.get(id)?.status === 'done' && reopened.get(id)?.review === 'pending' && reopened.get(id)?.diff?.files === 2), '续接结束后改动含中断前后两部分', JSON.stringify(reopened.get(id)?.diff))
      const merged = await reopened.merge(id)
      ok(merged.ok && (await readFile(join(repo, 'a.txt'), 'utf8')) === 'changed before exit\n' && existsSync(join(repo, 'b.txt')), '合并照常应用到主工作目录', JSON.stringify(merged))
      ok(!existsSync(worktree) && reopened.get(id).review === 'merged', '合并后才删工作树')
    }

    {
      const repo = await newRepo(base, 'repo-workflow')
      const archive = join(base, 'archive-workflow')
      const factory = rpcFactory()
      const ctrl = make(repo, archive, factory)
      const started = track(await ctrl.start('工作流里的 agent()', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-a', parentMessageId: 'workflow:wf-0123abcd' }))
      ok(started.ok, '工作流子代理启动')
      await writeFile(join(started.run.cwd, 'a.txt'), 'workflow change\n')
      await ctrl.stopAll()
      const run = ctrl.get(started.run.id)
      ok(run.status === 'cancelled' && run.review === 'archived' && !existsSync(started.run.cwd), '工作流 agent() 子代理退出时照旧归档并清理（由工作流 resume 重放）')
      ok(!!run.diff?.patchPath && existsSync(run.diff.patchPath), '工作流子代理的补丁照旧存档')
    }

    {
      const root = join(base, 'readonly')
      await mkdir(root, { recursive: true })
      const archive = join(base, 'archive-readonly')
      const first = rpcFactory()
      const ctrl = make(root, archive, first)
      const started = track(await ctrl.start('只读调查', undefined, 'controlled-cwd', undefined, undefined, { cwd: root, parentSessionId: 'parent-r' }))
      ok(started.ok, '只读子代理启动')
      const sessionFile = await sessionFor(archive, started.run.id)
      await ctrl.stopAll()
      ok(ctrl.get(started.run.id).endReason === 'interrupted', '只读子代理退出时同样记为已中断')
      const second = rpcFactory()
      const reopened = make(root, archive, second)
      await reopened.loadHistory()
      ok(reopened.get(started.run.id).resumable?.ok === true, '只读子代理重启后可续接')
      const resumed = await reopened.send(started.run.id, '接着查', 'steer', { parentSessionId: 'parent-r', from: 'parent' })
      const rpc = second.created[0]
      ok(resumed.ok && rpc?.cwd === root && rpc.args[rpc.args.indexOf('--session') + 1] === sessionFile, '只读子代理在原目录、原会话续接', JSON.stringify(resumed))
      ok(/被中断/.test(rpc.commands.find((c) => c.type === 'prompt')?.payload?.message ?? ''), '只读子代理续接同样按被打断的回合处理')
      await reopened.stop(started.run.id)
    }

    {
      const repo = await newRepo(base, 'repo-crash')
      const archive = join(base, 'archive-crash')
      const ctrl = make(repo, archive, rpcFactory())
      const started = track(await ctrl.start('崩溃时没有改动', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-c' }))
      const reopened = make(repo, archive, rpcFactory())
      await reopened.loadHistory()
      const run = reopened.get(started.run.id)
      ok(run.status === 'cancelled' && run.endReason === 'interrupted' && run.review === 'pending' && existsSync(started.run.cwd), '异常退出（没来得及收尾）的 worktree 子代理同样保留工作树')
    }

    {
      const repo = await newRepo(base, 'repo-review2')
      const archive = join(base, 'archive-review2')
      const ctrl = make(repo, archive, rpcFactory())
      const ctx = (over = {}) => ({ cwd: repo, parentSessionId: 'parent-v', ...over })
      const wfMoved = track(await ctrl.start('工作流子代理被主会话 send 过', undefined, 'worktree', undefined, undefined, ctx({ parentMessageId: 'workflow:wf-0123abcd' })))
      ctrl.runs.get(wfMoved.run.id).parentMessageIds = ['workflow:wf-0123abcd']
      ctrl.runs.get(wfMoved.run.id).parentMessageId = 'msg-later'
      await writeFile(join(wfMoved.run.cwd, 'a.txt'), 'wf moved\n')
      const stale = track(await ctrl.start('未保存会话派出的', undefined, 'worktree', undefined, undefined, ctx({ parentSessionId: 'pending:r1', parentRunId: 'r1', parentGeneration: 1 })))
      await sessionFor(archive, stale.run.id)
      await writeFile(join(stale.run.cwd, 'a.txt'), 'stale change\n')
      const grow = track(await ctrl.start('退出后被删文件', undefined, 'worktree', undefined, undefined, ctx()))
      await writeFile(join(grow.run.cwd, 'a.txt'), 'grow change\n')
      await writeFile(join(grow.run.cwd, 'keep.txt'), 'keep\n')
      const edited = track(await ctrl.start('退出后又被改', undefined, 'worktree', undefined, undefined, ctx()))
      await writeFile(join(edited.run.cwd, 'a.txt'), 'edited change\n')
      const resumedBefore = track(await ctrl.start('续接过、补丁比结束时间旧', undefined, 'worktree', undefined, undefined, ctx()))
      await writeFile(join(resumedBefore.run.cwd, 'a.txt'), 'resumed change\n')
      const big = track(await ctrl.start('产物超出另存上限', undefined, 'worktree', undefined, undefined, ctx()))
      await writeFile(join(big.run.cwd, 'a.txt'), 'big change\n')
      await mkdir(join(big.run.cwd, 'reports'), { recursive: true })
      await writeFile(join(big.run.cwd, 'reports', 'big.bin'), '')
      await truncate(join(big.run.cwd, 'reports', 'big.bin'), 201 * 1024 * 1024)
      const tampered = track(await ctrl.start('记录被改过', undefined, 'worktree', undefined, undefined, ctx()))
      await sessionFor(archive, tampered.run.id)
      await writeFile(join(tampered.run.cwd, 'a.txt'), 'tampered change\n')
      const crashWf = track(await ctrl.start('崩溃时的工作流子代理', undefined, 'worktree', undefined, undefined, ctx({ parentMessageId: 'workflow:wf-0badc0de' })))
      await writeFile(join(crashWf.run.cwd, 'a.txt'), 'crash wf\n')
      for (const started of [wfMoved, stale, grow, edited, resumedBefore, big, tampered]) await ctrl.stop(started.run.id)
      const exitedWf = ctrl.get(wfMoved.run.id)
      ok(exitedWf.review === 'archived' || exitedWf.review === 'pending', '停止后待处置')
      await ctrl.history.save({ ...ctrl.history.get(crashWf.run.id).run, status: 'running', endedAt: undefined, review: 'none' }, repo)
      for (const started of [wfMoved, stale, grow, edited, resumedBefore, big, tampered]) {
        const record = ctrl.history.get(started.run.id)
        await ctrl.history.save({ ...record.run, status: 'cancelled', endReason: 'interrupted' }, record.rootCwd)
      }

      const second = rpcFactory()
      const reopened = make(repo, archive, second)
      await reopened.loadHistory()
      await sleep(200)
      const crashRun = reopened.get(crashWf.run.id)
      ok(!existsSync(crashWf.run.cwd) && (crashRun.review === 'archived' || crashRun.review === 'none') && !!crashRun.diff?.patchPath, '崩溃恢复：工作流子代理照旧归档并删除工作树', JSON.stringify({ review: crashRun.review, diff: crashRun.diff }))

      const staleSend = await reopened.send(stale.run.id, '冒名续接', 'steer', { parentSessionId: 'pending:r1', from: 'parent' })
      ok(!staleSend.ok && /归属无法确认/.test(staleSend.error ?? '') && second.created.length === 0, '上次启动的 pending: 归属：父会话 send 一律拒绝', staleSend.error)
      ok(!reopened.parentOwns(stale.run.id, 'pending:r1') && reopened.parentOwns(grow.run.id, 'parent-v'), 'get/merge/discard 的归属检查同样拒绝 pending:，正常会话不受影响')
      const userSend = await reopened.send(stale.run.id, '用户在界面续接', 'steer', { from: 'user' })
      ok(userSend.ok && reopened.get(stale.run.id).parentRunId === undefined && reopened.get(stale.run.id).parentGeneration === undefined, '用户在界面可续接，续接后不再挂在旧的 runner 上', JSON.stringify(userSend))
      await reopened.stop(stale.run.id)

      reopened.retiring.add(grow.run.id)
      const busySend = await reopened.send(grow.run.id, '清理中续接', 'steer', { parentSessionId: 'parent-v', from: 'parent' })
      const busyMerge = await reopened.merge(grow.run.id)
      ok(/闲置工作树/.test(busySend.error ?? '') && /闲置工作树/.test(busyMerge.error ?? ''), '清理占着锁时给专门提示', `${busySend.error} | ${busyMerge.error}`)
      reopened.retiring.delete(grow.run.id)

      const record = reopened.history.get(tampered.run.id)
      record.resume = { ...record.resume, workspace: { ...record.resume.workspace, cwd: repo, worktreePath: repo } }
      const tamperSend = await reopened.send(tampered.run.id, '改了记录', 'steer', { parentSessionId: 'parent-v', from: 'parent' })
      ok(!tamperSend.ok && /核对/.test(tamperSend.error ?? '') && second.created.length === 1, '记录里的工作树路径被改成主仓库时不续接', tamperSend.error)

      await rm(join(grow.run.cwd, 'keep.txt'))
      await rm(join(grow.run.cwd, 'a.txt'))
      await writeFile(join(edited.run.cwd, 'b.txt'), 'after end\n')
      const resumedPatch = reopened.get(resumedBefore.run.id).diff.patchPath
      const resumedPatchText = await readFile(resumedPatch, 'utf8')
      await utimes(resumedPatch, new Date(Date.now() - DAY), new Date(Date.now() - DAY))

      const later = Date.now() + 8 * DAY
      const retired = await reopened.pruneIdleWorktrees({ now: later })
      ok(!retired.includes(grow.run.id) && existsSync(grow.run.cwd) && /删除比上次保存的补丁多/.test(reopened.get(grow.run.id).error ?? ''), '删除项比退出时的补丁多：保留工作树并标记', reopened.get(grow.run.id).error)
      ok(!retired.includes(edited.run.id) && existsSync(edited.run.cwd) && /又有改动/.test(reopened.get(edited.run.id).error ?? ''), '退出后工作树又被改：保留并标记')
      ok(retired.includes(resumedBefore.run.id) && (await readFile(resumedPatch, 'utf8')) === resumedPatchText, '续接过（补丁比结束时间旧）：重新收集但不覆盖原补丁')
      const resumedRun = reopened.get(resumedBefore.run.id)
      ok(/-idle-\d{14}\.patch$/.test(resumedRun.diff.patchPath ?? '') && (await readFile(resumedRun.diff.patchPath, 'utf8')).includes('resumed change'), '新补丁写成新文件名，记录指向它', resumedRun.diff.patchPath)
      ok(!retired.includes(big.run.id) && existsSync(big.run.cwd) && /另存上限/.test(reopened.get(big.run.id).error ?? ''), '被忽略产物超出另存上限：保留工作树并写进记录', reopened.get(big.run.id).error)
      ok(!retired.includes(tampered.run.id) && existsSync(tampered.run.cwd) && existsSync(join(repo, 'a.txt')) && /不是砚为/.test(reopened.get(tampered.run.id).error ?? ''), '记录被改过：不清理，主仓库不动', reopened.get(tampered.run.id).error)
      const errorsBefore = reopened.get(grow.run.id).error
      await reopened.pruneIdleWorktrees({ now: later })
      ok(reopened.get(grow.run.id).error === errorsBefore, '同一原因不重复追加')
      const wfRun = reopened.get(wfMoved.run.id)
      ok(!existsSync(wfMoved.run.cwd) && wfRun.review === 'archived', '工作流子代理被主会话 send 过（锚点换掉）时退出仍照旧归档', JSON.stringify({ review: wfRun.review }))
    }

    {
      const repo = await newRepo(base, 'repo-prune')
      const archive = join(base, 'archive-prune')
      const targets = join(base, 'prune-targets')
      await mkdir(join(targets, 'deps', 'pkg'), { recursive: true })
      await writeFile(join(targets, 'deps', 'pkg', 'index.js'), 'module.exports = 1\n')
      await mkdir(join(targets, 'shared'), { recursive: true })
      await writeFile(join(targets, 'shared', 'keep.txt'), 'keep\n')
      const ctrl = make(repo, archive, rpcFactory())
      const startedOld = track(await ctrl.start('闲置很久的工作树', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-p' }))
      const startedFresh = track(await ctrl.start('刚中断的工作树', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-p' }))
      const startedBroken = track(await ctrl.start('补丁存不下来的工作树', undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-p' }))
      const oldTree = startedOld.run.cwd
      await writeFile(join(oldTree, 'a.txt'), 'old idle change\n')
      await mkdir(join(oldTree, 'reports'), { recursive: true })
      await writeFile(join(oldTree, 'reports', 'summary.md'), 'idle notes\n')
      symlinkSync(join(targets, 'deps'), join(oldTree, 'node_modules'), 'junction')
      await mkdir(join(oldTree, 'linked'), { recursive: true })
      symlinkSync(join(targets, 'shared'), join(oldTree, 'linked', 'shared'), 'junction')
      await writeFile(join(startedFresh.run.cwd, 'a.txt'), 'fresh change\n')
      await writeFile(join(startedBroken.run.cwd, 'a.txt'), 'broken change\n')
      await ctrl.stopAll()

      const later = Date.now() + 8 * DAY
      const pruner = make(repo, archive, rpcFactory())
      await pruner.loadHistory()
      await sleep(200)
      ok(existsSync(oldTree) && existsSync(startedFresh.run.cwd), '启动时的后台清理不动保留期内的工作树')
      await rename(join(startedBroken.run.cwd, '.git'), join(startedBroken.run.cwd, '.git-moved'))
      pruner.history.get(startedFresh.run.id).run.endedAt = later - 2 * DAY
      process.env.YAN_SUBAGENT_WORKTREE_KEEP_DAYS = '30'
      ok((await pruner.pruneIdleWorktrees({ now: later })).length === 0 && existsSync(oldTree), 'YAN_SUBAGENT_WORKTREE_KEEP_DAYS 调大后 8 天不清理')
      delete process.env.YAN_SUBAGENT_WORKTREE_KEEP_DAYS
      pruner.resuming.set(startedOld.run.id, { cancelled: false })
      ok(!(await pruner.pruneIdleWorktrees({ now: later })).includes(startedOld.run.id) && existsSync(oldTree), '正在续接的不清理')
      pruner.resuming.delete(startedOld.run.id)
      const keptForLink = await pruner.pruneIdleWorktrees({ now: later })
      ok(!keptForLink.includes(startedOld.run.id) && existsSync(oldTree) && existsSync(join(targets, 'shared', 'keep.txt')), '工作树里有未忽略的联接时宁可保留，不自动清理', JSON.stringify(keptForLink))
      ok((pruner.get(startedOld.run.id).error ?? '').includes('联接') && pruner.get(startedOld.run.id).review === 'pending', '保留原因写进记录，状态仍是待处置', pruner.get(startedOld.run.id).error)
      const exitPatch = pruner.get(startedOld.run.id).diff.patchPath
      const exitPatchText = await readFile(exitPatch, 'utf8')
      rmdirSync(join(oldTree, 'linked', 'shared'))
      const retired = await pruner.pruneIdleWorktrees({ now: later })
      ok(retired.length === 1 && retired[0] === startedOld.run.id, '默认 7 天：只清理闲置超期且没人在处理的', JSON.stringify(retired))
      ok(!existsSync(oldTree) && existsSync(startedFresh.run.cwd), '超期的工作树已删，未超期的保留')
      ok(existsSync(startedBroken.run.cwd) && pruner.get(startedBroken.run.id).review === 'pending', '补丁存不下来时不删工作树、不改状态')
      const old = pruner.get(startedOld.run.id)
      ok(old.review === 'archived' && !!old.diff?.patchPath && (await readFile(old.diff.patchPath, 'utf8')).includes('old idle change'), '删除前先把改动存成补丁')
      ok(old.diff.patchPath === exitPatch && (await readFile(exitPatch, 'utf8')) === exitPatchText && !readdirSync(archive).some((name) => name.includes('-idle-')), '没续接过：沿用退出时的补丁，不覆盖、不留新补丁')
      ok(!!old.savedOutputsPath && existsSync(join(old.savedOutputsPath, 'reports', 'summary.md')), '删除前先另存被忽略的产物')
      ok(!old.diff.paths.some((p) => p.startsWith('node_modules') || p.startsWith('linked/')), '联接目录（忽略的与未忽略的）都不进补丁', JSON.stringify(old.diff.paths))
      ok(old.diff.skippedLinkCount === 1 && old.diff.skippedLinks?.[0] === 'linked/shared', '补丁摘要记下跳过了 1 个链接', JSON.stringify(old.diff))
      ok(existsSync(join(targets, 'deps', 'pkg', 'index.js')) && existsSync(join(targets, 'shared', 'keep.txt')), '清理不顺着联接删掉目标目录')
      ok(old.resumable?.ok === false, '清理后不再标为可续接')
      const merged = await pruner.merge(startedOld.run.id)
      ok(merged.ok && (await readFile(join(repo, 'a.txt'), 'utf8')) === 'old idle change\n', '清理后仍可从补丁合并', JSON.stringify(merged))
      ok(!existsSync(join(repo, 'linked')), '合并不把联接目标里的文件带进主仓库')
      ok((await pruner.discard(startedFresh.run.id)).ok && !existsSync(startedFresh.run.cwd), '未超期的可照常放弃')
      await rename(join(startedBroken.run.cwd, '.git-moved'), join(startedBroken.run.cwd, '.git'))
    }
  } finally {
    for (const ctrl of controllers) await ctrl.stopAll().catch(() => {})
    for (const tree of trees) await rm(join(tree, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
}, { isolate: true })
