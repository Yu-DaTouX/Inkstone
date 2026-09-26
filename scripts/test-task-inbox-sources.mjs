/**
 * 收件箱事实源组装的单元测试（实施-28 T2）。
 *
 * 这里测的是**组装层**，不是投影层（投影在 test-task-inbox.mjs）：
 *   ① `toRunnerFacts` 只映射真的有的字段（不编 `reason`）；
 *   ② `foldRunners` 同一会话多实例折叠时挑「最需要关注」的那一条；
 *   ③ `readInboxState` / `writeInboxState` 往返，且坏文件不拖垮收件箱；
 *   ④ `createTaskInboxSources` 的默认计划投影：空计划给 undefined（不出卡），
 *      有 blocked 才给 blocked（不编 0）。
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runTaskInboxSourceTests(ok, mod, serviceMod) {
  const { foldRunners, toRunnerFacts, readInboxState, writeInboxState, createTaskInboxSources } = mod
  const { createTaskInboxService } = serviceMod

  /* ---- ① 只映射真的有的字段 ---- */
  {
    ok(toRunnerFacts({}).length === 0, '没有 sessionId 的实例不产出事实（不编一个空会话）')
    const running = toRunnerFacts({ sessionId: 's1', running: true, conn: 'ready' })[0]
    ok(running?.sessionId === 's1' && running.running === true, '在跑的实例映射 running')
    ok(running.reason === undefined, '没失败就不给 reason（不编原因）')
    ok(running.waiting === undefined, '没等待就不给 waiting（留给投影判默认）')
    const failed = toRunnerFacts({ sessionId: 's2', failed: true, conn: 'exited' })[0]
    ok(failed?.failed === true && /退出/.test(failed.reason ?? ''), '失败且进程退出时给出可读原因')
    const connErr = toRunnerFacts({ sessionId: 's3', failed: true, conn: 'error' })[0]
    ok(/连接/.test(connErr.reason ?? ''), '连接失败与进程退出给的原因不同（能分辨）')
  }

  /* ---- ② 多实例折叠 ---- */
  {
    const folded = foldRunners([
      { sessionId: 'a', running: true },
      { sessionId: 'a', failed: true, reason: '进程已退出' },
      { sessionId: 'b', running: true },
      { sessionId: 'c' }
    ])
    ok(folded.length === 3, '同一会话的多个实例折成一条（3 个会话 → 3 条）')
    const a = folded.find((x) => x.sessionId === 'a')
    ok(a?.failed === true && a?.running === true, '折叠保留「任一实例」的失败与在跑（都不丢）')
    ok(a?.reason === '进程已退出', '失败原因取最需要关注的那条实例')
    const b = folded.find((x) => x.sessionId === 'b')
    ok(b?.running === true && b?.failed === undefined, '没失败的会话不被别的会话牵连')
  }

  /* ---- ③ 可见性文件往返 + 坏文件容错 ---- */
  {
    const dir = await mkdtemp(join(tmpdir(), 'yan-inbox-'))
    try {
      ok((await readInboxState(dir)).dismissed.length === 0, '文件不存在时当作没忽略（不抛）')
      await writeInboxState({ dismissed: ['s1', 's2'] }, dir)
      const back = await readInboxState(dir)
      ok(back.dismissed.length === 2 && back.dismissed.includes('s2'), '写入后能读回来')
      await writeFile(join(dir, 'task-inbox.json'), '{ 这不是 json', 'utf8')
      ok((await readInboxState(dir)).dismissed.length === 0, '文件坏了也不拖垮收件箱（返回空名单）')
      await writeFile(join(dir, 'task-inbox.json'), JSON.stringify({ dismissed: ['ok', 42, null] }), 'utf8')
      const filtered = await readInboxState(dir)
      ok(filtered.dismissed.length === 1 && filtered.dismissed[0] === 'ok', '名单里的非字符串被丢掉（不让脏值进投影）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  /* ---- ④ 默认计划投影：空就是空，不编 0 ---- */
  {
    const sources = createTaskInboxSources({
      registry: { statuses: () => [] },
      list: async () => [{ id: 's1', title: '会话一', updatedAt: 10 }],
      dismissed: () => [],
      readPlan: async () => undefined
    })
    const sessions = await sources.listSessions()
    ok(sessions.length === 1 && sessions[0].id === 's1', '会话投影带上 id / 标题 / 时间')
    ok((await sources.readPlan?.('s1')) === undefined, '没有计划时给 undefined（调用方不出“0/0 进度”的卡）')
    ok(sources.runners().length === 0 && sources.dismissed?.().length === 0, '空注册表与空名单都正常返回')
  }

  /* ---- ⑤ 组合：注册表 → 事实 → 卡片（端到端走一遍组装层） ---- */
  {
    const sources = createTaskInboxSources({
      registry: {
        statuses: () => [
          { sessionId: 's1', running: true, conn: 'ready', generation: 1, cwd: '', id: 'r1', runId: 'r1', createdAt: 0, lastActiveAt: 0, isActive: false },
          { sessionId: 's1', failed: true, conn: 'exited', generation: 1, cwd: '', id: 'r2', runId: 'r2', createdAt: 0, lastActiveAt: 0, isActive: false }
        ]
      },
      list: async () => [{ id: 's1', title: '有问题的会话', updatedAt: 5 }],
      dismissed: () => [],
      readPlan: async () => ({ total: 4, done: 1, blocked: 1, current: '等接口' })
    })
    const service = createTaskInboxService(sources)
    const page = await service.page({}, { limit: 10 })
    ok(page.cards.length === 1, '一个会话只出一张卡')
    ok(page.cards[0].status === 'failed', '实例挂了时状态优先报失败（不是“在跑”）')
    ok(page.cards[0].reason === '进程已退出', '卡片带上可读原因')
    ok(String(page.cards[0].progress ?? '').includes('4'), '进度来自计划（第几步 / 共几步）')
  }
}
