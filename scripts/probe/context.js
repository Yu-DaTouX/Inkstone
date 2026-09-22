/**
 * 上下文分区（右栏第一块）的可观测行为。
 *
 * 两个真实 bug 的回归网：
 *   ① 手动压缩后 pi 会把 contextUsage.tokens/percent 报文 **null**
 *      （latestCompaction 之后没有新 usage）。旧代码 `?? 0` 把它显示成
 *      「0 tokens / 0.0%」——看起来像进度丢了。现在必须显示「—」+ 提示。
 *   ② 累计花费那一行要与其它 rp-kv 一样「标注靠左、数值靠右」（对齐）。
 *   ③ 主值的分母是**工作集**还是**物理窗口**（N21-3）：两个视角都由
 *      `session.contextPolicy` 是否存在决定。这里两个视角各注入一次，
 *      因为“界面上的数”必须与“砚用来判断的数”是同一个。
 *
 * 这个探针**不花 token**：直接往 store 注入 stats（与会话状态）。
 * ⚠️ 注入 stats 时必须让 `contextPolicy` 与它一致：真实运行时
 *    stats.contextWindow 与工作集预算是同一个模型的窗口 —— 只换 stats
 *    不换 policy 会造出应用自己产生不了的状态（旧版就踩过这个坑）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const store = window.__yanStore

  localStorage.setItem('yan.onboarded', '1')
  for (let i = 0; i < 25; i++) {
    const c = q('.ob-card')
    if (!c) break
    const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
    if (b) {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await sleep(250)
    } else await sleep(120)
  }
  await sleep(600)
  store.getState().closeSettings?.()
  await sleep(200)

  const sec = q('[data-testid="rp-context"]')
  if (!sec) return '✗ 找不到上下文分区'
  // 确保展开
  const head = sec.querySelector('button')
  if (head && head.getAttribute('aria-expanded') === 'false') {
    head.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(200)
  }

  /* ---- ① 压缩后：tokens = null ---- */
  out.push('=== 1. 压缩后（tokens=null）不显示成 0 ===')
  store.setState({
    stats: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      contextUsage: { tokens: null, contextWindow: 262144, percent: null },
      toolCalls: 0,
      userMessages: 0,
      assistantMessages: 0
    }
  })
  await sleep(300)
  /*
   * 方案 7.3 改版后主行是 `.rp-ctx-main`：
   *   「上下文 49% …… 128k / 262k」
   * （旧版是 `.rp-context-summary` 的「128,000 tokens / 48.8% 已用」）
   */
  const sum1 = q('[data-testid="rp-context"] .rp-ctx-main')?.textContent ?? ''
  out.push('  摘要: ' + JSON.stringify(sum1))
  ok(sum1.includes('—'), '摘要里是「—」而不是 0')
  ok(!/0\s*(tokens|k)/.test(sum1), '没有出现「0 tokens」')
  ok(!!q('[data-testid="ctx-unknown"]'), '出现「已压缩 · 下一条消息后重新统计」提示')

  /* ---- ② 正常：有数字（物理窗口视角：没有工作集策略时） ---- */
  out.push('')
  out.push('=== 2. 物理窗口视角（没有工作集策略）===')
  const budget = {
    contextWindow: 262144,
    responseReserve: 32000,
    safetyMargin: 8000,
    workingSet: 183501,
    triggers: { sweep: 128451, fold: 155976, compact: 183501 },
    /* min(90% × 262144, 262144 − 32000) —— 与生产公式一致，别在 fixture 里留旧值 */
    emergency: 229376
  }
  store.setState({
    /*
     * 分母优先取**模型能力**里的窗口（`RightPanel` 的 `win`），所以 fixture 必须
     * 把模型窗口也钉住：只改 `stats.contextUsage` 的话，真实模型的窗口
     * （当前测试模型是 1M）会盖掉这里的 262144，断言变成“看环境的脸色”。
     */
    session: {
      ...store.getState().session,
      contextPolicy: undefined,
      model: { ...(store.getState().session?.model ?? {}), contextWindow: 262144 }
    },
    stats: {
      tokens: { input: 12, output: 34, cacheRead: 0, cacheWrite: 0, total: 46 },
      cost: 0.1234,
      contextUsage: { tokens: 128000, contextWindow: 262144, percent: 48.8 },
      toolCalls: 0,
      userMessages: 0,
      assistantMessages: 0
    }
  })
  await sleep(300)
  const sum2 = q('[data-testid="rp-context"] .rp-ctx-main')?.textContent ?? ''
  const tokensLine = q('[data-testid="ctx-tokens"]')?.textContent ?? ''
  out.push('  摘要: ' + JSON.stringify(sum2) + ' / tokens 行: ' + JSON.stringify(tokensLine))
  ok(tokensLine.includes('128k') && tokensLine.includes('262k'), '显示「128k / 262k」（方案 7.3 的写法）')
  ok(sum2.includes('49%'), '显示 49%（整数百分比）')
  ok(!q('[data-testid="ctx-unknown"]'), '有数字时不显示“已压缩”提示')
  ok(q('[data-testid="ctx-main"]')?.getAttribute('data-mode') === 'window', 'data-mode=window（没有工作集时不假装有）')
  ok(!q('[data-testid="ctx-stage-mark"]'), '物理窗口视角不画工作集刻度')

  /* ---- ②b 工作集视角（N21-3）：同一份用量，换个分母 ---- */
  out.push('')
  out.push('=== 2b. 工作集视角：分母与百分比都换掉 ===')
  store.setState({
    session: {
      ...store.getState().session,
      contextPolicy: { enabled: true, kinds: ['tool-sweep', 'recall', 'compaction'], budget }
    }
  })
  await sleep(300)
  const sum3 = q('[data-testid="rp-context"] .rp-ctx-main')?.textContent ?? ''
  const tokensLine3 = q('[data-testid="ctx-tokens"]')?.textContent ?? ''
  const wsLine = q('[data-testid="ctx-working-set-line"]')?.textContent ?? ''
  out.push(
    '  摘要: ' +
      JSON.stringify(sum3) +
      ' / tokens 行: ' +
      JSON.stringify(tokensLine3) +
      ' / 工作集行: ' +
      JSON.stringify(wsLine)
  )
  /*
   * C-5（2026-09-22）改了分母口径：主值分母是**有效模型窗口**，工作集单独一行。
   * 旧断言要求「同样的 128k，分母换成工作集」是改版前的设计 —— 留着它
   * 只会永远假红（`128k / 240k = 100%` 会被读成「1M 模型满了」）。
   */
  ok(tokensLine3.includes('128k') && tokensLine3.includes('262k'), '主值分母仍是有效模型窗口 262k（C-5）')
  ok(sum3.includes('49%'), '主百分比按窗口算（128/262 ≈ 49%，C-5）')
  ok(wsLine.includes('128k') && wsLine.includes('184k'), '工作集单独一行：128k / 184k')
  ok(wsLine.includes('70%'), '工作集行的百分比按工作集算（128/183.5 ≈ 70%）')
  ok(q('[data-testid="ctx-main"]')?.getAttribute('data-mode') === 'working-set', 'data-mode=working-set')
  ok(qa('[data-testid="ctx-stage-mark"]').length === 3, '进度条上有三条阶段刻度')
  ok(!!q('[data-testid="ctx-next-stage"]'), '有「下一步」说明行')

  /* ---- ③ 详情默认收起，展开后有累计花费且对齐 ---- */
  out.push('')
  out.push('=== 3. 详情折叠与累计花费对齐 ===')
  ok(!q('[data-testid="ctx-details"]'), '详情默认收起（方案 7.3：调参项移进详情）')
  q('[data-testid="ctx-details-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(250)
  ok(!!q('[data-testid="ctx-details"]'), '点「详情」后展开')
  const cost = q('[data-testid="ctx-cost"]')
  ok(!!cost, '详情里有累计花费行')
  if (cost) {
    const k = cost.querySelector('.rp-k')
    const v = cost.querySelector('.rp-v')
    const kr = k.getBoundingClientRect()
    const vr = v.getBoundingClientRect()
    const cr = cost.getBoundingClientRect()
    out.push(
      `  cost.left=${Math.round(cr.left)} label.left=${Math.round(kr.left)} value.right=${Math.round(vr.right)} cost.right=${Math.round(cr.right)}`
    )
    ok(kr.left - cr.left < 2, '标注贴左')
    ok(cr.right - vr.right < 2, '数值贴右')
  }
  /* 收尾：折叠回去，不给后面的场景留展开态 */
  q('[data-testid="ctx-details-toggle"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await sleep(150)

  return out.join('\n')
})()
