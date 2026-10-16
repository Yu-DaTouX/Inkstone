/**
 * F05/F06/F07 终态竞争回归（纯 Node、隔离；不启动 Electron、不 spawn 真 pi、不花额度）。
 *
 * 现场用 esbuild 编译 `src/main/subagents.ts`，不依赖 `out/` 里的陈旧产物；
 * 注入假 RPC 与可控 prepare，只用临时目录里的真 Git 验证未审阅 worktree 的审阅入口。
 *
 * 覆盖：
 *   F05 清除已结束 × 差异结算：clearFinished 必须等 settling/finalizing 后再核 review，
 *       不隐藏即将 pending 的 worktree，不产生迟到 upsert，stopAll 仍能归档清理。
 *   F06 迟到的超时 steer 失败不能把 done / cancelled 翻成 error，终态单调。
 *   F07 stopAll 必须作废在途 prepare/createRpc 并等待安全收口，之后不得再 spawn；
 *       同时确认 stopAll 不是永久关闭控制器（既有调用契约）。
 *
 * 用法：node scripts/test-subagent-terminal-races.mjs
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'

const execFileAsync = promisify(execFile)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return predicate()
}

let checks = 0
function ok(condition, message) {
  assert.ok(condition, message)
  checks += 1
  console.log(`  ✓ ${message}`)
}

/** 假 pi 客户端：记录创建 / 关闭 / spawn，允许测试手动投递事件。 */
function makeRpcFactory() {
  const created = []
  const createRpc = ({ cwd, args }) => {
    const handlers = new Map()
    const rpc = {
      cwd,
      args,
      running: false,
      closed: false,
      spawned: 0,
      on(event, listener) {
        const list = handlers.get(event) ?? []
        list.push(listener)
        handlers.set(event, list)
        return rpc
      },
      spawn() {
        rpc.spawned += 1
        rpc.running = true
      },
      async command(type) {
        if (type === 'get_state') return { success: true, data: {} }
        if (type === 'prompt') return { success: true }
        return { success: true }
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

/** 不碰文件系统的假工作区（controlled-cwd 走这条）。 */
const fakePrepare = async (rootCwd, id, isolation) => ({ isolation, rootCwd, cwd: rootCwd })

async function compileController() {
  const outDir = await mkdtemp(join(tmpdir(), 'inkstone-subagent-races-'))
  const outfile = join(outDir, 'subagents.mjs')
  await build({
    entryPoints: [join(repoRoot, 'src/main/subagents.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent'
  })
  process.env.YAN_PI_DIR = join(outDir, 'pi-agent')
  process.env.YAN_DATA_DIR = join(outDir, 'yan')
  process.env.YAN_USER_DATA = join(outDir, 'electron')
  const mod = await import(pathToFileURL(outfile).href)
  return { SubagentController: mod.SubagentController, outDir }
}

async function testF05(SubagentController) {
  console.log('F05 清除已结束 × 差异结算')
  const root = await mkdtemp(join(tmpdir(), 'inkstone-f05-repo-'))
  const archive = join(root, 'archives')
  await mkdir(archive, { recursive: true })
  const git = (args) => execFileAsync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' })
  try {
    await git(['init', '-q'])
    await git(['config', 'user.email', 'inkstone-tests@example.invalid'])
    await git(['config', 'user.name', 'Inkstone tests'])
    await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
    await git(['add', 'base.txt'])
    await git(['commit', '-qm', 'base'])

    const factory = makeRpcFactory()
    const pushes = []
    const removed = []
    let releaseClose
    let closeGate = null
    const ctrl = new SubagentController({
      cwd: root,
      archiveDir: archive,
      onChange: (run) => pushes.push(JSON.parse(JSON.stringify(run))),
      onRemove: (id) => removed.push(id),
      createRpc: (opts) => {
        const rpc = factory.createRpc(opts)
        const originalClose = rpc.close.bind(rpc)
        rpc.close = async () => {
          if (closeGate) await closeGate
          return originalClose()
        }
        return rpc
      }
    })

    const started = await ctrl.start('F05 未审阅 worktree', undefined, 'worktree')
    ok(started.ok === true, 'worktree 子代理启动')
    const run = started.run
    const rpc = factory.created[0]
    await writeFile(join(run.cwd, 'new.txt'), 'created\n', 'utf8')

    /* 终态已到、差异还没结算：把收口停在 rpc.close 之前。 */
    closeGate = new Promise((resolve) => { releaseClose = resolve })
    rpc.emit('event', { type: 'agent_settled' })
    ok(ctrl.get(run.id)?.status === 'done', '收到 settled 后终态先落到 done')
    ok(ctrl.get(run.id)?.review === 'none', '差异结算前 review 还是 none')

    let clearedEarly = false
    const clearing = ctrl.clearFinished().then(() => { clearedEarly = true })
    await sleep(200)
    ok(clearedEarly === false, 'clearFinished 等待终态收口，不提前返回')
    ok(ctrl.get(run.id) !== undefined, '等待期间不隐藏记录')
    ok(removed.length === 0, '等待期间不触发 onRemove')

    releaseClose()
    await clearing
    ok(ctrl.get(run.id)?.review === 'pending', '结算后是待审阅，而不是被当成无改动')
    ok(ctrl.get(run.id) !== undefined, '未审阅 worktree 不被清除隐藏')
    ok(existsSync(run.cwd) === true, '未审阅 worktree 仍在磁盘')
    ok(removed.length === 0, '未审阅运行不触发 onRemove')
    const last = pushes.at(-1)
    ok(last?.id === run.id && last.review === 'pending', '最后一次推送就是这条待审阅记录（不是已删 id 的迟到 upsert）')

    await ctrl.stopAll()
    ok(ctrl.get(run.id)?.review === 'archived', 'stopAll 仍能把未审阅 worktree 归档')
    ok(existsSync(run.cwd) === false, 'stopAll 清掉了 worktree')
    ok(typeof ctrl.get(run.id)?.resultPath === 'string' && existsSync(ctrl.get(run.id).resultPath), '归档补丁仍可追溯')

    /* 已清除的无改动运行不再产生迟到 upsert。 */
    const factory2 = makeRpcFactory()
    const pushes2 = []
    const removed2 = []
    const ctrl2 = new SubagentController({
      cwd: 'C:/f05b',
      archiveDir: archive,
      prepare: fakePrepare,
      createRpc: factory2.createRpc,
      onChange: (r) => pushes2.push(r),
      onRemove: (id) => removed2.push(id)
    })
    const first = await ctrl2.start('F05b 无改动', undefined, 'controlled-cwd')
    const rpc2 = factory2.created[0]
    const live2 = ctrl2.runs.get(first.run.id)
    rpc2.emit('event', { type: 'agent_settled' })
    ok(await waitFor(() => live2?.reviewDecided === true), '无改动运行完成差异结算')
    await ctrl2.clearFinished()
    ok(ctrl2.get(first.run.id) === undefined, '已结束的无改动记录被清除')
    const beforeLate = pushes2.length
    rpc2.emit('event', { type: 'tool_execution_start', toolName: 'read' })
    await sleep(30)
    ok(pushes2.length === beforeLate, '已清除运行不再产生迟到 upsert')
    ok(removed2.length === 1, '清除回调只触发一次')
    await ctrl2.stopAll()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function testF06(SubagentController) {
  console.log('F06 迟到 steer 失败 × 终态单调')
  process.env.YAN_SUBAGENT_TIMEOUT_MS = '120'
  process.env.YAN_SUBAGENT_GRACE_MS = '8000'
  const steerBlocked = () => {
    const factory = makeRpcFactory()
    let releaseSteer
    const steerGate = new Promise((resolve) => { releaseSteer = resolve })
    const ctrl = new SubagentController({
      cwd: 'C:/f06',
      prepare: fakePrepare,
      onChange: () => {},
      createRpc: (opts) => {
        const rpc = factory.createRpc(opts)
        const inner = rpc.command.bind(rpc)
        rpc.command = async (type, payload) => {
          if (type === 'steer') {
            await steerGate
            return { success: false, error: 'steer rejected' }
          }
          return inner(type, payload)
        }
        return rpc
      }
    })
    return { factory, ctrl, releaseSteer: () => releaseSteer() }
  }
  try {
    /* 收尾期间模型自己完成：迟到失败不得把 done 翻成 error。 */
    {
      const { factory, ctrl, releaseSteer } = steerBlocked()
      try {
        const started = await ctrl.start('F06 收尾期间完成', undefined, 'controlled-cwd')
        const id = started.run.id
        const rpc = factory.created[0]
        ok(await waitFor(() => ctrl.get(id)?.wrapUp?.reason === 'timeout'), '超时后进入收尾（steer 挂起中）')
        rpc.emit('event', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '结论' }], stopReason: 'stop' } })
        rpc.emit('event', { type: 'agent_settled' })
        ok(ctrl.get(id)?.status === 'done', '收尾期间模型自己完成，终态是 done')
        releaseSteer()
        await sleep(60)
        ok(ctrl.get(id)?.status === 'done', '迟到 steer 失败不把 done 翻成 error')
        ok(ctrl.get(id)?.error === undefined, 'done 不被写上超时错误')
        ok(ctrl.get(id)?.endReason === 'timeout', '结束原因仍是收尾超时（不伪装成正常完成）')
      } finally {
        releaseSteer()
        await ctrl.stopAll()
      }
    }

    /* 收尾期间用户停止：迟到失败不得把 stopped/cancelled 翻成 error。 */
    {
      const { factory, ctrl, releaseSteer } = steerBlocked()
      try {
        const started = await ctrl.start('F06b 收尾期间停止', undefined, 'controlled-cwd')
        const id = started.run.id
        ok(await waitFor(() => ctrl.get(id)?.wrapUp?.reason === 'timeout'), 'F06b：进入收尾')
        ok((await ctrl.stop(id)).ok === true, 'F06b：收尾期间停止成功')
        ok(ctrl.get(id)?.status === 'cancelled', 'F06b：停止后终态是 cancelled')
        releaseSteer()
        await sleep(60)
        ok(ctrl.get(id)?.status === 'cancelled', 'F06b：迟到 steer 失败不把 cancelled 翻成 error')
        ok(ctrl.get(id)?.endReason === 'stopped' && ctrl.get(id)?.error === undefined, 'F06b：保持停止语义')
      } finally {
        releaseSteer()
        await ctrl.stopAll()
      }
    }
    // fail 已开始等 close，但权威 settled 先到：close 返回后也不能翻回 error。
    {
      const factory = makeRpcFactory()
      const ctrl = new SubagentController({ cwd: 'C:/f06-close', prepare: fakePrepare, createRpc: factory.createRpc, onChange: () => {} })
      const started = await ctrl.start('close 等待期间模型已完成', undefined, 'controlled-cwd')
      const rpc = factory.created[0]
      const run = ctrl.runs.get(started.run.id)
      let releaseClose
      const closeGate = new Promise(resolve => { releaseClose = resolve })
      rpc.close = async () => { await closeGate; rpc.running = false }
      try {
        const failing = ctrl.fail(run.id, '迟到的控制失败')
        rpc.emit('event', { type: 'agent_settled' })
        ok(run.status === 'done', 'close 挂起期间收到权威完成')
        releaseClose()
        await failing
        await run.settling
        ok(run.status === 'done', 'close 返回后不把权威 done 翻回 error')
        ok(run.error === undefined && run.endReason === 'completed', '保留权威完成原因，不写入迟到控制错误')
      } finally {
        releaseClose()
        await ctrl.stopAll()
      }
    }
  } finally {
    delete process.env.YAN_SUBAGENT_TIMEOUT_MS
    delete process.env.YAN_SUBAGENT_GRACE_MS
  }
}

async function testF07(SubagentController) {
  console.log('F07 stopAll × 在途 prepare/createRpc')
  /* prepare 屏障：prepare 返回后不得登记或 spawn。 */
  {
    const factory = makeRpcFactory()
    let releasePrepare
    const prepareGate = new Promise((resolve) => { releasePrepare = resolve })
    const container = await mkdtemp(join(tmpdir(), 'inkstone-f07-prep-'))
    const worktree = join(container, 'worktree')
    await mkdir(worktree, { recursive: true })
    await writeFile(join(worktree, 'marker.txt'), 'x', 'utf8')
    const ctrl = new SubagentController({
      cwd: 'C:/f07',
      archiveDir: join(container, 'archives'),
      onChange: () => {},
      createRpc: factory.createRpc,
      prepare: async (rootCwd, id, isolation) => {
        await prepareGate
        return { isolation: 'worktree', rootCwd, cwd: worktree, repoRoot: container, worktreePath: worktree, containerPath: container }
      }
    })
    try {
      const pending = ctrl.start('F07 prepare 屏障', undefined, 'worktree')
      const stopping = ctrl.stopAll()
      let secondReturned = false
      const secondStop = ctrl.stopAll().then(() => { secondReturned = true })
      const duringStop = await ctrl.start('清理期间不得新派发', undefined, 'controlled-cwd')
      ok(duringStop.ok === false && duringStop.error.includes('停止清理'), '清理期间拒绝新启动')
      ok(secondReturned === false, '并发 stopAll 也等待在途 prepare 清理')
      releasePrepare()
      const [started] = await Promise.all([pending, stopping, secondStop])
      ok(started.ok === false, 'prepare 期间 stopAll：启动被作废')
      ok(factory.created.length === 0, '作废启动不创建 RPC，也不 spawn')
      ok(existsSync(container) === false, '作废启动收回刚准备的工作区')
      ok(ctrl.runningCount === 0, '在途启动收口后不占并发槽')
    } finally {
      releasePrepare()
      await ctrl.stopAll()
      await rm(container, { recursive: true, force: true })
    }
  }

  /* createRpc 屏障：返回后关掉客户端并清工作区，绝不 spawn。 */
  {
    const factory = makeRpcFactory()
    let releaseRpc
    const rpcGate = new Promise((resolve) => { releaseRpc = resolve })
    const spawns = []
    let creating = false
    let created = null
    const ctrl = new SubagentController({
      cwd: 'C:/f07b',
      prepare: fakePrepare,
      onChange: () => {},
      createRpc: async (opts) => {
        creating = true
        await rpcGate
        created = factory.createRpc(opts)
        const spawn = created.spawn.bind(created)
        created.spawn = () => { spawns.push(1); spawn() }
        return created
      }
    })
    try {
      const pending = ctrl.start('F07 createRpc 屏障', undefined, 'controlled-cwd')
      ok(await waitFor(() => creating), '进入 createRpc 阶段')
      const stopping = ctrl.stopAll()
      const duringStop = await ctrl.start('RPC 清理期间不得新派发', undefined, 'controlled-cwd')
      ok(duringStop.ok === false, '等待 RPC 清理期间拒绝新启动')
      releaseRpc()
      const [started] = await Promise.all([pending, stopping])
      ok(started.ok === false, 'createRpc 期间 stopAll：启动被作废')
      ok(created?.closed === true, '作废启动收掉刚创建的 RPC 客户端')
      ok(spawns.length === 0, 'stopAll 之后绝不 spawn')
      ok(ctrl.runningCount === 0, '在途启动收口后不占并发槽')
    } finally {
      releaseRpc()
      await ctrl.stopAll()
    }
  }

  /* stopAll 不是永久关闭：既有调用方（doStartAgent / 用户“全部停止”）仍复用同一实例。 */
  {
    const factory = makeRpcFactory()
    const ctrl = new SubagentController({ cwd: 'C:/f07c', prepare: fakePrepare, createRpc: factory.createRpc, onChange: () => {} })
    await ctrl.stopAll()
    const after = await ctrl.start('stopAll 之后仍可派发', undefined, 'controlled-cwd')
    ok(after.ok === true, 'stopAll 不永久关闭控制器，之后仍可派发')
    ok(factory.created[0].spawned === 1, '新代次的启动正常 spawn 一次')
    await ctrl.stopAll()
  }
}

const { SubagentController, outDir } = await compileController()
try {
  await testF05(SubagentController)
  await testF06(SubagentController)
  await testF07(SubagentController)
  console.log(`subagent-terminal-races: ${checks} assertions passed（现场编译、假 RPC、临时目录真 Git、不调用模型）`)
} finally {
  await rm(outDir, { recursive: true, force: true })
}
