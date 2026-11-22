import { runSuite } from './lib/test-suite.mjs'

export async function runAutoCompactTests(ok, mod, limits) {
  const { compactAt, DEFAULT_COMPACT_TOKENS, default: extension } = mod

  ok(compactAt(200_000, 272_000) === 200_000, '阈值：272K 窗口按设置值压缩（200K）')
  ok(compactAt(200_000, 128_000) === 115_200, '阈值：小窗口按比例提前')
  ok(compactAt(200_000, 1_050_000) === 200_000, '阈值：1M 窗口在 200K 压缩，不等到窗口上限')
  ok(compactAt(250_000, 272_000) === 244_800 && compactAt(800_000, 272_000) === 244_800, '阈值：Codex 272K 选 250K 或更高挡位都在约 245K 压缩（留出 pi 保底线余量）')
  for (const [win, b] of [[272_000, 200_000], [128_000, 300_000], [1_050_000, 150_000], [0, 200_000]]) {
    ok(compactAt(b, win) === limits.autoCompactAt(b, win), `阈值：扩展与 shared/context-limits 公式一致（窗口 ${win}）`)
  }
  ok(DEFAULT_COMPACT_TOKENS === limits.DEFAULT_AUTO_COMPACT_TOKENS, '阈值：扩展与 shared 的默认值一致')

  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const piDir = mkdtempSync(join(tmpdir(), 'yan-compact-pi-'))
  const previousPiDir = process.env.PI_CODING_AGENT_DIR
  const previousYanDir = process.env.YAN_DATA_DIR
  process.env.PI_CODING_AGENT_DIR = piDir
  process.env.YAN_DATA_DIR = piDir
  writeFileSync(join(piDir, 'desktop.json'), '{}')
  try {
    {
      const handlers = {}
      extension({ on: (name, fn) => (handlers[name] = fn) })
      writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
      let off = 0
      handlers.agent_settled({}, { getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_050_000 }), compact: () => { off += 1 } })
      ok(off === 0, '自动压缩：pi 的自动压缩关掉时，砚也不提前压缩')
      writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ compaction: { enabled: true } }))
    }

    {
      const { mkdirSync } = await import('node:fs')
      const project = join(piDir, 'proj')
      mkdirSync(join(project, '.pi'), { recursive: true })
      writeFileSync(join(project, '.pi', 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
      const run = (cwd, isProjectTrusted) => {
        const handlers = {}
        extension({ on: (name, fn) => (handlers[name] = fn) })
        let compacts = 0
        handlers.agent_settled({}, { cwd, isProjectTrusted, getContextUsage: () => ({ tokens: 900_000, contextWindow: 1_050_000 }), compact: () => { compacts += 1 } })
        return compacts
      }
      ok(run(project) === 1, '自动压缩：项目没被信任时，项目里的 compaction.enabled=false 不生效')
      ok(run(project, () => true) === 0, '自动压缩：当前 pi 会话已信任项目时，即使没有持久记录也尊重项目开关')
      writeFileSync(join(piDir, 'trust.json'), JSON.stringify({ [project]: true }))
      ok(run(project) === 0, '自动压缩：被信任的项目里 compaction.enabled=false 时不压缩')
      ok(run(project, () => false) === 1, '自动压缩：当前 pi 会话不信任项目时，不用磁盘信任绕过会话决定')
      mkdirSync(join(project, 'sub', '.pi'), { recursive: true })
      writeFileSync(join(project, 'sub', '.pi', 'settings.json'), JSON.stringify({ compaction: { enabled: false } }))
      ok(run(join(project, 'sub')) === 0, '自动压缩：信任沿父目录向下生效')
      ok(run(piDir) === 1, '自动压缩：其他项目不受影响')
      writeFileSync(join(piDir, 'trust.json'), JSON.stringify({ [project]: false }))
      ok(run(project) === 1, '自动压缩：明确不信任的项目按全局设置')
      writeFileSync(join(piDir, 'trust.json'), JSON.stringify({ [project]: 'yes', [piDir]: true }))
      ok(run(project) === 0, '自动压缩：信任记录不是布尔值时跳过，继续看上级目录（与 pi 一致）')
    }

    {
      const handlers = {}
      extension({ on: (name, fn) => (handlers[name] = fn) })
      ok(typeof handlers.agent_settled === 'function' && handlers.context === undefined, '扩展：从 agent_settled 触发，不改发给模型的消息')
      let compacts = 0
      const ctx = (tokens) => ({ getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact: (o) => { compacts += 1; o.onComplete?.() } })
      handlers.agent_settled({}, ctx(150_000))
      ok(compacts === 0, '自动压缩：没到上限不压缩')
      handlers.agent_settled({}, ctx(410_000))
      ok(compacts === 1, '自动压缩：超过上限调用一次 pi 原生 compact')
      handlers.agent_settled({}, ctx(null))
      ok(compacts === 1, '自动压缩：压缩后用量未知时不重复触发')
      handlers.agent_settled({}, ctx(405_000))
      handlers.agent_settled({}, ctx(430_000))
      ok(compacts === 1, '自动压缩：压缩后仍在上限之上时不连续再压（每次压缩都要调模型）')
      handlers.agent_settled({}, ctx(490_000))
      ok(compacts === 2, '自动压缩：压缩后又增长超过 20% 才再压')
      handlers.agent_settled({}, ctx(120_000))
      let fails = 0
      const failing = (tokens) => ({ getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact: (o) => { fails += 1; o.onError?.(new Error('Nothing to compact')) } })
      handlers.agent_settled({}, failing(410_000))
      handlers.agent_settled({}, failing(430_000))
      ok(fails === 1, '自动压缩：失败后上下文没明显增长前不重试（不每轮报失败）')
      handlers.agent_settled({}, failing(500_000))
      ok(fails === 2, '自动压缩：失败后增长超过 20% 再试')

      const inSession = (id, tokens, compact) => ({ sessionManager: { getSessionId: () => id }, getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact })
      let switched = 0
      handlers.agent_settled({}, inSession('A', 410_000, (o) => { switched += 1; o.onError?.(new Error('Nothing to compact')) }))
      handlers.agent_settled({}, inSession('B', 420_000, () => { switched += 1 }))
      ok(switched === 2, '自动压缩：切到另一会话时不沿用上一会话的失败退避')
      let late
      handlers.agent_settled({}, inSession('C', 410_000, (o) => { late = o }))
      handlers.agent_settled({}, inSession('D', 410_000, () => { switched += 1 }))
      late?.onError?.(new Error('late'))
      handlers.agent_settled({}, inSession('D', 1_000_000, () => { switched += 1 }))
      ok(switched === 3, '自动压缩：旧会话迟到的失败回调不改当前会话的退避状态')

      const previousWatchdog = process.env.YAN_COMPACT_WATCHDOG_MS
      try {
        process.env.YAN_COMPACT_WATCHDOG_MS = '20'
        const attempts = []
        const pending = (tokens) => inSession('watchdog', tokens, (callbacks) => { attempts.push(callbacks) })
        handlers.agent_settled({}, pending(900_000))
        ok(attempts.length === 1, '自动压缩：发起一次不会回调的压缩')
        await new Promise((resolveWait) => setTimeout(resolveWait, 60))
        process.env.YAN_COMPACT_WATCHDOG_MS = '60000'
        handlers.agent_settled({}, pending(900_000))
        ok(attempts.length === 2, '自动压缩：回调丢失后由看门狗复位，不会永久停摆')
        attempts[0].onError(new Error('late'))
        handlers.agent_settled({}, pending(1_200_000))
        ok(attempts.length === 2, '自动压缩：同会话旧尝试的迟到回调不会解锁进行中的新压缩')
        attempts[1].onComplete()
        attempts[0].onError(new Error('late again'))
        handlers.agent_settled({}, pending(1_200_000))
        ok(attempts.length === 2, '自动压缩：旧回调不能覆盖新压缩结束后的退避')
        handlers.session_shutdown?.()
      } finally {
        if (previousWatchdog === undefined) delete process.env.YAN_COMPACT_WATCHDOG_MS
        else process.env.YAN_COMPACT_WATCHDOG_MS = previousWatchdog
      }
    }
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPiDir
    if (previousYanDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = previousYanDir
  }
}

await runSuite(import.meta.url, async (ok, compile) => {
  const limits = await compile('src/shared/context-limits.ts')
  const mod = await import('../resources/pi-extensions/auto-compact.js')
  await runAutoCompactTests(ok, mod, limits)
})
