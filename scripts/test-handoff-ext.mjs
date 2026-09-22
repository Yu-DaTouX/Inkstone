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
 * 没有模型注册表时不写结果、压根没有请求时不凭空造包。
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
    handlers.agent_settled({}, ctx)
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
    handlers.agent_settled({}, ctx)
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
    handlers.agent_settled({}, ctx)
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
    handlers.agent_settled({}, {})
    const noModelLog = await waitFor(async () => {
      const log = await readLog()
      return log.some((line) => line.hook === 'skipped' && line.reason === 'no-model-registry') ? true : null
    })
    ok(noModelLog === true, '没有模型注册表时不硬撑（记一条 skipped 供排障）')
    ok((await readResult()) === null, '没有模型注册表时不写结果文件')

    /* ── 5. 压根没有请求：等满窗口后什么都不做 ─────────────────────── */
    await rm(requestFile, { force: true })
    handlers.agent_settled({}, ctx)
    const emptyCheck = await waitFor(async () => {
      const check = await lastCheck()
      return check && check.hasRequest === false ? check : null
    })
    ok((emptyCheck?.attempts ?? 0) >= 3, '没有请求时要等满窗口才放弃（attempts 记下等了几次）')
    ok((await readResult()) === null, '没有请求时不凭空造包')
  } finally {
    delete process.env.YAN_HANDOFF_EXT_LOG
    delete process.env.YAN_HANDOFF_SETTLE_TRIES
    delete process.env.YAN_HANDOFF_SETTLE_MS
    await rm(root, { recursive: true, force: true })
  }
}
