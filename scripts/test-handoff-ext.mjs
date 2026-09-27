/**
 * 交接包薄层（`resources/pi-extensions/handoffs.js`）的行为测试。
 *
 * 这里验的重点不是「能不能调模型」，而是**时序**：
 * 宿主写请求文件比 pi 的 `agent_settled` 晚一步（它要先收到 state 推送、
 * load 三份 store、再渲染提示词落盘），薄层若一眼读完就走，这份请求就
 * 永远没人处理 —— 用户看到的是 90 秒后的「交接包生成超时」（2026-09-22
 * 真实报障）。所以第一个用例**真的**把请求文件延迟写进去，断言等待窗口
 * 接住了它，并且确实等过（日志里的 `attempts`）。
 *
 * 其余用例是边界：过期遗物不重做、同 operationId 不重复调模型、
 * 模型调用抛错时写出可区分的失败结果、没有模型注册表时不写结果、
 * 压根没有请求时不凭空造包。
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function runHandoffExtTests(ok) {
  const root = await mkdtemp(join(tmpdir(), 'yan-handoffext-'))
  process.env.YAN_DATA_DIR = root
  process.env.YAN_SESSION_ID = 'r1'
  const logFile = join(root, 'ext.jsonl')
  process.env.YAN_HANDOFF_EXT_LOG = logFile
  /* 默认窗口是 6 秒（≥ 3 次空转就够验证逻辑），单测不必真等那么久 */
  process.env.YAN_HANDOFF_SETTLE_TRIES = '4'
  process.env.YAN_HANDOFF_SETTLE_MS = '200'

  const requestDir = join(root, 'handoff-request')
  const requestFile = join(requestDir, 'r1.json')
  const resultFile = join(root, 'handoff-result', 'r1.json')

  const writeRequest = async (operationId, extra = {}) => {
    await mkdir(requestDir, { recursive: true })
    await writeFile(
      requestFile,
      JSON.stringify({
        handoffId: 'h1',
        operationId,
        prompt: '写一份交接包',
        maxTokens: 512,
        createdAt: Date.now(),
        ...extra
      }),
      'utf8'
    )
  }
  const readResult = async () => {
    try {
      return JSON.parse(await readFile(resultFile, 'utf8'))
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
  /** 条件轮询（不用固定 sleep 去赌时序） */
  const waitFor = async (probe, limitMs = 10_000) => {
    const until = Date.now() + limitMs
    for (;;) {
      const value = await probe()
      if (value) return value
      if (Date.now() > until) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const lastCheck = async () => {
    const log = await readLog()
    return log.filter((line) => line.hook === 'check').at(-1) ?? null
  }

  try {
    const mod = await import(new URL('../resources/pi-extensions/handoffs.js', import.meta.url))
    const factory = mod.default
    ok(typeof factory === 'function', 'handoffs.js 默认导出扩展工厂函数')

    let completeCalls = 0
    const handlers = {}
    factory({
      on: (evt, handler) => {
        handlers[evt] = handler
      },
      /* 不许注册模型工具 / 命令：薄层只做一次 completion（01 §1 的架构检查） */
      registerTool: () => {
        throw new Error('handoffs.js 不应注册模型工具')
      },
      registerCommand: () => {
        throw new Error('handoffs.js 不应注册命令')
      }
    })
    ok(typeof handlers.agent_settled === 'function', 'handoffs.js 挂在 agent_settled 上')
    const fireSettled = (ctx = {}) => handlers.agent_settled({}, {
      ...ctx,
      sessionManager: { getSessionId: () => 'handoff-ext-session' }
    })

    /*
     * 默认窗口不能被惄惄改小：自主档的 arm 会晚到链尾（那时 `agent_settled` 早已过去），
     * 等待窗口是它唯一的机会。这里读源码断言默认值，防止后续调参时把护栏拆了。
     */
    const source = await readFile(new URL('../resources/pi-extensions/handoffs.js', import.meta.url), 'utf8')
    const num = (value) => Number(String(value ?? '').replace(/_/g, ''))
    const settleTries = num(/YAN_HANDOFF_SETTLE_TRIES', ([\d_]+)\)/.exec(source)?.[1])
    const settleMs = num(/YAN_HANDOFF_SETTLE_MS', ([\d_]+)\)/.exec(source)?.[1])
    ok(
      settleTries * settleMs >= 15_000,
      `默认等待窗口 ≥ 15 秒（实际 ${settleTries} × ${settleMs}ms）`
    )

    const ctx = {
      modelRegistry: {
        complete: async () => {
          completeCalls += 1
          return { text: '{"goal":"交接目标"}' }
        }
      },
      model: { id: 'test-model' }
    }

    /* ── 1. 请求晚到（宿主慢写）：必须被等待窗口接住 ───────────────── */
    const lateWrite = (async () => {
      /* 单测窗口 4×200ms：这里故意占掉大半，比宿主真实的「晚几百毫秒」更苛刻 */
      await new Promise((resolve) => setTimeout(resolve, 500))
      await writeRequest('op-late')
    })()
    fireSettled(ctx)
    await lateWrite
    const late = await waitFor(readResult)
    ok(late?.operationId === 'op-late', '请求文件晚到（单测窗口 800ms 里的 500ms）也能生成')
    ok(late?.text === '{"goal":"交接目标"}', '结果文件带模型原文')
    ok(late?.handoffId === 'h1' && late?.error === null, '结果文件带来源 handoffId 且没有错误')
    const checkLate = await waitFor(lastCheck)
    ok((checkLate?.attempts ?? 0) >= 1, '确实等过请求（attempts ≥ 1），不是一眼读完就走')
    ok(completeCalls === 1, '一次生成只调一次模型')

    /* ── 2. 过期遗物：不重做，且把请求清掉 ─────────────────────────── */
    await rm(resultFile, { force: true })
    await writeRequest('op-stale', { createdAt: Date.now() - 31 * 60 * 1_000 })
    fireSettled(ctx)
    const staleLog = await waitFor(async () => {
      const log = await readLog()
      return log.some((line) => line.hook === 'skipped' && line.reason === 'stale') ? true : null
    })
    ok(staleLog === true, '超过 TTL 的请求被跳过（上下文已经往前走了）')
    ok(!existsSync(requestFile), '过期请求文件被清掉，不会一直留着')
    ok(completeCalls === 1, '过期请求不会调模型')

    /* ── 3. 幂等：同一 operationId 已有结果就不重复调 ───────────────── */
    await writeRequest('op-dup')
    await mkdir(join(root, 'handoff-result'), { recursive: true })
    await writeFile(resultFile, JSON.stringify({ handoffId: 'h1', operationId: 'op-dup', text: '旧结果' }), 'utf8')
    fireSettled(ctx)
    const dupLog = await waitFor(async () => {
      const log = await readLog()
      return log.some((line) => line.hook === 'skipped' && line.reason === 'already-produced') ? true : null
    })
    ok(dupLog === true, '同一 operationId 已有结果时不重复生成（宿主还没消费）')
    ok((await readResult())?.text === '旧结果', '旧结果没被覆盖')
    ok(completeCalls === 1, '幂等路径不调模型')

    /* ── 4. 拿不到模型注册表：不写结果（宿主才能区分「没跑」与「跑失败」） */
    await rm(resultFile, { force: true })
    await writeRequest('op-nomodel')
    fireSettled({})
    const noModelLog = await waitFor(async () => {
      const log = await readLog()
      return log.some((line) => line.hook === 'skipped' && line.reason === 'no-model-registry') ? true : null
    })
    ok(noModelLog === true, '没有模型注册表时不硬撑（记一条 skipped 供排障）')
    ok((await readResult()) === null, '没有模型注册表时不写结果文件')

    /* ── 5. completion 抛错：写 error 结果区分「跑失败」和「没跑」 ─────── */
    let failedCompleteCalls = 0
    const failedCtx = {
      modelRegistry: {
        complete: async () => {
          failedCompleteCalls += 1
          throw new Error('fixture model failure')
        }
      },
      model: { id: 'test-model' }
    }
    await writeRequest('op-provider-failed')
    fireSettled(failedCtx)
    const failedResult = await waitFor(async () => {
      const result = await readResult()
      return result?.operationId === 'op-provider-failed' ? result : null
    })
    ok(failedCompleteCalls === 1, '模型 completion 硬失败时只调用一次')
    ok(
      failedResult?.handoffId === 'h1' && failedResult?.error === 'fixture model failure' && failedResult?.text === '',
      'completion 抛错仍写匹配请求的 error 结果，宿主可判断模型确实运行但失败'
    )
    const failedLog = await waitFor(async () => {
      const rows = await readLog()
      return rows.find((line) => line.hook === 'produced' && line.operationId === 'op-provider-failed') ?? null
    })
    ok(failedLog?.error === 'fixture model failure', 'completion 失败诊断只记录错误摘要')

    /* Pi provider adapter 也可能以 stopReason=error 返回，而不是 reject Promise。 */
    const returnedErrorText = 'fixture provider returned HTTP 503'
    const returnedErrorCtx = {
      modelRegistry: {
        complete: async () => ({ stopReason: 'error', errorMessage: returnedErrorText, content: [] })
      },
      model: { id: 'test-model' }
    }
    await writeRequest('op-provider-error-result')
    fireSettled(returnedErrorCtx)
    const returnedErrorResult = await waitFor(async () => {
      const result = await readResult()
      return result?.operationId === 'op-provider-error-result' ? result : null
    })
    ok(
      returnedErrorResult?.error === returnedErrorText && returnedErrorResult?.text === '',
      'Pi completion 的 stopReason=error 与 errorMessage 被保留为 failed 结果'
    )

    const valid = JSON.stringify({ goal: '目标', deliverable: '交付', constraints: [], acceptance: [],
      done: [], remaining: ['核对'], nextActions: ['打开文件核对'], blockers: [], files: [], notes: [] })
    let repairCalls = 0
    await writeRequest('op-repair', { maxAttempts: 2, retryPrompt: '修复格式' })
    fireSettled({ model: ctx.model, modelRegistry: { complete: async (_model, context, options) => {
      repairCalls++
      if (repairCalls === 2) ok(context.messages[0].content[0].text.includes('修复格式'), '修复调用保留原材料并追加宿主修复要求')
      return repairCalls === 1 ? { content: [{ type: 'thinking', text: '{假的推理}' }, { type: 'text', text: '无法生成' }], stopReason: 'length' }
        : { message: { content: [{ type: 'text', text: valid }] }, stopReason: 'stop' }
    } } })
    const repaired = await waitFor(async () => { const r = await readResult(); return r?.operationId === 'op-repair' ? r : null })
    ok(repairCalls === 2 && repaired?.text === valid && repaired?.attempts === 2, '非 JSON 后有限重试成功，支持嵌套文本块')
    ok(repaired?.stopReason === 'stop', '结果保留真实结束原因')

    let badCalls = 0
    await writeRequest('op-bad', { maxAttempts: 2 })
    fireSettled({ model: ctx.model, modelRegistry: { complete: async () => { badCalls++; return { text: '坏格式', stopReason: 'length' } } } })
    const bad = await waitFor(async () => { const r = await readResult(); return r?.operationId === 'op-bad' ? r : null })
    ok(badCalls === 2 && bad?.attempts === 2 && bad?.stopReason === 'length', '两次坏格式后结束，无无限重试，记录截断原因')

    /*
     * 被长度切断 vs 格式不对：两种病两副药（2026-09-27 现场修复）。
     *
     * 现场：交接包写到 7544 字符时被 4000 token 上限切断，而修复重试仍用同一个
     * 上限 + 一句“必须包含全部列表” → 第二次跑到同一个地方再次被切断。
     * 这条同时钉住两件事：预算真的抬了，且结果里标了 truncated（宿主据此报准确原因）。
     */
    const budgets = []
    const suffixes = []
    await writeRequest('op-truncate', {
      maxAttempts: 2,
      maxTokens: 4000,
      escalatedMaxTokens: 12000,
      retryPrompt: '修复格式',
      retryPromptTruncated: '被长度切断'
    })
    await rm(resultFile, { force: true })
    fireSettled({ model: ctx.model, modelRegistry: { complete: async (_m, context, options) => {
      budgets.push(options?.maxTokens)
      suffixes.push(context.messages[0].content[0].text)
      return { text: '坏格式', stopReason: 'length' }
    } } })
    const cut = await waitFor(async () => { const r = await readResult(); return r?.operationId === 'op-truncate' ? r : null })
    ok(budgets.length === 2, `截断后仍然只试两次（实际 ${budgets.length}）`)
    ok(budgets[0] === 4000 && budgets[1] === 12000, `截断后第二跳抬预算（${budgets.join(' → ')}）`)
    ok(suffixes[1]?.includes('被长度切断'), '第二跳用截断专用提示（而不是“格式不合格”那句）')
    ok(!suffixes[1]?.includes('全部列表'), '第二跳不再要求“写更多”（那是与预算冲突的那句）')
    ok(cut?.truncated === true, '结果里标了 truncated（宿主据此把失败报成“包太长”而不是“模型不听话”）')

    /* 对照：格式问题（非 length）不得抬预算 —— 抬了也没用 */
    const formatBudgets = []
    await writeRequest('op-format', {
      maxAttempts: 2,
      maxTokens: 4000,
      escalatedMaxTokens: 12000,
      retryPrompt: '修复格式'
    })
    await rm(resultFile, { force: true })
    fireSettled({ model: ctx.model, modelRegistry: { complete: async (_m, _c, options) => {
      formatBudgets.push(options?.maxTokens)
      return { text: '坏格式', stopReason: 'stop' }
    } } })
    await waitFor(async () => { const r = await readResult(); return r?.operationId === 'op-format' ? r : null })
    ok(formatBudgets.length === 2 && formatBudgets[1] === 4000, `格式问题不抬预算（${formatBudgets.join(' → ')}）`)
    /*
     * 等 `produce()` 真的释放 `running`（上面的 waitFor 只看结果文件，
     * 而写文件到 finally 之间还有几毫秒）—— 不等的话下一节那个“无请求”的
     * `agent_settled` 会因 busy 被跳过，它等的那条 check 行根本不会出现。
     */
    await new Promise((resolve) => setTimeout(resolve, 50))

    let cancelledCalls = 0
    await writeRequest('op-cancel', { maxAttempts: 2 })
    await rm(resultFile, { force: true })
    fireSettled({ model: ctx.model, modelRegistry: { complete: async () => {
      cancelledCalls++; await rm(requestFile, { force: true }); return { text: '坏格式' }
    } } })
    await waitFor(async () => cancelledCalls ? true : null)
    await new Promise(resolve => setTimeout(resolve, 50))
    ok(cancelledCalls === 1 && !(await readResult()), '撤销请求后不重试、不写过期结果')

    /* ── 7. 压根没有请求：等满窗口后什么都不做 ─────────────────────── */
    await rm(resultFile, { force: true })
    await rm(requestFile, { force: true })
    fireSettled(ctx)
    const emptyCheck = await waitFor(async () => {
      const check = await lastCheck()
      return check && check.hasRequest === false ? check : null
    })
    ok((emptyCheck?.attempts ?? 0) >= 3, `没有请求时要等满窗口才放弃（实际 ${JSON.stringify(emptyCheck)}）`)
    if (!emptyCheck) {
      /* 失败时把日志尾巴打出来：是被 busy 跳过，还是压根没跑，一眼就能分 */
      const log = await readLog()
      console.log('    [诊断] 日志最后 6 行：', JSON.stringify(log.slice(-6)))
    }
    ok((await readResult()) === null, '没有请求时不凭空造包')
  } finally {
    delete process.env.YAN_HANDOFF_EXT_LOG
    delete process.env.YAN_HANDOFF_SETTLE_TRIES
    delete process.env.YAN_HANDOFF_SETTLE_MS
    await rm(root, { recursive: true, force: true })
  }
}
