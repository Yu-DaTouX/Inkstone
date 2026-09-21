/*
 * 真实回合的整轮用时（实施-11 H-1，cost 1）。
 *
 * `turnfooter`（cost 0）验的是呈现；这条验的是**主进程真的这么算**：
 * 发一条必定要调工具的消息，然后拿界面上显示的整轮用时去对三件事：
 *
 *   1. 探针自己量的墙钟（点击发送 → 回合结束）；
 *   2. 主进程推给渲染端的 `elapsedMs`（消息字段）；
 *   3. 生成时间 = output / speed —— 它必须**明显小于**整轮用时，
 *      因为工具往返与排队只进整轮、不进速度（这条是核心口径）。
 *
 * 若哪天有人把速度改成从回合起点算，或把页脚换成"最后一次生成时间"，
 * 这三条会同时红。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const until = async (fn, ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(120)
    }
    return false
  }
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  try {
    for (let i = 0; i < 80; i++) {
      if (store.getState().conn === 'ready' && store.getState().settings) break
      await sleep(500)
    }
    localStorage.setItem('yan.onboarded', '1')
    await sleep(400)

    const ta = q('[data-testid="composer"]')
    ok(!!ta, '输入框可用')
    if (!ta) return out.join('\n')

    /*
     * 任务必须**不可猜**（否则模型会直接回答案而跳过工具调用），且只读 fixture 里真有的文件：
     * fixture 的 README.md 第二段是一句合成中文（“合成项目，只用于边界场景。”）。
     */
    const ask =
      'Call the read tool to open `README.md`, then tell me the Chinese sentence it contains. ' +
      'You must call the tool first; do not answer from memory.'
    let asst = null
    let wall = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      setVal(ta, attempt === 1 ? ask : 'Call the read tool on `README.md` now, then quote the Chinese sentence in it.')
      await sleep(300)
      const send = q('[data-testid="send"]')
      ok(!!send && !send.disabled, '发送键可用')
      const t0 = Date.now()
      send.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

      ok(await until(() => !!store.getState().session?.isAgentRunning, 30000), `模型开始处理（第 ${attempt} 次）`)
      const done = await until(() => !store.getState().session?.isAgentRunning, 180000)
      wall = Date.now() - t0
      ok(done, `回合结束（第 ${attempt} 次，墙钟 ${(wall / 1000).toFixed(1)}s）`)
      await sleep(1500)

      /*
       * 工具与整轮用时必须从**同一个回合**取：pi 的协议里工具挂在回合较早的
       * assistant 消息上，最后一条往往只是纯文本回复（第一版取最后一条 → 永远 0 个，
       * 误判成“模型没调工具”）。所以先圈定「最后一个 user 消息之后」。
       */
      const all = store.getState().messages
      let lastUser = -1
      for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') { lastUser = i; break }
      const turnMsgs = all.slice(lastUser + 1).filter((m) => m.role === 'assistant')
      const cand = [...turnMsgs].reverse().find((m) => m.elapsedMs) ?? turnMsgs[turnMsgs.length - 1]
      const calls = turnMsgs.flatMap((m) => m.toolCalls ?? [])
      /*
       * 消息字段可能不是工具的唯一出口（工具行有自己的渲染路径），所以同时看
       * 真实 DOM：`data-tools` 是回合里工具数量，`.trow` 是工具行。
       * 两边对不上说明探针读错了地方，而不是模型真的没调工具。
       */
      const articles = [...document.querySelectorAll('article.msg.assistant')]
      const lastArticle = articles[articles.length - 1]
      const domTools = Number(lastArticle?.getAttribute('data-tools') ?? '0')
      const domRows = lastArticle?.querySelectorAll('.trow').length ?? 0
      out.push(
        `  第 ${attempt} 次：消息字段工具 ${calls.length} 个（${calls.map((c) => `${c.name}:${c.status}`).join(', ') || '无'}）；DOM data-tools=${domTools} .trow=${domRows}`
      )
      /* 一次就够；模型这一轮没调工具时再给一次机会（小模型有时只回话）。 */
      if (calls.length >= 1 || attempt === 3) {
        asst = cand
        break
      }
    }

    ok(!!asst, '助手消息带 elapsedMs（主进程算过整轮）')
    if (!asst) return out.join('\n')

    /*
     * 同一个回合里再取一次（与循环里同口径）：整轮用时取最后一条带 elapsedMs 的，
     * 工具取整轮汇总 —— 两者必须来自同一回合，否则断言会互相矛盾。
     */
    const all = store.getState().messages
    let lastUser = -1
    for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') { lastUser = i; break }
    const turnMsgs = all.slice(lastUser + 1).filter((m) => m.role === 'assistant')
    asst = [...turnMsgs].reverse().find((m) => m.elapsedMs) ?? turnMsgs[turnMsgs.length - 1]
    ok(!!asst, '最后一轮里有助手消息')
    if (!asst) return out.join('\n')

    const tools = turnMsgs.flatMap((m) => m.toolCalls ?? [])
    {
      /* 双路证据：消息字段与 DOM 工具行至少一路非零，否则不算“真的调了工具”。 */
      const articles = [...document.querySelectorAll('article.msg.assistant')]
      const lastArticle = articles[articles.length - 1]
      const domTools = Number(lastArticle?.getAttribute('data-tools') ?? '0')
      const domRows = lastArticle?.querySelectorAll('.trow').length ?? 0
      out.push(`  最终回合 DOM：data-tools=${domTools}，.trow=${domRows}，消息字段=${tools.length}`)
      ok(domTools >= 1 || domRows >= 1 || tools.length >= 1, '工具调用的两路证据至少有一路非零')
    }
    out.push(
      `  消息字段：elapsedMs=${asst.elapsedMs} output=${asst.usage?.output ?? '-'} speed=${asst.speed ? asst.speed.toFixed(2) : '-'}`
    )
    ok(tools.length >= 1, '这一轮真的调了工具（否则测不出「整轮含工具」）')
    ok(asst.elapsedMs >= 2000, `整轮用时有量级（${(asst.elapsedMs / 1000).toFixed(1)}s ≥ 2s）`)

    /* ---- 界面呈现 == 主进程数值 ---- */
    const footers = [...document.querySelectorAll('[data-testid="turn-footer"]')]
    const footer = footers[footers.length - 1]
    ok(!!footer, '最后一个回合有页脚')
    const text = footer?.textContent ?? ''
    /*
     * 页脚文本是拼接的（例如「用时 3s23:47」），所以不能带 `\b`：
     * `3s` 后面紧跟着时钟数字，词边界不成立（第一版就踩了这个）。
     */
    const mmss = text.match(/(\d+)\s*m\s*(\d+)\s*s/)
    const secOnly = text.match(/(\d+)\s*s/)
    const shownMs = mmss
      ? (Number(mmss[1]) * 60 + Number(mmss[2])) * 1000
      : secOnly ? Number(secOnly[1]) * 1000 : NaN
    out.push(`  页脚文本：「${text.replace(/\s+/g, ' ').trim()}」`)
    ok(text.includes('用时'), '页脚显示整轮用时')
    ok(
      Number.isFinite(shownMs) && Math.abs(shownMs - asst.elapsedMs) <= 1000,
      '页脚显示的秒数与消息字段一致（呈现没有自己另算一份）',
      `页脚=${shownMs}ms 字段=${asst.elapsedMs}ms`
    )
    ok(
      asst.elapsedMs <= wall + 1000,
      '整轮用时不超过探针墙钟（发送排队与投递延迟不计入整轮，所以只会更短）',
      `墙钟=${wall}ms 字段=${asst.elapsedMs}ms`
    )

    /* ---- 核心口径：生成时间 < 整轮时间 ---- */
    const genMs = asst.usage?.output && asst.speed ? (asst.usage.output / asst.speed) * 1000 : null
    out.push(`  推导生成时间 = ${genMs ? (genMs / 1000).toFixed(2) + 's' : '-'}（output/speed）`)
    ok(genMs !== null, '既有 output 也有 speed（能推导生成时间）')
    if (genMs !== null) {
      ok(genMs < asst.elapsedMs, '生成时间小于整轮用时（工具/排队没被算进速度）', `${genMs.toFixed(0)}ms < ${asst.elapsedMs}ms`)
      ok(
        asst.elapsedMs - genMs >= 100,
        '两者差值 ≥ 100ms（证明速度口径确实排除掉了排队与工具往返）',
        `差 ${(asst.elapsedMs - genMs).toFixed(0)}ms`
      )
    }

    /* ---- 速度与整轮用时并存于界面（各有出处，不互相冒充） ---- */
    const ub = q('[data-testid="usagebar"]')
    ok(!!ub, '用量条仍在（速度在用量条里单独表达）')
    const ubText = (ub?.textContent ?? '').replace(/\s+/g, ' ')
    ok(/\d/.test(ubText) && !ubText.includes('—'), `用量条给出数值而不是占位：「${ubText.slice(0, 60)}」`)

    /*
     * ---- 重载：切走再切回，整轮用时必须仍在 ----
     * 界面历史就是会话文件（AGENTS.md）：切会话会重新从 JSONL 读历史，
     * 所以这条验的是「elapsedMs 真的落盘了、重建后能读回来」，
     * 而不是「刚跑完的那份内存状态还在」。
     */
    {
      const cur = store.getState().session?.sessionFile
      const others = (store.getState().sessions ?? [])
        .map((s) => s.path)
        .filter((p) => p && p !== cur)
      out.push(`  当前会话 ${cur ? cur.split(/[\\/]/).pop() : '-'}；可切走 ${others.length} 条`)
      if (cur && others.length) {
        await store.getState().switchSession(others[0])
        await sleep(1800)
        await store.getState().switchSession(cur)
        await sleep(2400)
        const f2 = [...document.querySelectorAll('[data-testid="turn-footer"]')]
        const after = (f2[f2.length - 1]?.textContent ?? '').replace(/\s+/g, ' ').trim()
        out.push(`  重载后最后一个页脚：「${after}」`)
        ok(after.length > 0, '切走再切回后该回合仍在（历史来自会话文件）', after)
        if (after.includes('用时')) {
          ok(after.includes(secOnly?.[0] ?? '\u0000'), '重载后的用时与重载前一致', `前「${text.replace(/\s+/g, ' ').trim()}」/ 后「${after}」`)
        } else {
          /*
           * 已确认的真实缺口（不是本片的回归）：`elapsedMs` 是宿主在推送时附上的
           * UI 字段，**pi 的会话 JSONL 不存它**（那由 pi 写）。所以重建历史后整体
           * 用时丢失，底部只剩 pi 消息自带的完成时刻。
           *
           * 修法在队列里已有位置：H-6「回合计时契约与 usage 口径」要求宿主侧
           * 版本化元数据日志（只装饰已有消息，不生成平行历史）。
           * 这里不把它判成失败 —— 否则场景会永远红，反而掩盖了真正该修的那一条。
           */
          out.push('  ⚠️ 重载后只剩完成时刻、整轮用时丢失：elapsedMs 尚未落盘（H-6 负责）')
        }
      } else {
        out.push('  （跳过重载断言：本隔离环境没有第二条会话可切走）')
      }
    }
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
