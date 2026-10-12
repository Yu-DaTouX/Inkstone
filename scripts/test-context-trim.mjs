/**
 * 旧工具输出裁剪与自动压缩上限（resources/pi-extensions/context-trim.js）的单测。
 *
 * 钉住三件事：没到软线时一条消息都不改；到线后一次裁到位且之后前缀稳定；
 * 近期长轮仅在硬线压力下放宽，保留最近工具组和技能。另对照 shared/context-limits.ts。
 * 可直接运行 node scripts/test-context-trim.mjs，不依赖产品构建或真实模型。
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

  {
    const user = { role: 'user', content: [{ type: 'text', text: '一次长任务' }] }
    const long = [user, ...history(12).filter(m => m.role !== 'user')]
    const unchanged = JSON.stringify(long)
    ok(trimMessages(long, { trimmed: new Map(), projectedTokens: 100_000, threshold: 80_000 }) === undefined, '长单轮：仅超软线仍保护近期证据')
    const out = trimMessages(long, { trimmed: new Map(), projectedTokens: 200_000, threshold: 80_000, cacheCold: false })
    const ids = stubbed(out ?? [])
    ok(ids.length === 9 && !ids.includes('c10') && !ids.includes('c11') && !ids.includes('c12'), '长单轮：超硬线可裁9组，但最后3组仍完整', ids.join(','))
    ok(JSON.stringify(long) === unchanged, '长单轮：不修改持久化原消息')
    const few = [user, ...history(3).filter(m => m.role !== 'user')]
    ok(trimMessages(few, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) === undefined, '长单轮：再大也保留最近3组')
    const parallel = structuredClone(long)
    parallel[1].content.push({ type: 'toolCall', id: 'parallel', name: 'read', arguments: { path: 'pending.txt' } })
    const pending = stubbed(trimMessages(parallel, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(!pending.includes('c1'), '工具组：并行调用未全部返回时不裁同组已完成结果')
    parallel.splice(3, 0, { role: 'toolResult', toolCallId: 'parallel', toolName: 'read', content: [{ type: 'text', text: big }] })
    const complete = stubbed(trimMessages(parallel, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(complete.includes('c1') && complete.includes('parallel') && !complete.includes('c10'), '工具组：并行结果按一组计算近期保护')
    const protectedMessages = structuredClone(long)
    protectedMessages[1].content[0] = { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/skills/office/SKILL.md' } }
    protectedMessages.find(m => m.toolCallId === 'c2').isError = true
    const protectedIds = stubbed(trimMessages(protectedMessages, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(!protectedIds.includes('c1') && !protectedIds.includes('c2'), '长单轮：技能与错误结果不裁')
    // 每轮独立保留最近3组，不把全局最后3组当作所有轮的保护。
    const multi = [user, ...history(6).filter(m => m.role !== 'user'), user, ...history(6).map(m => {
      const copy = structuredClone(m)
      if (copy.toolCallId) copy.toolCallId = `n${copy.toolCallId}`
      for (const p of copy.content ?? []) if (p.type === 'toolCall') p.id = `n${p.id}`
      return copy
    }).filter(m => m.role !== 'user')]
    const multiIds = stubbed(trimMessages(multi, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(multiIds.length === 6 && !multiIds.includes('c4') && !multiIds.includes('nc4'), '长轮：每个近期用户轮分别保留最近3组')
  }

  {
    const shortTurn = i => turn(i, 'x'.repeat(8000))
    const user = { role: 'user', content: [{ type: 'text', text: '不裁剪的大用户输入' + 'z'.repeat(40000) }] }
    const trimmed = new Map()
    let messages = [user, ...Array.from({ length: 10 }, (_, i) => shortTurn(i + 1)).flat().filter(m => m.role !== 'user')]
    let previous
    const batches = []
    for (let i = 0; i < 5; i++) {
      const snapshot = JSON.stringify(messages)
      const before = trimmed.size
      const output = trimMessages(messages, { trimmed, projectedTokens: mod.estimateTokens(JSON.stringify(messages)), threshold: 8000, cacheCold: i === 0 }) ?? messages
      batches.push(trimmed.size - before)
      if (previous && trimmed.size === before) ok(JSON.stringify(output.slice(0, previous.length)) === JSON.stringify(previous), `缓存前缀：第${i + 1}轮延后小裁时整个原前缀逐字不变`)
      ok(JSON.stringify(messages) === snapshot, `缓存批次：第${i + 1}轮候选规划不修改原历史`)
      previous = output
      messages = [...messages, ...shortTurn(11 + i).filter(m => m.role !== 'user')]
    }
    ok(JSON.stringify(batches) === '[7,0,0,3,0]', '缓存防抖：受保护内容持续超硬线时先攒批次，不逐轮裁1项', batches.join(','))

    const tiny = [...shortTurn(1), ...Array.from({ length: 3 }, (_, i) => turn(i + 2, 'small')).flat()]
    for (const cacheCold of [false, true]) {
      const plan = new Map()
      ok(trimMessages(tiny, { trimmed: plan, projectedTokens: 20000, threshold: 8000, cacheCold }) === undefined && plan.size === 0, `缓存收益：${cacheCold ? '假定冷' : '热'}缓存下也不为约2k节省破坏20k前缀`)
    }
    const existing = new Map([['c1', 1000]])
    const more = [...shortTurn(1), ...shortTurn(2), ...Array.from({ length: 3 }, (_, i) => turn(i + 3, 'small')).flat()]
    const output = trimMessages(more, { trimmed: existing, projectedTokens: 21000, threshold: 8000, cacheCold: false })
    ok(existing.size === 1 && JSON.stringify(stubbed(output)) === '["c1"]', '缓存收益：拒绝候选不污染已裁集合，旧存根仍保持')

    const pressure = new Map()
    const emergency = trimMessages(tiny, { trimmed: pressure, projectedTokens: 20000, threshold: 8000, cacheCold: false, contextWindow: 24000 })
    ok(stubbed(emergency ?? []).length === 1, '容量兜底：超过已知窗口80%时允许小批次，不为缓存拖到溢出')
    const skill = [...turn(1, big, 'read', { path: 'SKILL.md' }), ...Array.from({ length: 3 }, (_, i) => turn(i + 2, 'small')).flat()]
    ok(trimMessages(skill, { trimmed: new Map(), projectedTokens: 20000, threshold: 8000, contextWindow: 24000 }) === undefined, '容量兜底：仍不突破技能保护')
    const recent = [user, ...Array.from({ length: 3 }, (_, i) => shortTurn(i)).flat().filter(m => m.role !== 'user')]
    ok(trimMessages(recent, { trimmed: new Map(), projectedTokens: 20000, threshold: 8000, contextWindow: 24000 }) === undefined, '容量兜底：仍保留最近3组，不能强裁最新证据')
    ok(trimMessages(tiny, { trimmed: new Map(), projectedTokens: null, threshold: 8000, contextWindow: 24000 }) === undefined, '容量未知：不能根据窗口值猜测请求已经临近上限')
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

    {
      const settings = (enabled) => writeFileSync(join(piDir, 'desktop.json'), JSON.stringify({ contextTrim: enabled, contextTrimTokens: 8000 }))
      settings(true)
      const user = (i) => ({ role: 'user', content: [{ type: 'text', text: `继续${i}` }] })
      const input = [...Array.from({ length: 9 }, (_, i) => turn(i + 1, 'x'.repeat(8400))).flat(), user(0)]
      const response = (id, stopReason = 'stop', tokens = 5600) => ({ role: 'assistant', timestamp: id, provider: 'fixture', model: 'fixture', stopReason, content: [{ type: 'text', text: '好' }], usage: { input: tokens, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 20 } })
      const fixture = () => {
        const handlers = {}
        extension({ on: (name, fn) => (handlers[name] = fn) })
        const run = (messages, tokens, branch = []) => handlers.context({ messages }, { getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }), sessionManager: { getBranch: () => branch } })?.messages ?? messages
        return { handlers, run }
      }
      const { handlers, run } = fixture()
      ok(stubbed(run(input, 20000)).length === 7, '用量：首次请求按完整估值裁7项')
      const first = response(1)
      handlers.message_end({ message: first })
      const follow = [...input, first, user(1), user(2), user(3)]
      ok(stubbed(run(follow, 5628)).length === 7, '用量：成功后低用量不新裁，存根保持稳定')
      ok(stubbed(run(follow, 20000)).length === 9, '用量：真实口径增长超硬线后裁到9项，不重复扣掉先前节省')

      const aborted = fixture()
      aborted.run(input, 20000)
      aborted.handlers.message_end({ message: first })
      const error = response(2, 'error', 100000)
      aborted.handlers.message_end({ message: error })
      ok(stubbed(aborted.run([...follow, error], 20000)).length === 9, '用量：失败回复不覆盖上次成功用量的裁剪记录')
      const zero = fixture()
      zero.run(input, 20000)
      zero.handlers.message_end({ message: first })
      const missingUsage = { ...response(3), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } }
      zero.handlers.message_end({ message: missingUsage })
      ok(stubbed(zero.run([...follow, missingUsage], 20000)).length === 9, '用量：无用量回复不覆盖成功锚点')

      const unknown = fixture()
      unknown.run(input, 20000)
      ok(stubbed(unknown.run(follow, null)).length === 7, '用量：未知时仅重放已有存根，不开新批')
      const changed = fixture()
      changed.run(input, 20000)
      changed.handlers.message_end({ message: first })
      ok(stubbed(changed.run(follow, 20000, [{ type: 'context_edit', id: 'edit1' }])).length === 7, '原生投影编辑后：用量回到完整估值，不补回旧请求节省')

      const toggle = fixture()
      toggle.run(input, 20000)
      toggle.handlers.message_end({ message: first })
      settings(false)
      ok(stubbed(toggle.run(follow, 20000)).length === 0, '开关：关闭后返回完整消息')
      const untrimmedReply = response(4, 'stop', 20000)
      toggle.handlers.message_end({ message: untrimmedReply })
      settings(true)
      ok(stubbed(toggle.run([...follow, untrimmedReply], 20000)).length === 7, '开关：未裁请求的用量不再补回旧节省')

      const smallBatch = [...turn(1, 'x'.repeat(8000)), ...Array.from({ length: 3 }, (_, i) => turn(i + 2, 'short')).flat()]
      const capacity = fixture()
      ok(stubbed(capacity.run(smallBatch, 20000)).length === 0, '扩展装配：大窗口下小批次不改变请求前缀')
      const pressureOutput = capacity.handlers.context({ messages: smallBatch }, { getContextUsage: () => ({ tokens: 20000, contextWindow: 24000 }) })?.messages ?? smallBatch
      ok(stubbed(pressureOutput).length === 1, '扩展装配：实际窗口传给裁剪器，容量兜底可触发')

      for (const event of ['session_start', 'session_tree', 'session_compact']) {
        const f = fixture()
        f.run(input, 20000)
        f.handlers.message_end({ message: first })
        f.handlers[event]({})
        ok(stubbed(f.run(input, 1000)).length === 0, `${event}：清理旧存根与用量记录，复用调用ID不污染新上下文`)
      }
    }
  } finally {
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousPiDir
    if (previousYanDir === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = previousYanDir
  }
}

// 只运行这一组，无构建、个人设置或真实模型依赖。
if (process.argv[1] && (await import('node:url')).pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { readFile } = await import('node:fs/promises')
  const { transform } = await import('esbuild')
  const source = await readFile(new URL('../src/shared/context-limits.ts', import.meta.url), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm' })
  const limits = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const mod = await import('../resources/pi-extensions/context-trim.js')
  let passed = 0, failed = 0
  await runContextTrimTests((condition, label, detail) => {
    if (condition) passed++
    else { failed++; console.error(`FAIL ${label} ${detail ?? ''}`) }
  }, mod, limits)
  console.log(JSON.stringify({ passed, failed }))
  if (failed) process.exitCode = 1
}
