import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const work = await mkdtemp(join(tmpdir(), 'inkstone-crash-'))
process.env.YAN_PI_DIR = join(work, 'pi')
process.env.YAN_DATA_DIR = join(work, 'yan')
process.env.YAN_USER_DATA = join(work, 'electron')
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const controllers = []

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()

async function newRepo(name) {
  const repo = join(work, name)
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'a@b.c')
  git(repo, 'config', 'user.name', 'test')
  await writeFile(join(repo, 'a.txt'), 'base\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'init')
  return repo
}

try {
  const output = join(work, 'controller.mjs')
  await build({ entryPoints: ['src/main/subagents.ts'], outfile: output, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { SubagentController } = await import(pathToFileURL(output).href)
  const archive = join(work, 'archives')
  const make = (repo) => {
    const controller = new SubagentController({
      cwd: repo, archiveDir: archive, onChange: () => {}, onFinished: () => {},
      createRpc: () => {
        const rpc = new EventEmitter()
        rpc.running = false
        rpc.spawn = () => { rpc.running = true }
        rpc.close = async () => { rpc.running = false }
        rpc.command = async (command) => ({ success: true, data: command === 'get_state' ? {} : undefined })
        return rpc
      }
    })
    controller.waitTranscriptQuiet = async () => {}
    controllers.push(controller)
    return controller
  }

  for (const legacy of [false, true]) {
    const label = legacy ? '旧记录（没存工作区信息）' : '新记录'
    const repo = await newRepo(legacy ? 'repo-legacy' : 'repo-new')
    const crashed = make(repo)
    const started = await crashed.start('改一个文件', undefined, 'worktree')
    ok(started.ok, `${label}：worktree 子代理启动`)
    const id = started.run.id
    const worktree = started.run.cwd
    await writeFile(join(worktree, 'a.txt'), 'changed by subagent\n')
    await writeFile(join(worktree, 'new.txt'), 'created\n')
    const savedFile = join(archive, `${id}.json`)
    const saved = JSON.parse(await readFile(savedFile, 'utf8'))
    ok(saved.status === 'running' && saved.resume?.workspace?.worktreePath === worktree, `${label}：运行中的记录里带着工作区信息`)
    if (legacy) {
      delete saved.resume.workspace
      await writeFile(savedFile, JSON.stringify(saved))
    }

    const restarted = make(repo)
    await restarted.loadHistory()
    const run = restarted.get(id)
    ok(run.status === 'error' && run.endReason === 'exited', `${label}：重启后标为中断`)
    ok(run.review === 'pending' && run.diff?.files === 2 && existsSync(run.diff.patchPath), `${label}：改动存成补丁，审阅状态可合并`)
    ok(existsSync(worktree), `${label}：工作树保留，可以原地续接`)
    ok(run.resultPath === worktree, `${label}：保留工作树时结果路径指向工作树`)
    ok(/原地续接/.test(run.error ?? ''), `${label}：说明改动怎么处置`)
    ok(run.resumable?.ok === true, `${label}：可续派`, JSON.stringify(run.resumable))

    const merged = await restarted.merge(id)
    ok(merged.ok, `${label}：合并成功`)
    ok((await readFile(join(repo, 'a.txt'), 'utf8')).replace(/\r/g, '') === 'changed by subagent\n', `${label}：补丁应用到主工作目录`)
    ok(existsSync(join(repo, 'new.txt')), `${label}：新文件一并合并`)
    ok(restarted.get(id).review === 'merged', `${label}：状态变为已合并`)
    ok(!existsSync(worktree), `${label}：合并后清理保留的工作树`)
    ok((await restarted.merge(id)).ok, `${label}：重复合并幂等`)
  }

  {
    const repo = await newRepo('repo-mixed')
    await writeFile(join(repo, 'gone.txt'), 'to delete\n')
    await writeFile(join(repo, 'crlf.txt'), 'a\r\nb\r\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'more')
    const crashed = make(repo)
    const started = await crashed.start('混合改动', undefined, 'worktree')
    const worktree = started.run.cwd
    await rm(join(worktree, 'gone.txt'))
    await writeFile(join(worktree, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    await writeFile(join(worktree, 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 7]))
    await mkdir(join(worktree, 'deep', 'dir'), { recursive: true })
    await writeFile(join(worktree, 'deep', 'dir', 'x 空格.txt'), 'nested\n')
    const restarted = make(repo)
    await restarted.loadHistory()
    const run = restarted.get(started.run.id)
    ok(run.review === 'pending' && run.diff?.files === 4, '混合改动：删除、CRLF、二进制、带空格的嵌套新文件都进补丁')
    const merged = await restarted.merge(started.run.id)
    ok(merged.ok, `混合改动：合并成功 ${merged.error ?? ''}`)
    ok(!existsSync(join(repo, 'gone.txt')) && existsSync(join(repo, 'bin.dat')) && (await readFile(join(repo, 'bin.dat'))).length === 7, '混合改动：删除与二进制按原样合并')
    ok((await readFile(join(repo, 'crlf.txt'), 'utf8')) === 'a\r\nb\r\nc\r\n', '混合改动：CRLF 保持')
    ok(existsSync(join(repo, 'deep', 'dir', 'x 空格.txt')), '混合改动：嵌套新文件合并')
  }

  {
    const repo = await newRepo('repo-ignored')
    await writeFile(join(repo, '.gitignore'), 'reports/\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'ignore')
    const crashed = make(repo)
    const started = await crashed.start('只产出被忽略的文件', undefined, 'worktree')
    const worktree = started.run.cwd
    await mkdir(join(worktree, 'reports'), { recursive: true })
    await writeFile(join(worktree, 'reports', 'result.bin'), 'ignored-output')
    const restarted = make(repo)
    await restarted.loadHistory()
    const run = restarted.get(started.run.id)
    ok(run.review === 'pending' && existsSync(worktree), '只有被忽略产物的中断子代理：保留工作树并待审阅')
    ok(run.resultPath === worktree, '保留工作树时结果路径指向工作树')
    const refused = await restarted.merge(started.run.id)
    ok(!refused.ok && existsSync(worktree), '只有被忽略产物没有补丁可合并：拒绝合并并保留工作树')
    const discarded = await restarted.discard(started.run.id)
    ok(discarded.ok && !existsSync(worktree) && restarted.get(started.run.id).review === 'discarded', '放弃后清理保留的工作树')
  }

  {
    const repo = await newRepo('repo-ignored-merge')
    await writeFile(join(repo, '.gitignore'), 'reports/' + String.fromCharCode(10))
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'ignore')
    const crashed = make(repo)
    const started = await crashed.start('改文件并产出被忽略的文件', undefined, 'worktree')
    const worktree = started.run.cwd
    await writeFile(join(worktree, 'a.txt'), 'changed' + String.fromCharCode(10))
    await mkdir(join(worktree, 'reports'), { recursive: true })
    await writeFile(join(worktree, 'reports', 'result.bin'), 'ignored-output')
    const restarted = make(repo)
    await restarted.loadHistory()
    const merged = await restarted.merge(started.run.id)
    const after = restarted.get(started.run.id)
    ok(merged.ok && !existsSync(worktree), '合并后清理保留的工作树')
    ok(!!after.savedOutputsPath && existsSync(join(after.savedOutputsPath, 'reports', 'result.bin')), '清理前把被忽略的产物另存')
  }

  {
    const repo = await newRepo('repo-vanished')
    const crashed = make(repo)
    const started = await crashed.start('工作树被手动删掉', undefined, 'worktree')
    const worktree = started.run.cwd
    await writeFile(join(worktree, 'a.txt'), 'changed\n')
    const restarted = make(repo)
    await restarted.loadHistory()
    ok(existsSync(worktree) && restarted.get(started.run.id).resumable?.ok === true, '工作树在时可续派')
    git(repo, 'worktree', 'remove', '--force', worktree)
    const again = make(repo)
    await again.loadHistory()
    const run = again.get(started.run.id)
    ok(!existsSync(worktree) && run.resumable?.ok !== true, '工作树已被删除：不再提示可原地续接')
  }

  {
    const repo = await newRepo('repo-discard')
    const crashed = make(repo)
    const started = await crashed.start('只读文件', undefined, 'worktree')
    const worktree = started.run.cwd
    const restarted = make(repo)
    await restarted.loadHistory()
    const run = restarted.get(started.run.id)
    ok(run.status === 'error' && run.review === 'none' && !existsSync(worktree), '没有改动的中断子代理：清理工作树，不留待审阅状态')
  }

  {
    const repo = await newRepo('repo-resume')
    const crashed = make(repo)
    const started = await crashed.start('改一个文件', undefined, 'worktree')
    const id = started.run.id
    const worktree = started.run.cwd
    await writeFile(join(worktree, 'a.txt'), 'before crash\n')
    await mkdir(join(archive, 'sessions', id), { recursive: true })
    await writeFile(join(archive, 'sessions', id, 'a.jsonl'), '{}\n')
    const restarted = make(repo)
    await restarted.loadHistory()
    const resumed = await restarted.send(id, '接着改', 'steer', { parentSessionId: undefined, from: 'parent' })
    ok(resumed.ok && resumed.delivery === 'resumed', '原地续接：崩溃子代理在原工作树继续')
    const live = restarted.runs.get(id)
    ok(live?.workspace.cwd === worktree && existsSync(worktree), '原地续接：仍在原工作树')
    await writeFile(join(worktree, 'b.txt'), 'after resume\n')
    live.rpc.emit('event', { type: 'agent_settled' })
    await live.settling
    const after = restarted.get(id)
    ok(after.review === 'pending' && after.diff?.files === 2, '原地续接：结束后的改动含崩溃前与续接后两部分', JSON.stringify(after.diff))
    ok((await restarted.discard(id)).ok && !existsSync(worktree), '原地续接：放弃后清理工作树')
  }

  {
    const repo = await newRepo('repo-exclusive')
    const ctrl = make(repo)
    const started = await ctrl.start('隔离', undefined, 'worktree')
    const id = started.run.id
    const run = ctrl.runs.get(id)
    await writeFile(join(run.workspace.cwd, 'b.txt'), 'x\n')
    run.rpc.emit('event', { type: 'agent_settled' })
    await run.settling
    ok(ctrl.get(id).review === 'pending', '互斥：待审阅的 worktree 子代理')

    ctrl.resuming.set(id, { cancelled: false })
    const blockedMerge = await ctrl.merge(id)
    const blockedDiscard = await ctrl.discard(id)
    ok(!blockedMerge.ok && /续接/.test(blockedMerge.error), '互斥：续接期间不能合并')
    ok(!blockedDiscard.ok && /续接/.test(blockedDiscard.error), '互斥：续接期间不能放弃')
    ok(ctrl.get(id).review === 'pending' && existsSync(run.workspace.cwd), '互斥：被拒绝的合并/放弃不动工作树')
    ctrl.resuming.delete(id)

    let release
    const hold = new Promise((resolve) => { release = resolve })
    const merging = ctrl.exclusiveReview(id, async () => { await hold; return { ok: true } })
    const resumed = await ctrl.send(id, '继续', 'steer', { parentSessionId: undefined, from: 'parent' })
    ok(!resumed.ok && /合并或放弃/.test(resumed.error), '互斥：合并/放弃进行时不能续接')
    const second = await ctrl.discard(id)
    ok(!second.ok && /正在合并或放弃/.test(second.error), '互斥：合并/放弃不能并发')
    release()
    await merging
    ok(!ctrl.reviewing.has(id), '互斥：结束后释放')
    ok((await ctrl.discard(id)).ok && ctrl.get(id).review === 'discarded', '互斥：释放后可以正常放弃')
  }

  console.log(`Subagent crash recovery: ${checks} passed`)
} finally {
  for (const controller of controllers) await controller.stopAll().catch(() => {})
  await rm(work, { recursive: true, force: true }).catch(() => {})
}
