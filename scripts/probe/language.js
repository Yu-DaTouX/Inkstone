/**
 * N16 语言提示：界面语言 → 模型输出语言（真实模型对照）。
 *
 * ── 这一版测什么（与上一版的区别）──
 * 语言要求以前是**启动参数**（`--append-system-prompt`），所以只能靠
 * 「切语言 → 重建 pi 实例 → 新建会话」生效；现在改成**内置扩展每轮注入**
 * （`resources/pi-extensions/language.js`：在最后一条用户消息前插一条独立
 * 消息 + 系统提示末尾保底），于是：
 *   ① 切语言**不重建**实例、不打断任何会话；
 *   ② **同一个会话**的下一轮就用新语言（不必新建会话）；
 *   ③ 注入**有没有发生**可以取证：跑本场景时 `YAN_LANG_EXT_LOG=<文件>`
 *      会让扩展每轮写一行 `{hook,lang,injected}`（见 test-live 的 language case）。
 *
 * ── 判据为什么是「多次尝试里出现过符合期望的一次」──
 * 语言是**软约束**：注入了不代表每次模型都照办（实测同一个模型在
 * 「界面英文 + 中文提问」时偶尔仍用中文；中文方向更稳）。所以这里：
 *   · 每个方向最多试 3 次，出现符合期望的就提前结束；
 *   · 把每一次的 CJK 占比与片段都打出来 —— 能看出是「稳定符合」还是「偶尔符合」；
 *   · 断言两个方向「最符合的那一次」方向相反（对照成立），而不是断言单次。
 * 机制本身的确定性由 `scripts/test-language-extension.mjs` 单测 + 上面的注入
 * 日志取证钉住。
 *
 * ⚠️ **推理（thinking）语言**单独报告、不作硬断言：模型可能「用英文想、用中文答」
 *    （实测这个模型就会），那是模型内部行为，不是注入没生效。
 *
 * 成本：约 4–8 次真实调用。
 */
;(async () => {
  const out = []
  const log = (s) => out.push(s)
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const info = (s) => out.push('  · ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(200)
    }
    return false
  }
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
  /** CJK 占比：判断"这段文字是中文还是英文"的粗口径（够用且不依赖分词） */
  const cjkRatio = (s) => {
    const chars = [...(s ?? '')].filter((c) => !/\s/.test(c))
    if (!chars.length) return 0
    return chars.filter((c) => /[\u3400-\u9fff]/.test(c)).length / chars.length
  }
  /*
   * 实例身份用 `createdAt` 而不是 `runId`：`runId` 是注册表里的序号
   * （`r1`/`r2`…），stopAll 之后重新 start 会**从 r1 重新数** —— 实测
   * 重建前后都是 `r1`，拿它当身份会得出"没有重建"的错误结论。
   */
  const primary = () => {
    const rs = store.getState().runners ?? []
    return rs.find((r) => r.active) ?? rs[0]
  }
  const instanceKey = (r) => (r ? `${r.runId}@${r.createdAt}` : 'none')
  const assistants = () => store.getState().messages.filter((m) => m.role === 'assistant' && (m.text || m.thinking))
  const last = () => assistants().slice(-1)[0]
  const send = async (text) => {
    const ta = q('[data-testid="composer"]')
    setVal(ta, text)
    await sleep(250)
    q('[data-testid="send"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  }
  const waitReply = async (before, ms = 120000) => {
    const done = await until(() => {
      const s = store.getState().session
      return assistants().length > before && !s?.isStreaming && !q('.cursor')
    }, ms)
    await sleep(600)
    return done
  }
  /** 问一轮，返回这一轮的回复/推理与 CJK 占比 */
  const ask = async (prompt) => {
    const before = assistants().length
    await send(prompt)
    const done = await waitReply(before)
    await sleep(300)
    const m = last()
    return {
      done,
      reply: m?.text ?? '',
      replyCjk: cjkRatio(m?.text),
      thinking: m?.thinking ?? '',
      thinkingCjk: m?.thinking ? cjkRatio(m.thinking) : null
    }
  }
  /**
   * 反复问同一个问题，直到某一次「符合期望」或有次数用尽。
   * `want` = 'zh' 希望中文（CJK > 0.5）｜'en' 希望英文（CJK < 0.2）
   */
  const askUntil = async (prompt, want, attempts = 3) => {
    const tried = []
    for (let i = 0; i < attempts; i++) {
      const r = await ask(prompt)
      if (!r.done) break
      tried.push(r)
      log(
        `  第 ${i + 1} 次：回复 CJK ${r.replyCjk.toFixed(2)}｜推理 ` +
          `${r.thinkingCjk === null ? '无' : r.thinkingCjk.toFixed(2)}｜${JSON.stringify(r.reply.slice(0, 60))}`
      )
      const good = want === 'zh' ? r.replyCjk > 0.5 : r.replyCjk < 0.2
      if (good) break
    }
    const best = want === 'zh' ? Math.max(0, ...tried.map((t) => t.replyCjk)) : Math.min(1, ...tried.map((t) => t.replyCjk))
    return { tried, best }
  }

  for (let i = 0; i < 60; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }
  if (store.getState().conn !== 'ready') return '✗ pi 未连上'
  store.getState().closeSettings?.()
  await sleep(300)

  const langBefore = store.getState().settings?.lang ?? 'zh-CN'
  const zhQuestion = '用一句话说明什么是 RAII。不要调用任何工具。'
  const enQuestion = 'In one sentence, what is RAII? Do not call any tools.'

  /* ---------------- 1. 中文界面：英文提问 → 中文回复 ---------------- */
  log('=== 1. 中文界面：英文提问应当回中文 ===')
  if (langBefore !== 'zh-CN') {
    await store.getState().patchSettings({ lang: 'zh-CN' })
    await until(() => store.getState().settings?.lang === 'zh-CN', 10000)
  }
  await store.getState().newSession({ scope: 'global' })
  await sleep(1500)
  const instZh = primary()
  const zh = await askUntil(enQuestion, 'zh')
  ok(zh.tried.length > 0, '中文界面拿到了回复', `${zh.tried.length} 次尝试`)
  ok(zh.best > 0.5, '中文界面：英文提问也回中文', `最好的一次 CJK=${zh.best.toFixed(2)}`)

  /* ---------------- 2. 切英文：不重建、同一会话下一轮生效 ---------------- */
  log('\n=== 2. 切英文界面：不重建实例、同一会话下一轮生效 ===')
  const instBefore = primary()
  const msgsBefore = store.getState().messages.length
  await store.getState().patchSettings({ lang: 'en-US' })
  await sleep(4000)
  ok(
    primary()?.createdAt === instBefore?.createdAt,
    '切语言没有重建 pi 实例（扩展每轮注入，不再靠重启）',
    `${instanceKey(instBefore)} → ${instanceKey(primary())}`
  )
  ok(primary()?.conn === 'ready' && store.getState().conn === 'ready', '切语言后连接仍是 ready')
  ok(store.getState().messages.length === msgsBefore, '切语言没有丢当前会话的消息', `${store.getState().messages.length}/${msgsBefore}`)
  ok(store.getState().settings?.lang === 'en-US', '设置里的语言已落盘', String(store.getState().settings?.lang))
  log(`  实例仍是 ${instanceKey(instZh)}（与第 1 节同一个）`)
  const en = await askUntil(zhQuestion, 'en')
  ok(en.tried.length > 0, '英文界面拿到了回复（同一会话，没有新建）', `${en.tried.length} 次尝试`)
  ok(en.best < 0.2, '英文界面：中文提问也回英文', `最好的一次 CJK=${en.best.toFixed(2)}`)
  ok(en.best < zh.best, '两个方向的最符合期望的一次方向相反（对照成立）', `${zh.best.toFixed(2)} vs ${en.best.toFixed(2)}`)

  /* ---------------- 3. 推理语言：只报告，不硬断言 ---------------- */
  log('\n=== 3. 推理（思考过程）语言（只报告）===')
  const zhThink = zh.tried.map((t) => t.thinkingCjk).filter((v) => v !== null)
  const enThink = en.tried.map((t) => t.thinkingCjk).filter((v) => v !== null)
  if (!zhThink.length && !enThink.length) {
    info('这个模型这两轮都没返回推理内容（thinking），看不到推理语言')
  } else {
    info(`中文界面这几次的推理 CJK：${zhThink.map((v) => v.toFixed(2)).join(', ') || '无'}`)
    info(`英文界面这几次的推理 CJK：${enThink.map((v) => v.toFixed(2)).join(', ') || '无'}`)
    info('模型可能「用英文想、按界面语言答」—— 这是模型内部行为，不作硬断言')
  }

  /* ---------------- 4. 流式期间切语言：不打断，且下一轮立刻生效 ---------------- */
  log('\n=== 4. 流式中切语言：不打断这一轮，下一轮立刻生效 ===')
  const instStream = primary()
  const beforeCount = assistants().length
  await send('数到五，每次只输出一个数字，中间不要换行。不要调用任何工具。')
  const streaming = await until(() => store.getState().session?.isStreaming === true, 30000)
  ok(streaming, '这一轮真的进入了流式')
  await store.getState().patchSettings({ lang: 'zh-CN' })
  await sleep(300)
  ok(store.getState().session?.isStreaming === true, '切语言的瞬间没有把正在生成的回合掐断')
  let replaced = false
  for (let i = 0; i < 12 && store.getState().session?.isStreaming; i++) {
    await sleep(400)
    if (instanceKey(primary()) !== instanceKey(instStream)) {
      replaced = true
      break
    }
  }
  ok(!replaced, '流式期间实例没有被换掉（根本不重启）', instanceKey(primary()))
  const finished = await waitReply(beforeCount)
  ok(finished, '这一轮切换后仍然正常结束')
  const afterStream = await askUntil(enQuestion, 'zh')
  ok(afterStream.tried.length > 0, '流式后的下一轮拿到了回复')
  log(`  流式后实例 ${instanceKey(primary())}`)
  ok(afterStream.best > 0.5, '切回中文后**下一轮**就用中文（不用等实例重建）', `最好的一次 CJK=${afterStream.best.toFixed(2)}`)

  /* 收尾：语言恢复（后面的场景别被留在英文） */
  if (store.getState().settings?.lang !== langBefore) {
    await store.getState().patchSettings({ lang: langBefore })
    await until(() => store.getState().settings?.lang === langBefore, 15000)
    log(`\n  收尾：语言恢复 ${langBefore}`)
  }
  return out.join('\n')
})()
