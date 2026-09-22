/**
 * 续行薄层（`resources/pi-extensions/goal-resume.js`）的行为测试。
 *
 * 这里验的是**时序**，不是「能不能发消息」：
 * 宿主的 arm 链挂在 `state`（`isAgentRunning === false`）上，也就是
 * `agent_settled` **之后**；而薄层原来的检查点只有 `message_end`（更早）。
 * 读空就 return 的后果是**死锁** —— 不会再有第二个 `message_end`，
 * 刚写好的 resume 没人看，用户看到的是「会话不动了」（2026-09-22 真实报障）。
 *
 * 所以核心用例就是「resume 文件比检查点晚到」：断言窗口把它接住、
 * 而且只发一次（消费幂等）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runGoalResumeExtTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'yan-goalresume-'))
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'r1'
  /* 收窄时间参数：单测不必真等 1.8s + 9.6s（默认值由 live 场景覆盖） */
  process.env.YAN_GOAL_RESUME_DELAY_MS = '80'
  process.env.YAN_GOAL_RESUME_POLL_TRIES = '5'
  process.env.YAN_GOAL_RESUME_POLL_MS = '200'
  const logFile = join(root, 'ext.jsonl')
  process.env.YAN_GOAL_RESUME_EXT_LOG = logFile

  const resumeDir = join(root, 'goal-resume')
  const resumeFile = join(resumeDir, 'r1.json')
  const consumedFile = join(resumeDir, 'r1.consumed.json')

  const writeResume = async (operationId, kind = 'continue') => {
    await mkdir(resumeDir, { recursive: true })
    await writeFile(
      resumeFile,
      JSON.stringify({ operationId, summary: `接着干（${operationId}）`, kind }),
      'utf8'
    )
  }
  const readConsumed = async () => {
    try {
      return JSON.parse(await readFile(consumedFile, 'utf8'))
    } catch {
      return null
    }
  }
  const readLog = async () => {
    try {
      return (await readFile(logFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const waitFor = async (probe, limitMs = 8_000) => {
    const until = Date.now() + limitMs
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() > until) return null
      await sleep(50)
    }
  }

  try {
    const mod = await import(new URL('../resources/pi-extensions/goal-resume.js', import.meta.url))
    const factory = mod.default
    ok(typeof factory === 'function', 'goal-resume.js 默认导出扩展工厂函数')

    const handlers = {}
    const sent = []
    factory({
      on: (evt, handler) => {
        handlers[evt] = handler
      },
      /* 薄层不许注册模型工具 / 命令（01 §1 的架构检查） */
      registerTool: () => {
        throw new Error('goal-resume.js 不应注册模型工具')
      },
      registerCommand: () => {
        throw new Error('goal-resume.js 不应注册命令')
      }
    })
    ok(typeof handlers.message_end === 'function', 'goal-resume.js 挂在 message_end 上')
    ok(typeof handlers.agent_settled === 'function', 'goal-resume.js 也挂在 agent_settled 上（更晚的检查点）')
    ok(typeof handlers.session_start === 'function', 'goal-resume.js 挂在 session_start 上（重载 / 切会话）')

    const ctx = {
      appendEntry: () => {},
      sendMessage: async (message, options) => {
        sent.push({ message, options })
      }
    }
    /* 这条形状就是「回合可能结束」：assistant 且没有工具调用 */
    const turnEnd = { message: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } }
    const textOf = (entry) => entry.message.content.map((part) => part.text ?? '').join('')

    /* ── 1. resume 比检查点晚到：窗口必须接住（宿主 arm 慢） ─────────── */
    handlers.message_end(turnEnd, ctx)
    await sleep(400)
    ok(sent.length === 0, 'resume 还没写下来时不会凭空发消息')
    await writeResume('op-late')
    const lateSent = await waitFor(async () => (sent.length > 0 ? sent : null))
    ok(!!lateSent, 'resume 晚到 400ms 也能被消费（窗口接住了它）')
    ok(textOf(lateSent[0]).includes('op-late'), '发出去的正文来自那份 resume')
    ok(lateSent[0].message.customType === 'yan-goal-continue', '续行类型是 yan-goal-continue')
    ok(lateSent[0].options?.triggerTurn === true, '续行带 triggerTurn（真的起一个回合）')
    ok((await readConsumed())?.operationId === 'op-late', '先把 operationId 写成消费证据')

    /* ── 2. agent_settled 是第二个检查点（不依赖 message_end） ───────── */
    await writeResume('op-settled')
    handlers.agent_settled({}, ctx)
    const settledSent = await waitFor(async () => (sent.some((entry) => textOf(entry).includes('op-settled')) ? sent : null))
    ok(!!settledSent, '只发 agent_settled（没有 message_end）也能消费续行')
    ok(sent.length === 2, '每个 operationId 只发一次（实际 ' + sent.length + ' 次发送）')

    /* ── 3. 消费幂等：同一个 operationId 不重发 ─────────────────────── */
    handlers.agent_settled({}, ctx)
    await sleep(1_200)
    ok(sent.length === 2, '已消费过的续行不再重发（宁可少发，不能重复执行）')

    /* ── 4. 用户消息优先：二次确认延迟之内说话 → 让位 ─────────────── */
    await writeResume('op-user')
    /*
     * ⚠️ 两点都不能少：
     *   · 先推一次 activity（`message_end` 有「同一条消息只 schedule 一次」的去重，
     *     不推的话这次根本不会安排检查点）；
     *   · 让位必须发生在**二次确认延迟之内**（这里是 80ms 的 30ms 处）——
     *     过了那一会儿再说话就已经发过了，那是正确行为，不是让位。
     */
    handlers.before_agent_start({})
    handlers.message_end(turnEnd, ctx)
    await sleep(30)
    handlers.before_agent_start({})
    await sleep(600)
    ok(sent.length === 2, '二次确认期间用户说了话 → 不发续行（resume 留着等下一次空闲）')
    const activityLog = (await readLog()).filter((line) => line.hook === 'resume_skipped' && line.reason === 'activity')
    ok(activityLog.length >= 1, '让位这件事留下了诊断行（resume_skipped/activity）')

    /* ── 4b. 让位的那份 resume 会在下一次检查点重试 ─────────────────── */
    handlers.agent_settled({}, ctx)
    const retried = await waitFor(async () => (sent.some((entry) => textOf(entry).includes('op-user')) ? sent : null))
    ok(!!retried, '让位的那份 resume 留着，下一次空闲（agent_settled）把它消费掉（“宁可晚一次，不盲发”）')

    /* ── 4c. 窗口**轮询期间**用户说话 → 也让位 ─────────────────────── */
    await rm(resumeFile, { force: true })
    handlers.before_agent_start({})
    handlers.message_end(turnEnd, ctx)
    /* 第一个窗口（80ms）落空 → 进入轮询，这时才有“窗口里让位”这回事 */
    await sleep(150)
    await writeResume('op-late-user')
    handlers.before_agent_start({})
    await sleep(700)
    ok(
      !sent.some((entry) => textOf(entry).includes('op-late-user')),
      '窗口轮询期间用户说话也让位（不会“反正等到了就发”）'
    )

    /* ── 5. 真正没有续行时：窗口走完什么都不做 ───────────────────── */
    const sentBefore5 = sent.length
    await rm(resumeFile, { force: true })
    handlers.agent_settled({}, ctx)
    const emptyCheck = await waitFor(async () => {
      const log = await readLog()
      return log.filter((line) => line.hook === 'check' && line.hasResume === false).at(-1) ?? null
    })
    ok(!!emptyCheck, '没有续行时也会留一行 check（排障时能区分「没 arm」与「没读到」）')
    ok(sent.length === sentBefore5, '没有续行时不发消息')

    /*
     * ── 5b. A5（实施-14）：旧记录已消费时，窗口里写入的新指令必须被接住 ──
     *
     * 现场：宿主把新 operationId 写进同一个文件往往晚几十到几百毫秒（它的 arm
     * 挂在 `state` 推送之后）。旧实现读到「已消费的那条」就 return ——
     * 不会再有第二个 `message_end`，新指令就此丢掉。
     */
    const sentBefore5b = sent.length
    await rm(resumeFile, { force: true })
    await writeResume('op-old-consumed')
    await writeFile(
      consumedFile,
      JSON.stringify({ operationId: 'op-old-consumed', at: new Date().toISOString() }),
      'utf8'
    )
    handlers.agent_settled({}, ctx)
    /* 写在两次轮询之间（首次读 → 200ms 轮询窗口） */
    await sleep(100)
    await writeResume('op-new-after-consumed')
    const afterConsumed = await waitFor(async () =>
      sent.some((entry) => textOf(entry).includes('op-new-after-consumed')) ? sent : null
    )
    ok(!!afterConsumed, 'A5：已消费的旧记录不会让窗口提前退出，新指令仍被消费')
    ok(
      sent.length === sentBefore5b + 1,
      'A5：新指令只发一次（实际 ' + (sent.length - sentBefore5b) + ' 次）'
    )
    ok((await readConsumed())?.operationId === 'op-new-after-consumed', 'A5：消费证据推进到新指令')

    /*
     * ── 6. 发送一律走 `pi`（2026-09-22 的根因） ──
     *
     * pi 0.85.1 的钩子 ctx 里**没有** `sendMessage`（`createContext()` 只给 cwd / model /
     * modelRegistry 等 getter）。旧代码写的是 `context.sendMessage?.()` —— 可选链把失败吞了：
     * 日志里写着 `resume_sent`、`operationId` 也记成已消费，而消息从未发出去。
     */
    const piSent = []
    const handlers2 = {}
    factory({
      on: (evt, handler) => {
        handlers2[evt] = handler
      },
      sendMessage: async (message, options) => {
        piSent.push({ message, options })
      }
    })
    await rm(resumeFile, { force: true })
    await rm(consumedFile, { force: true })
    const ctx2 = {} /* 没有 sendMessage（pi 0.85.1 的真实形态） */
    await writeResume('op-pi')
    handlers2.message_end(turnEnd, ctx2)
    const viaPi = await waitFor(async () => (piSent.length > 0 ? piSent : null))
    ok(!!viaPi, 'ctx 没有 sendMessage 时走 pi（真实环境的主通道）')
    ok(textOf(viaPi[0]).includes('op-pi'), '发出去的是 pi 通道里那条')
    ok((await readConsumed())?.operationId === 'op-pi', '走 pi 时消费证据照写')

    /* 重载 / 切会话后 pi 会 stale：新 ctx 带 sendMessage 时要用新的（既有护栏） */
    const ctxSent = []
    await rm(resumeFile, { force: true })
    await rm(consumedFile, { force: true })
    await writeResume('op-fresh')
    handlers2.message_end(turnEnd, { sendMessage: async (message, options) => ctxSent.push({ message, options }) })
    const viaCtx = await waitFor(async () => (ctxSent.length > 0 ? ctxSent : null))
    ok(!!viaCtx, '新 ctx 带 sendMessage 时换成它（pi 在重载后可能 stale）')
    ok(textOf(viaCtx[0]).includes('op-fresh'), '改走 ctx 后发的是当前那份续行')

    /* ── 7. 两个地方都没有 sendMessage：明确失败且不写消费证据 ───────── */
    const handlers3 = {}
    factory({
      on: (evt, handler) => {
        handlers3[evt] = handler
      }
    })
    await rm(resumeFile, { force: true })
    await rm(consumedFile, { force: true })
    await writeResume('op-nosender')
    handlers3.message_end(turnEnd, {})
    const noSender = await waitFor(async () => {
      const log = await readLog()
      return log.some((line) => line.hook === 'resume_failed' && line.reason === 'no-sendMessage') ? true : null
    })
    ok(noSender === true, '没有发送方时明确记失败（不再静默吞掉）')
    ok((await readConsumed()) === null, '发不出去就不写消费证据（留给下一次重试）')
  } finally {
    delete process.env.YAN_GOAL_RESUME_EXT_LOG
    delete process.env.YAN_GOAL_RESUME_DELAY_MS
    delete process.env.YAN_GOAL_RESUME_POLL_TRIES
    delete process.env.YAN_GOAL_RESUME_POLL_MS
    await rm(root, { recursive: true, force: true })
  }
}
