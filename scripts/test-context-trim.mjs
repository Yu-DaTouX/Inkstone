/**
 * 旧工具输出裁剪与自动压缩上限（resources/pi-extensions/context-trim.js）的单测。
 *
 * 钉住三件事：没到软线时一条消息都不改；到线后一次裁到位且之后前缀稳定；
 * 最近几轮与技能文件不裁。另对照 shared/context-limits.ts，保证两边触发线公式一致。
 */
export async function runContextTrimTests(ok, mod, limits) {
  const { trimMessages, trimAt, compactAt, DEFAULT_TRIM_TOKENS, DEFAULT_COMPACT_TOKENS, default: extension } = mod

  const big = 'x'.repeat(40_000) // 约 10K token
  const turn = (i, text = big, name = 'bash', args = { command: `cat file${i}.txt` }) => [
    { role: 'user', content: [{ type: 'text', text: `第 ${i} 轮` }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name, arguments: args }] },
    { role: 'toolResult', toolCallId: `c${i}`, toolName: name, content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'text', text: `好的 ${i}` }] }
  ]
  const history = (n) => Array.from({ length: n }, (_, i) => turn(i + 1)).flat()
  const stubbed = (msgs) => msgs.filter((m) => m.role === 'toolResult' && /已省略/.test(m.content[0].text)).map((m) => m.toolCallId)

  {
    const trimmed = new Map()
    const msgs = history(8)
    ok(trimMessages(msgs, { trimmed, projectedTokens: 50_000, threshold: 80_000 }) === undefined, '裁剪：没到软线时不改任何消息')
    ok(trimmed.size === 0, '裁剪：没到软线时不记任何条目')
  }

  {
    const trimmed = new Map()
    const msgs = history(10)
    const out = trimMessages(msgs, { trimmed, projectedTokens: 100_000, threshold: 80_000 })
    const ids = stubbed(out ?? [])
    ok(ids.length > 0 && ids[0] === 'c1', '裁剪：超线后从最旧的工具输出开始裁', ids.join(','))
    ok(!ids.includes('c8') && !ids.includes('c9') && !ids.includes('c10'), '裁剪：最近 3 轮原样保留')
    ok(ids.length >= 5, '裁剪：一次裁到软线的 60% 以下（不是只裁一条）', String(ids.length))
    const stub = out.find((m) => m.toolCallId === 'c1').content[0].text
    ok(/bash `cat file1\.txt`/.test(stub) && /read/.test(stub), '裁剪：存根写明是哪次调用、怎么找回', stub)
    ok(msgs.find((m) => m.toolCallId === 'c1').content[0].text === big, '裁剪：不改原消息对象（会话记录不受影响）')

    /* 再来一轮：发送量已降到线下，已裁的保持、不再新裁 → 前缀稳定 */
    const more = [...msgs, ...turn(11)]
    const out2 = trimMessages(more, { trimmed, projectedTokens: 110_000, threshold: 80_000 })
    ok(JSON.stringify(stubbed(out2)) === JSON.stringify(ids), '裁剪：降到线下后已裁集合不变，请求前缀稳定')
  }

  {
    const trimmed = new Map()
    const skill = turn(1, big, 'read', { path: 'C:\\x\\skills\\office\\SKILL.md' })
    const msgs = [...skill, ...history(6).map((m) => (m.toolCallId ? { ...m, toolCallId: `n${m.toolCallId}` } : m.content?.[0]?.type === 'toolCall' ? { ...m, content: [{ ...m.content[0], id: `n${m.content[0].id}` }] } : m))]
    const out = trimMessages(msgs, { trimmed, projectedTokens: 200_000, threshold: 80_000 })
    ok(!stubbed(out ?? []).includes('c1'), '裁剪：技能文件的读取结果不裁')
  }

  {
    const msgs = history(10)
    const warm = new Map()
    ok(trimMessages(msgs, { trimmed: warm, projectedTokens: 100_000, threshold: 80_000, cacheCold: false }) === undefined, '挑时机：缓存还热、没到硬线（1.5 倍）时不开新批，不破坏缓存')
    ok(stubbed(trimMessages(msgs, { trimmed: warm, projectedTokens: 125_000, threshold: 80_000, cacheCold: false }) ?? []).length > 0, '挑时机：超过硬线时即使缓存还热也裁')
    const kept = new Map([['c1', 9_000]])
    const out = trimMessages(msgs, { trimmed: kept, projectedTokens: 100_000, threshold: 80_000, cacheCold: false })
    ok(JSON.stringify(stubbed(out)) === '["c1"]', '挑时机：缓存热时已裁的条目照常保持存根（前缀不变）')
  }

  {
    const trimmed = new Map()
    const small =Array.from({ length: 8 }, (_, i) => turn(i + 1, 'short output')).flat()
    ok(trimMessages(small, { trimmed, projectedTokens: 200_000, threshold: 80_000 }) === undefined, '裁剪：小输出不值得换成存根')
  }

  ok(trimAt(80_000, 272_000) === 80_000 && compactAt(200_000, 272_000) === 200_000, '阈值：272K 窗口按设置值触发（裁 80K / 压 200K）')
  ok(trimAt(80_000, 128_000) === 38_400 && compactAt(200_000, 128_000) === 115_200, '阈值：小窗口按比例提前')
  ok(compactAt(200_000, 1_050_000) === 200_000, '阈值：1M 窗口在 200K 压缩，不等到窗口上限')
  ok(compactAt(250_000, 272_000) === 244_800 && compactAt(800_000, 272_000) === 244_800, '阈值：Codex 272K 选 250K 或更高挡位都在约 245K 压缩（留出 pi 保底线余量）')
  for (const [win, a, b] of [[272_000, 80_000, 200_000], [128_000, 50_000, 300_000], [1_050_000, 120_000, 150_000], [0, 80_000, 200_000]]) {
    ok(trimAt(a, win) === limits.contextTrimAt(a, win) && compactAt(b, win) === limits.autoCompactAt(b, win), `阈值：扩展与 shared/context-limits 公式一致（窗口 ${win}）`)
  }
  ok(DEFAULT_TRIM_TOKENS === limits.DEFAULT_CONTEXT_TRIM_TOKENS && DEFAULT_COMPACT_TOKENS === limits.DEFAULT_AUTO_COMPACT_TOKENS, '阈值：扩展与 shared 的默认值一致')

  /* pi 的设置目录指到临时目录：不读真实 ~/.pi/agent，并能切换 pi 的自动压缩开关 */
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const piDir = mkdtempSync(join(tmpdir(), 'yan-trim-pi-'))
  const previousPiDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = piDir

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
    ok(typeof handlers.context === 'function' && typeof handlers.agent_settled === 'function', '扩展：注册 context 与 agent_settled')
    let compacts = 0
    const ctx = (tokens) => ({ getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact: (o) => { compacts += 1; o.onComplete?.() } })
    handlers.agent_settled({}, ctx(150_000))
    ok(compacts === 0, '自动压缩：没到上限不压缩')
    handlers.agent_settled({}, ctx(260_000))
    ok(compacts === 1, '自动压缩：超过上限调用一次 pi 原生 compact')
    handlers.agent_settled({}, ctx(null))
    ok(compacts === 1, '自动压缩：压缩后用量未知时不重复触发')
    handlers.agent_settled({}, ctx(255_000))
    handlers.agent_settled({}, ctx(280_000))
    ok(compacts === 1, '自动压缩：压缩后仍在上限之上时不连续再压（每次压缩都要调模型）')
    handlers.agent_settled({}, ctx(310_000))
    ok(compacts === 2, '自动压缩：压缩后又增长超过 20% 才再压')
    handlers.agent_settled({}, ctx(120_000))
    let fails = 0
    const failing = (tokens) => ({ getContextUsage: () => ({ tokens, contextWindow: 1_050_000 }), compact: (o) => { fails += 1; o.onError?.(new Error('Nothing to compact')) } })
    handlers.agent_settled({}, failing(260_000))
    handlers.agent_settled({}, failing(280_000))
    ok(fails === 1, '自动压缩：失败后上下文没明显增长前不重试（不每轮报失败）')
    handlers.agent_settled({}, failing(320_000))
    ok(fails === 2, '自动压缩：失败后增长超过 20% 再试')
  }

  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = previousPiDir
}
