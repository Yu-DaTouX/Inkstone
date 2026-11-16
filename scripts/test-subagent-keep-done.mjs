import './lib/test-isolate.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises'
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
  await writeFile(join(repo, '.gitignore'), 'reports/\n.tmp/\n')
  await writeFile(join(repo, 'a.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'base')
  return repo
}

async function bigOutput(tree) {
  await mkdir(join(tree, '.tmp', 'shots'), { recursive: true })
  await writeFile(join(tree, '.tmp', 'shots', 'shot.png'), 'png')
  await writeFile(join(tree, '.tmp', 'run.bin'), '')
  await truncate(join(tree, '.tmp', 'run.bin'), 201 * 1024 * 1024)
}

const listFiles = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true }).map((f) => String(f).replace(/\\/g, '/')).sort() : []

await runSuite(import.meta.url, async (ok, compile) => {
  const { SubagentController } = await compile('src/main/subagents.ts')
  const { preserveIgnoredOutputs } = await compile('src/main/subagent-isolation.ts')
  const base = await mkdtemp(join(tmpdir(), 'inkstone-keep-done-'))
  const controllers = []
  const trees = []
  const make = (cwd, archive, factory, changes) => {
    const ctrl = new SubagentController({ cwd, archiveDir: archive, createRpc: factory.createRpc, onChange: (run) => changes?.push(run), onFinished: () => {} })
    ctrl.waitTranscriptQuiet = async () => {}
    controllers.push(ctrl)
    return ctrl
  }
  const startDone = async (ctrl, factory, repo, task, over = {}) => {
    const started = await ctrl.start(task, undefined, 'worktree', undefined, undefined, { cwd: repo, parentSessionId: 'parent-d', ...over })
    if (started.ok) {
      trees.push(started.run.cwd)
      const dir = join(ctrl.opts.archiveDir, 'sessions', started.run.id)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'native.jsonl'), '{}\n')
    }
    return started
  }
  const finish = async (ctrl, factory, id) => {
    factory.created.at(-1).emit('event', { type: 'agent_settled' })
    return waitFor(() => ctrl.get(id)?.status === 'done' && ctrl.get(id)?.review === 'pending')
  }
  const blockMove = async (archive, id) => mkdir(join(archive, `${id}-outputs`, '.tmp', 'run.bin', 'blocker'), { recursive: true })
  const unblockMove = async (archive, id) => rm(join(archive, `${id}-outputs`, '.tmp', 'run.bin'), { recursive: true, force: true })
  const gateSave = (ctrl) => {
    const original = ctrl.history.save.bind(ctrl.history)
    let release = () => {}
    let hit = () => {}
    const gate = new Promise((resolve) => { release = resolve })
    const reached = new Promise((resolve) => { hit = resolve })
    let held = false
    ctrl.history.save = async (run, ...rest) => {
      if (!held && run.savedOutputsPath) {
        held = true
        hit()
        await gate
      }
      return original(run, ...rest)
    }
    return { reached, release: () => { ctrl.history.save = original; release() } }
  }
  const ageOutputs = async (tree, days) => {
    const at = new Date(Date.now() - days * DAY)
    for (const file of ['run.bin', 'shots/shot.png']) await utimes(join(tree, '.tmp', file), at, at)
  }
  const prepared = async (name, task, over) => {
    const repo = await newRepo(base, `repo-${name}`)
    const archive = join(base, `archive-${name}`)
    const first = rpcFactory()
    const ctrl = make(repo, archive, first)
    const started = await startDone(ctrl, first, repo, task, over)
    const id = started.run.id
    const tree = started.run.cwd
    await writeFile(join(tree, 'a.txt'), `${name} change\n`)
    await bigOutput(tree)
    return { repo, archive, first, ctrl, started, id, tree }
  }
  try {
    {
      const { repo, archive, first, ctrl, started, id, tree } = await prepared('done', '改 a.txt，截图放 .tmp')
      ok(started.ok, 'worktree 子代理启动', started.error ?? '')
      ok(await finish(ctrl, first, id), '子代理正常结束，改动待合并')

      await ctrl.stopAll()
      const exited = ctrl.get(id)
      ok(exited.status === 'done' && exited.review === 'pending' && existsSync(join(tree, '.tmp', 'run.bin')), '应用退出：已结束、未合并的工作树原样保留，超限产物不动', JSON.stringify({ status: exited.status, review: exited.review }))
      ok(exited.resumable?.ok === true, '退出后仍标明可续接', JSON.stringify(exited.resumable))
      const saved = JSON.parse(await readFile(join(archive, `${id}.json`), 'utf8'))
      ok(saved.review === 'pending' && saved.resume?.workspace?.worktreePath === tree, '落盘记录仍是待处置并带原工作树', JSON.stringify({ review: saved.review }))
      ok(!existsSync(join(archive, `${id}-outputs`, '.tmp', 'run.bin')), '退出备份不搬、不超另存上限')

      const second = rpcFactory()
      const reopened = make(repo, archive, second)
      await reopened.loadHistory()
      await sleep(100)
      const loaded = reopened.get(id)
      ok(loaded.review === 'pending' && loaded.resumable?.ok === true && existsSync(tree), '重启后仍待处置、可续接，工作树还在', JSON.stringify(loaded.resumable))
      const resumed = await reopened.send(id, '接着做', 'steer', { parentSessionId: 'parent-d', from: 'parent' })
      ok(resumed.ok && resumed.delivery === 'resumed' && second.created[0]?.cwd === tree, '重启后 send 在原工作树续派', JSON.stringify(resumed))
      await writeFile(join(tree, 'b.txt'), 'after resume\n')
      ok(await finish(reopened, second, id), '续派结束后照常待合并')

      const merged = await reopened.merge(id)
      ok(merged.ok && !merged.warning && !existsSync(tree), '合并时产物超限：超出部分整体搬走，照常合并并清理工作树', JSON.stringify({ ok: merged.ok, warning: merged.warning, error: merged.error }))
      ok((await readFile(join(repo, 'a.txt'), 'utf8')) === 'done change\n' && existsSync(join(repo, 'b.txt')), '补丁已应用到主工作目录')
      const outputs = join(archive, `${id}-outputs`)
      ok((await stat(join(outputs, '.tmp', 'run.bin'))).size === 201 * 1024 * 1024 && listFiles(outputs).includes('.tmp/shots/shot.png'), '超限大文件搬到另存目录（不受 200MB 限制），图片照常另存')
      ok(merged.outputs?.moved?.includes('.tmp/') || merged.outputs?.moved?.includes('.tmp'), '回执写明搬走了哪些', JSON.stringify(merged.outputs))
      ok(/整体搬到另存目录/.test(reopened.get(id).error ?? '') && !/已随工作区清理/.test(reopened.get(id).error ?? ''), '记录写明搬走了哪些', reopened.get(id).error)
    }

    {
      const { repo, archive, first, ctrl, id, tree } = await prepared('blocked', '搬不走时的合并与放弃')
      ok(await finish(ctrl, first, id), '结束待合并')
      await ctrl.stopAll()
      await blockMove(archive, id)
      const changes = []
      const reopened = make(repo, archive, rpcFactory(), changes)
      await reopened.loadHistory()
      await sleep(100)
      const discarded = await reopened.discard(id)
      ok(!discarded.ok && /改动仍未放弃/.test(discarded.error ?? '') && /--drop-outputs/.test(discarded.error ?? '') && /MB/.test(discarded.error ?? ''), '搬不走时放弃：保留工作树，回报没另存的路径与大小和确认参数', discarded.error)
      ok(existsSync(join(tree, '.tmp', 'run.bin')) && reopened.get(id).review === 'pending' && reopened.get(id).resumable?.ok === true, '放弃没成功：仍待处置、可续接')
      const merged = await reopened.merge(id)
      ok(merged.ok && /补丁已合并/.test(merged.warning ?? '') && existsSync(join(tree, '.tmp', 'run.bin')), '搬不走时合并：返回成功并附警告，工作树保留', JSON.stringify(merged))
      ok((await readFile(join(repo, 'a.txt'), 'utf8')) === 'blocked change\n' && reopened.get(id).review === 'merged', '历史合并已应用并记为已合并')
      const last = changes.filter((run) => run.id === id).at(-1)
      ok(last?.review === 'merged' && last?.resumable?.ok === false, '推给界面的记录带上最新的可续接状态', JSON.stringify(last?.resumable))
      const again = await reopened.merge(id)
      ok(again.ok && /补丁已合并/.test(again.warning ?? '') && (await readFile(join(repo, 'a.txt'), 'utf8')) === 'blocked change\n', '再合并只重试清理，不重复应用补丁', JSON.stringify(again))
      const notes = (reopened.get(id).error ?? '').split('\n').filter((line) => /没能整体搬到另存目录/.test(line))
      ok(notes.length === 1, '同一说明只记一次', reopened.get(id).error)

      const stillBlocked = await reopened.discard(id)
      ok(!stillBlocked.ok && reopened.get(id).review === 'merged' && existsSync(tree), '合并后又放弃（产物搬不走）：不清理，状态仍是已合并', stillBlocked.error)
      const dropped = await reopened.discard(id, { dropOutputs: true })
      ok(dropped.ok && /早已合并/.test(dropped.warning ?? '') && !existsSync(tree), '合并后又放弃并确认丢弃：只清理工作树', JSON.stringify(dropped))
      ok(reopened.get(id).review === 'merged' && /按确认丢弃/.test(reopened.get(id).error ?? ''), '状态仍是已合并，记录写明丢弃了什么', JSON.stringify({ review: reopened.get(id).review, error: reopened.get(id).error }))
      ok(!/工作树已保留，没有删除|没能搬到另存目录|没能整体搬到另存目录/.test(reopened.get(id).error ?? ''), '确认丢弃并清理后，记录里不再写「工作树已保留」', reopened.get(id).error)
      const noop = await reopened.discard(id)
      ok(noop.ok && reopened.get(id).review === 'merged', '已合并、工作树已清理时再放弃不改状态', JSON.stringify(noop))
    }

    {
      const { archive, first, ctrl, id, tree } = await prepared('live', '同一次运行里放弃')
      ok(await finish(ctrl, first, id), '结束待合并')
      await blockMove(archive, id)
      const discarded = await ctrl.discard(id)
      ok(!discarded.ok && /--drop-outputs/.test(discarded.error ?? '') && existsSync(join(tree, '.tmp', 'run.bin')) && ctrl.get(id).review === 'pending', '放弃时搬不走：工作树保留、改动不放弃', discarded.error)
      const dropped = await ctrl.discard(id, { dropOutputs: true })
      ok(dropped.ok && !existsSync(tree) && ctrl.get(id).review === 'discarded' && /按确认丢弃/.test(ctrl.get(id).error ?? ''), '确认丢弃后照常放弃并清理', JSON.stringify({ dropped, error: ctrl.get(id).error }))
      ok(!/工作树已保留，没有删除|没能搬到另存目录|没能整体搬到另存目录/.test(ctrl.get(id).error ?? ''), '同一次运行里确认丢弃后，保留说明也去掉', ctrl.get(id).error)
    }

    {
      const { repo, ctrl, first, id, tree } = await prepared('merge-discard', '合并后又放弃（产物能搬走）')
      ok(await finish(ctrl, first, id), '结束待合并')
      const merged = await ctrl.merge(id)
      ok(merged.ok && !existsSync(tree) && ctrl.get(id).review === 'merged', '合并并清理')
      const discarded = await ctrl.discard(id)
      ok(discarded.ok && ctrl.get(id).review === 'merged' && (await readFile(join(repo, 'a.txt'), 'utf8')) === 'merge-discard change\n', '合并后再放弃：不改成已放弃', JSON.stringify(discarded))
    }

    {
      const { repo, archive, first, ctrl, id, tree } = await prepared('idle-merged', '合并后保留的工作树闲置清理')
      ok(await finish(ctrl, first, id), '结束待合并')
      await ctrl.stopAll()
      await blockMove(archive, id)
      const reopened = make(repo, archive, rpcFactory())
      await reopened.loadHistory()
      await sleep(100)
      ok((await reopened.merge(id)).ok && existsSync(tree) && reopened.get(id).review === 'merged', '合并成功但工作树保留')
      const keptPrune = await reopened.pruneOutputs({ now: Date.now() + 60 * DAY })
      ok(!keptPrune.includes(id) && existsSync(join(archive, `${id}-outputs`, '.tmp', 'shots', 'shot.png')), '已合并但工作树还在的记录：另存目录不被清理', JSON.stringify(keptPrune))
      const later = Date.now() + 8 * DAY
      ok(!(await reopened.pruneIdleWorktrees({ now: later })).includes(id) && existsSync(tree), '闲置清理时仍搬不走：继续保留')
      await unblockMove(archive, id)
      const retired = await reopened.pruneIdleWorktrees({ now: later })
      ok(retired.includes(id) && !existsSync(tree) && reopened.get(id).review === 'merged', '闲置清理也处理已合并且工作树还在的记录，状态仍是已合并', JSON.stringify(retired))
      ok(!/工作树已保留，没有删除|没能搬到另存目录|没能整体搬到另存目录/.test(reopened.get(id).error ?? '') && /整体搬到另存目录/.test(reopened.get(id).error ?? ''), '闲置清理成功后去掉保留说明，改记搬走了哪些', reopened.get(id).error)
      ok((await stat(join(archive, `${id}-outputs`, '.tmp', 'run.bin'))).size === 201 * 1024 * 1024, '清理前把超限产物搬走')
    }

    {
      const { repo, archive, first, ctrl, id, tree } = await prepared('race-merge', '合并与另存清理交错')
      ok(await finish(ctrl, first, id), '结束待合并')
      await ctrl.stopAll()
      await ageOutputs(tree, 40)
      const reopened = make(repo, archive, rpcFactory())
      await reopened.loadHistory()
      await sleep(100)
      const outputs = join(archive, `${id}-outputs`)
      const gate = gateSave(reopened)
      const merging = reopened.merge(id)
      await gate.reached
      const during = await reopened.pruneOutputs({ now: Date.now() + 60 * DAY })
      ok(!existsSync(tree) && !during.includes(id) && existsSync(join(outputs, '.tmp', 'run.bin')), '合并进行中（工作树已清、记录未落盘）：另存清理不删这个另存目录', JSON.stringify(during))
      gate.release()
      const merged = await merging
      ok(merged.ok && reopened.get(id).review === 'merged', '合并照常完成', JSON.stringify(merged))
      const [again] = await Promise.all([reopened.pruneOutputs(), reopened.merge(id)])
      await sleep(200)
      ok(!again.includes(id) && (await stat(join(outputs, '.tmp', 'run.bin'))).size === 201 * 1024 * 1024 && existsSync(join(outputs, '.tmp', 'shots', 'shot.png')), '刚搬入的产物文件 mtime 是 40 天前，按另存时间计龄不删', JSON.stringify(again))
      const in20 = await reopened.pruneOutputs({ now: Date.now() + 20 * DAY })
      ok(!in20.includes(id) && existsSync(join(outputs, '.tmp', 'run.bin')), '另存后 30 天内不删')
      const in31 = await reopened.pruneOutputs({ now: Date.now() + 31 * DAY })
      ok(in31.includes(id) && !existsSync(outputs) && existsSync(join(archive, `${id}.json`)), '另存满 30 天、不再使用时才删，记录还在', JSON.stringify(in31))
    }

    {
      const { repo, archive, first, ctrl, id, tree } = await prepared('race-idle', '闲置清理与另存清理交错')
      ok(await finish(ctrl, first, id), '结束待合并')
      await ctrl.stopAll()
      await ageOutputs(tree, 40)
      const reopened = make(repo, archive, rpcFactory())
      await reopened.loadHistory()
      await sleep(100)
      const outputs = join(archive, `${id}-outputs`)
      const gate = gateSave(reopened)
      const retiring = reopened.pruneIdleWorktrees({ now: Date.now() + 8 * DAY })
      await gate.reached
      const during = await reopened.pruneOutputs({ now: Date.now() + 60 * DAY })
      ok(!existsSync(tree) && !during.includes(id) && existsSync(join(outputs, '.tmp', 'run.bin')), '闲置清理进行中（retiring）：另存清理不删这个另存目录', JSON.stringify(during))
      gate.release()
      ok((await retiring).includes(id), '闲置清理照常完成')
      await sleep(200)
      const now = await reopened.pruneOutputs()
      ok(!now.includes(id) && (await stat(join(outputs, '.tmp', 'run.bin'))).size === 201 * 1024 * 1024, '闲置清理搬入的旧 mtime 产物不会被随后的另存清理当场删掉', JSON.stringify(now))
      reopened.reviewing.add(id)
      const reviewingPrune = await reopened.pruneOutputs({ now: Date.now() + 60 * DAY })
      reopened.reviewing.delete(id)
      reopened.retiring.add(id)
      const retiringPrune = await reopened.pruneOutputs({ now: Date.now() + 60 * DAY })
      reopened.retiring.delete(id)
      ok(!reviewingPrune.includes(id) && !retiringPrune.includes(id) && existsSync(outputs), 'reviewing、retiring 中的 id 都受保护', JSON.stringify({ reviewingPrune, retiringPrune }))
    }

    {
      const { ctrl, archive, id, tree } = await prepared('workflow', '工作流 agent()', { parentMessageId: 'workflow:wf-0123abcd' })
      await ctrl.stopAll()
      const run = ctrl.get(id)
      ok(!existsSync(tree) && run.review === 'archived' && existsSync(join(archive, `${id}-outputs`, '.tmp', 'run.bin')), '工作流子代理退出归档时产物超限：搬走后照常清理', JSON.stringify({ review: run.review }))
      ok(!!run.diff?.patchPath && existsSync(run.diff.patchPath), '补丁照常存档')
    }

    {
      const { ctrl, archive, id, tree } = await prepared('workflow-blocked', '工作流 agent() 搬不走', { parentMessageId: 'workflow:wf-0badc0de' })
      await blockMove(archive, id)
      await ctrl.stopAll()
      const run = ctrl.get(id)
      ok(existsSync(join(tree, '.tmp', 'run.bin')) && run.review === 'pending', '工作流子代理搬不走时不删工作树，留作待处置', JSON.stringify({ review: run.review }))
    }

    {
      const { tree, id } = await prepared('copy-once', '另存重试')
      const workspace = { isolation: 'worktree', rootCwd: tree, cwd: tree, repoRoot: tree, worktreePath: tree }
      const archive = join(base, 'archive-copy-once')
      const firstSave = await preserveIgnoredOutputs(workspace, archive, id)
      const copied = join(archive, `${id}-outputs`, '.tmp', 'shots', 'shot.png')
      const before = (await stat(copied)).mtimeMs
      await sleep(50)
      const secondSave = await preserveIgnoredOutputs(workspace, archive, id)
      ok(firstSave.ok && secondSave.ok && (await stat(copied)).mtimeMs === before, '重试另存时没有新产物就不再拷贝')
      ok(existsSync(join(tree, '.tmp', 'run.bin')) && secondSave.skipped?.length === 1, '不带搬移选项时（退出备份）不搬超限产物')
      await writeFile(join(tree, '.tmp', 'x1.log'), 'x'.repeat(20))
      await writeFile(join(tree, '.tmp', 'x2.log'), 'y'.repeat(30))
      const halfArchive = join(base, 'archive-half')
      await mkdir(join(halfArchive, `${id}-outputs`, '.tmp', 'run.bin', 'blocker'), { recursive: true })
      const half = await preserveIgnoredOutputs(workspace, halfArchive, id, 3, { moveOverflow: true })
      ok(half.ok && half.skipped?.length === 1 && !half.moved, '搬到一半失败：整体算没搬走', JSON.stringify(half))
      ok(existsSync(join(tree, '.tmp', 'x1.log')) && existsSync(join(tree, '.tmp', 'x2.log')) && existsSync(join(tree, '.tmp', 'run.bin')) && existsSync(join(tree, '.tmp', 'shots', 'shot.png')), '已搬走的文件搬回工作树，工作树完整，续派时找得到')
      ok(!existsSync(join(halfArchive, `${id}-outputs`, '.tmp', 'x1.log')) && !existsSync(join(halfArchive, `${id}-outputs`, '.tmp', 'x2.log')), '另存目录里不留搬了一半的文件')
    }
  } finally {
    for (const ctrl of controllers) await ctrl.stopAll().catch(() => {})
    for (const tree of trees) await rm(join(tree, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
})
