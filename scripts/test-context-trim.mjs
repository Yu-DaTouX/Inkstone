export async function runContextTrimTests(ok, mod, limits) {
  const { trimMessages, trimAt, compactAt, DEFAULT_TRIM_TOKENS, DEFAULT_COMPACT_TOKENS, default: extension } = mod

  const big = 'x'.repeat(40_000)
  const turn = (i, text = big, name = 'bash', args = { command: `cat file${i}.txt` }) => [
    { role: 'user', content: [{ type: 'text', text: `第 ${i} 轮` }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name, arguments: args }] },
    { role: 'toolResult', toolCallId: `c${i}`, toolName: name, content: [{ type: 'text', text }] },
    { role: 'assistant', content: [{ type: 'text', text: `好的 ${i}` }] }
  ]
  const history = (n) => Array.from({ length: n }, (_, i) => turn(i + 1)).flat()
  const stubbed = (msgs) => msgs.filter((m) => m.role === 'toolResult' && /^\[Earlier tool output trimmed/.test(m.content[0].text)).map((m) => m.toolCallId)

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

    const more = [...msgs, ...turn(11)]
    const out2 = trimMessages(more, { trimmed, projectedTokens: 110_000, threshold: 80_000 })
    ok(JSON.stringify(stubbed(out2)) === JSON.stringify(ids), '裁剪：降到线下后已裁集合不变，请求前缀稳定')
  }

  {
    const trimmed = new Map()
    const skill = turn(1, big, 'read', { path: 'C:\\x\\skills\\office\\SKILL.md' })
    const msgs = [...skill, ...history(6).map((m) => (m.toolCallId ? { ...m, toolCallId: `n${m.toolCallId}` } : m.content?.[0]?.type === 'toolCall' ? { ...m, content: [{ ...m.content[0], id: `n${m.content[0].id}` }] } : m))]
    const out = trimMessages(msgs, { trimmed, projectedTokens: 85_000, threshold: 80_000 })
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
    const mid = 'y'.repeat(2_400)
    const midHistory = Array.from({ length: 40 }, (_, i) => turn(i + 1, mid)).flat()
    const ids = stubbed(trimMessages(midHistory, { trimmed: new Map(), projectedTokens: 100_000, threshold: 80_000 }) ?? [])
    ok(ids.includes('c1') && !ids.includes('c40'), '裁剪：较早的中等输出（1500–4000 字符）也会成批换成存根', ids.join(','))
  }

  {
    const content = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'z'.repeat(30)}`).join('\n')
    const writeTurn = (i) => turn(i, 'Successfully wrote', 'write', { path: `src/f${i}.ts`, content })
    const editTurn = (i) => turn(i, 'Successfully replaced 1 block(s)', 'edit', { path: `src/e${i}.ts`, edits: [{ oldText: content, newText: content }] })
    const msgs = [...writeTurn(1), ...editTurn(2), ...Array.from({ length: 4 }, (_, i) => writeTurn(i + 3)).flat()]
    const trimmed = new Map()
    const out = trimMessages(msgs, { trimmed, projectedTokens: 85_000, threshold: 80_000 })
    const argsOf = (list, id) => list.find((m) => m.role === 'assistant' && m.content[0]?.id === id).content[0].arguments
    ok(out && /^\[Earlier write input trimmed/.test(argsOf(out, 'c1').trimmed) && argsOf(out, 'c1').path === 'src/f1.ts' && !('content' in argsOf(out, 'c1')), '裁剪：旧的 write 参数换成带路径的存根', JSON.stringify(out && argsOf(out, 'c1')))
    ok(/edit input trimmed/.test(argsOf(out, 'c2').trimmed) && argsOf(out, 'c2').path === 'src/e2.ts', '裁剪：旧的 edit 参数换成带路径的存根')
    ok(argsOf(out, 'c6').content === content, '裁剪：最近几轮的写入参数原样保留')
    ok(argsOf(msgs, 'c1').content === content, '裁剪：不改原调用对象（会话记录不受影响）')
    const again = trimMessages([...msgs, ...writeTurn(7)], { trimmed, projectedTokens: 60_000, threshold: 80_000 })
    ok(again && JSON.stringify(argsOf(again, 'c1')) === JSON.stringify(argsOf(out, 'c1')), '裁剪：已裁的参数在后续请求里保持同一存根（前缀稳定）')
    const failedEdit = [...turn(1, 'x', 'edit', { path: 'a.ts', edits: [{ oldText: content, newText: 'n' }] }).map((m) => (m.role === 'toolResult' ? { ...m, isError: true } : m)), ...Array.from({ length: 6 }, (_, i) => writeTurn(i + 2)).flat()]
    const failedOut = trimMessages(failedEdit, { trimmed: new Map(), projectedTokens: 85_000, threshold: 80_000 })
    ok(failedOut && argsOf(failedOut, 'c2').trimmed, '裁剪：失败 edit 之后的旧写入照常裁剪')
    ok(argsOf(failedOut ?? failedEdit, 'c1').edits?.[0]?.oldText === content, '裁剪：失败的 edit 保留原参数（模型可能要据此重试）')
  }

  {
    const user = { role: 'user', content: [{ type: 'text', text: '一次长任务' }] }
    const long = [user, ...history(12).filter(m => m.role !== 'user')]
    const unchanged = JSON.stringify(long)
    const budgetOut = trimMessages(long, { trimmed: new Map(), projectedTokens: 100_000, threshold: 80_000 })
    const budgetIds = stubbed(budgetOut ?? [])
    ok(budgetIds.length > 0 && budgetIds[0] === 'c1', '长单轮：仅超预算就在近期轮内裁掉最早的输出')
    ok(!budgetIds.includes('c5') && !budgetIds.includes('c9') && !budgetIds.includes('c12'), '长单轮：最近 8 个工具结果始终保留')
    ok(JSON.stringify(long) === unchanged, '长单轮：预算裁剪也不修改持久化原消息')
    const out = trimMessages(long, { trimmed: new Map(), projectedTokens: 200_000, threshold: 80_000, cacheCold: false })
    const ids = stubbed(out ?? [])
    ok(ids.length === 10 && !ids.includes('c11') && !ids.includes('c12'), '长单轮：超硬线按 20k 预算裁到只剩最近 2 组（每组约 10k token）', ids.join(','))
    ok(JSON.stringify(long) === unchanged, '长单轮：不修改持久化原消息')
    const huge = [user, ...history(1).map(m => m.role === 'toolResult' ? { ...m, content: [{ type: 'text', text: 'x'.repeat(200_000) }] } : m).filter(m => m.role !== 'user')]
    ok(trimMessages(huge, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) === undefined, '长单轮：最新一组即使远超 20k 预算也无条件保留')
    const threeBig = [user, ...Array.from({ length: 8 }, (_, i) => ({
      role: 'assistant', content: [{ type: 'toolCall', id: `b${i + 1}`, name: 'read', arguments: { path: `big/a0${i + 1}.txt` } }]
    })).flatMap((step, i) => [step, { role: 'toolResult', toolCallId: `b${i + 1}`, toolName: 'read', content: [{ type: 'text', text: 'x'.repeat(50_000) }] }])]
    const threeIds = stubbed(trimMessages(threeBig, { trimmed: new Map(), projectedTokens: 200_000, threshold: 80_000, cacheCold: false }) ?? [])
    ok(threeIds.includes('b1') && threeIds.includes('b3') && !threeIds.includes('b7') && !threeIds.includes('b8'), '长单轮：单回合 8 个 50KB 工具组只无条件保护最新的 2 组（约 25k 输出），不再整回合绕过裁剪', threeIds.join(','))
    const few = [user, ...history(3).filter(m => m.role !== 'user')]
    ok(trimMessages(few, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) === undefined, '长单轮：再大也保留最近3组')
    const parallel = structuredClone(long)
    parallel[1].content.push({ type: 'toolCall', id: 'parallel', name: 'read', arguments: { path: 'pending.txt' } })
    const pending = stubbed(trimMessages(parallel, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(!pending.includes('c1'), '工具组：并行调用未全部返回时不裁同组已完成结果')
    parallel.splice(3, 0, { role: 'toolResult', toolCallId: 'parallel', toolName: 'read', content: [{ type: 'text', text: big }] })
    const complete = stubbed(trimMessages(parallel, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(complete.includes('c1') && complete.includes('parallel') && !complete.includes('c11'), '工具组：并行结果按一组计算近期保护', complete.join(','))
    const protectedMessages = structuredClone(long)
    protectedMessages[1].content[0] = { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/skills/office/SKILL.md' } }
    protectedMessages.find(m => m.toolCallId === 'c2').isError = true
    const protectedIds = stubbed(trimMessages(protectedMessages, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(!protectedIds.includes('c1') && !protectedIds.includes('c2'), '长单轮：技能与错误结果不裁')
    const multi = [user, ...history(6).filter(m => m.role !== 'user'), user, ...history(6).map(m => {
      const copy = structuredClone(m)
      if (copy.toolCallId) copy.toolCallId = `n${copy.toolCallId}`
      for (const p of copy.content ?? []) if (p.type === 'toolCall') p.id = `n${p.id}`
      return copy
    }).filter(m => m.role !== 'user')]
    const multiIds = stubbed(trimMessages(multi, { trimmed: new Map(), projectedTokens: 900_000, threshold: 80_000, contextWindow: 1_000_000 }) ?? [])
    ok(multiIds.length === 8 && !multiIds.includes('c5') && !multiIds.includes('nc5'), '长轮：每个近期用户轮分别按 20k 预算保留最近 2 组')
  }

  {
    const user = { role: 'user', content: [{ type: 'text', text: '一个用户轮里跑很多步' }] }
    const msgs = [user, ...history(16).filter(m => m.role !== 'user')]
    const ids = (out) => stubbed(out ?? msgs)
    const first = new Map()
    const out1 = trimMessages(msgs, { trimmed: first, projectedTokens: 100_000, threshold: 80_000, cacheCold: false })
    const cut1 = ids(out1)
    ok(cut1.length > 0 && cut1[0] === 'c1', '单轮长会话：超预算即裁，从最旧工具输出开始', cut1.join(','))
    ok(!cut1.includes('c9') && !cut1.includes('c16'), '单轮长会话：最近 8 个工具结果仍保留')
    const repeated = trimMessages(msgs, { trimmed: first, projectedTokens: 100_000, threshold: 80_000, cacheCold: false })
    ok(JSON.stringify(ids(repeated)) === JSON.stringify(cut1), '单轮长会话：同一裁剪集合重复调用结果一致')
    const copies = new Map()
    const copyOut = trimMessages(msgs, { trimmed: copies, projectedTokens: 100_000, threshold: 80_000, cacheCold: false })
    ok(JSON.stringify(ids(copyOut)) === JSON.stringify(cut1) && copies.size === first.size, '单轮长会话：同一份输入多次调用结果稳定')
    const grown = [...msgs, ...history(2).filter(m => m.role !== 'user').map(m => {
      const copy = structuredClone(m)
      if (copy.toolCallId) copy.toolCallId = `g${copy.toolCallId}`
      for (const p of copy.content ?? []) if (p.type === 'toolCall') p.id = `g${p.id}`
      return copy
    })]
    const out2 = trimMessages(grown, { trimmed: first, projectedTokens: 100_000, threshold: 80_000, cacheCold: false })
    const cut2 = ids(out2 ?? grown)
    ok(cut1.every(id => cut2.includes(id)), '单轮长会话：追加消息后裁剪边界只前移，已裁集合不回收')
  }

  {
    const user = { role: 'user', content: [{ type: 'text', text: '看图' }] }
    const step = (i, content, name = 'bash', args = { command: `cat f${i}` }) => [
      { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name, arguments: args }] },
      { role: 'toolResult', toolCallId: `c${i}`, toolName: name, content: Array.isArray(content) ? content : [{ type: 'text', text: content }] }
    ]
    const msgs = [user, ...step(1, [{ type: 'image', data: 'x', mimeType: 'image/png' }], 'read', { path: 'shot.png' }), ...Array.from({ length: 8 }, (_, k) => step(k + 2, 'x'.repeat(12_000))).flat()]
    const trimmed = new Map()
    const out = trimMessages(msgs, { trimmed, projectedTokens: 10_000, threshold: 8_000, cacheCold: false })
    ok(stubbed(out ?? []).includes('c1') && /1 image\b/.test(out.find(m => m.toolCallId === 'c1').content[0].text), '图片：单张图片按约 2.8k token 触发裁剪并用图片存根')
  }

  {
    const { mkdtempSync, readFileSync, rmSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'yan-trim-spill-'))
    try {
      const spill = mod.createSpiller(() => join(root, 's1'))
      const msgs = history(10)
      const out = trimMessages(msgs, { trimmed: new Map(), projectedTokens: 100_000, threshold: 80_000, spill })
      const stub = out.find((m) => m.toolCallId === 'c1').content[0].text
      const path = join(root, 's1', 'c1.txt')
      ok(stub.includes(`Full output: ${path}`) && /offset\/limit/.test(stub), '落盘：存根给出原文路径与按段读取提示', stub)
      ok(readFileSync(path, 'utf8') === big, '落盘：文件内容就是被裁掉的原文')
      if (process.platform !== 'win32') {
        const { statSync } = await import('node:fs')
        ok((statSync(path).mode & 0o777) === 0o600, '落盘：原文文件只给当前用户读写（0o600）')
      }
      rmSync(path)
      const again = trimMessages(msgs, { trimmed: new Map(stubbed(out).map(id => [id, 1])), projectedTokens: 10, threshold: 80_000, spill })
      ok(again.find((m) => m.toolCallId === 'c1').content[0].text === stub && existsSync(path), '落盘：文件丢失时按原文补写，存根逐字不变')
      const broken = mod.createSpiller(() => join(root, 'nul\0bad'))
      const fallback = trimMessages(msgs, { trimmed: new Map(), projectedTokens: 100_000, threshold: 80_000, spill: broken })
      const plain = fallback.find((m) => m.toolCallId === 'c1').content[0].text
      ok(!/Full output/.test(plain) && /Re-run the call/.test(plain), '落盘：写不进去时退回不带路径的存根', plain)
      ok(/[\\/]trimmed[\\/]a_b$/.test(mod.spillDir('a/b')) && /[\\/]trimmed[\\/]session$/.test(mod.spillDir('..')), '落盘：会话目录名只保留安全字符')
      const previousDataDir = process.env.YAN_DATA_DIR
      process.env.YAN_DATA_DIR = root
      ok(mod.spillDir('s') === join(root, 'trimmed', 's'), '落盘：溢写目录落在 YAN_DATA_DIR/trimmed（跟数据目录一起清理，不再堆在 %TEMP%）', mod.spillDir('s'))
      if (previousDataDir === undefined) delete process.env.YAN_DATA_DIR
      else process.env.YAN_DATA_DIR = previousDataDir
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
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

  const { mkdtempSync, mkdirSync, utimesSync, writeFileSync, rmSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const piDir = mkdtempSync(join(tmpdir(), 'yan-trim-pi-'))
  const fixtureSession = `yan-trim-test-${process.pid}-${Date.now()}`
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

    {
      const settings = (enabled) => writeFileSync(join(piDir, 'desktop.json'), JSON.stringify({ contextTrim: enabled, contextTrimTokens: 8000 }))
      settings(true)
      const user = (i) => ({ role: 'user', content: [{ type: 'text', text: `继续${i}` }] })
      const input = [...Array.from({ length: 9 }, (_, i) => turn(i + 1, 'x'.repeat(8400))).flat(), user(0)]
      const response = (id, stopReason = 'stop', tokens = 5600) => ({ role: 'assistant', timestamp: id, provider: 'fixture', model: 'fixture', stopReason, content: [{ type: 'text', text: '好' }], usage: { input: tokens, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: tokens + 20 } })
      const fixture = () => {
        const handlers = {}
        extension({ on: (name, fn) => (handlers[name] = fn) })
        const run = (messages, tokens, branch = []) => handlers.context({ messages }, { getContextUsage: () => ({ tokens, contextWindow: 1_000_000 }), sessionManager: { getBranch: () => branch, getSessionId: () => fixtureSession } })?.messages ?? messages
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

      const singleStep = (i, text) => [
        { role: 'assistant', content: [{ type: 'toolCall', id: `s${i}`, name: 'bash', arguments: { command: `cat s${i}` } }] },
        { role: 'toolResult', toolCallId: `s${i}`, toolName: 'bash', content: [{ type: 'text', text }] }
      ]
      const longSingle = [{ role: 'user', content: [{ type: 'text', text: '单轮长会话' }] }, ...Array.from({ length: 16 }, (_, i) => singleStep(i + 1, 'x'.repeat(8400))).flat()]
      settings(false)
      ok(stubbed(toggle.run(longSingle, 20000)).length === 0, '开关：关闭后单轮长会话也不裁')
      settings(true)
      ok(stubbed(toggle.run(longSingle, 20000)).length > 0, '开关：重新打开后单轮长会话恢复裁剪')

      const smallBatch = [...turn(1, 'x'.repeat(8000)), ...Array.from({ length: 3 }, (_, i) => turn(i + 2, 'short')).flat()]
      const capacity = fixture()
      ok(stubbed(capacity.run(smallBatch, 20000)).length === 0, '扩展装配：大窗口下小批次不改变请求前缀')
      const pressureOutput = capacity.handlers.context({ messages: smallBatch }, { getContextUsage: () => ({ tokens: 20000, contextWindow: 24000 }), sessionManager: { getSessionId: () => fixtureSession } })?.messages ?? smallBatch
      ok(stubbed(pressureOutput).length === 1, '扩展装配：实际窗口传给裁剪器，容量兜底可触发')

      for (const event of ['session_start', 'session_tree', 'session_compact']) {
        const f = fixture()
        f.run(input, 20000)
        f.handlers.message_end({ message: first })
        f.handlers[event]({})
        ok(stubbed(f.run(input, 1000)).length === 0, `${event}：清理旧存根与用量记录，复用调用ID不污染新上下文`)
      }

      const spillCleanup = fixture()
      spillCleanup.run(input, 20000)
      const spillDirectory = mod.spillDir(fixtureSession)
      ok(existsSync(join(spillDirectory, 'c1.txt')), '落盘：扩展把被裁原文写进本会话的临时目录')
      spillCleanup.handlers.session_start({})
      ok(!existsSync(spillDirectory), '会话开始：扩展自己清掉本会话的临时原文目录')
      const spillRoot = join(piDir, 'trimmed')
      const staleDir = join(spillRoot, 'stale-session')
      const freshDir = join(spillRoot, 'fresh-session')
      mkdirSync(staleDir, { recursive: true })
      mkdirSync(freshDir, { recursive: true })
      writeFileSync(join(staleDir, 'c1.txt'), 'old')
      writeFileSync(join(freshDir, 'c1.txt'), 'new')
      const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      utimesSync(staleDir, old, old)
      spillCleanup.handlers.session_start({})
      ok(!existsSync(staleDir) && existsSync(freshDir), '回收：会话开始时清揉7 天前的其他会话原文，近期的不动')
    }
  } finally {
    rmSync(mod.spillDir(fixtureSession), { recursive: true, force: true })
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
  const mod = await import('../resources/pi-extensions/context-trim.js')
  let passed = 0, failed = 0
  await runContextTrimTests((condition, label, detail) => {
    if (condition) passed++
    else { failed++; console.error(`FAIL ${label} ${detail ?? ''}`) }
  }, mod, limits)
  console.log(JSON.stringify({ passed, failed }))
  if (failed) process.exitCode = 1
}
