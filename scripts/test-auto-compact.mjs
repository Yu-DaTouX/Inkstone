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
      const handlers = {}
      extension({ on: (name, fn) => (handlers[name] = fn) })
      ok(typeof handlers.agent_settled === 'function' && handlers.context === undefined, '扩展：只注册 agent_settled，不改发给模型的消息')
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

      process.env.YAN_COMPACT_WATCHDOG_MS = '20'
      let stuck = 0
      const never = (tokens) => ({ getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact: () => { stuck += 1 } })
      handlers.agent_settled({}, never(1_000_000))
      ok(stuck === 1, '自动压缩：发起一次不会回调的压缩')
      await new Promise((resolveWait) => setTimeout(resolveWait, 60))
      handlers.agent_settled({}, never(1_000_000))
      ok(stuck === 2, '自动压缩：回调丢失后由看门狗复位，不会永久停摆')
      delete process.env.YAN_COMPACT_WATCHDOG_MS
    }
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPiDir
    if (previousYanDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = previousYanDir
  }
}

if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { readFile } = await import('node:fs/promises')
  const { transform } = await import('esbuild')
  const source = await readFile(new URL('../src/shared/context-limits.ts', import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  const limits = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const mod = await import('../resources/pi-extensions/auto-compact.js')
  let passed = 0, failed = 0
  await runAutoCompactTests((condition, label, detail) => {
    if (condition) passed++
    else { failed++; console.error(`FAIL ${label} ${detail ?? ''}`) }
  }, mod, limits)
  console.log(JSON.stringify({ passed, failed }))
  if (failed) process.exitCode = 1
}
