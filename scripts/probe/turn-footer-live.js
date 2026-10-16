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

      const all = store.getState().messages
      let lastUser = -1
      for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') { lastUser = i; break }
      const turnMsgs = all.slice(lastUser + 1).filter((m) => m.role === 'assistant')
      const cand = [...turnMsgs].reverse().find((m) => m.elapsedMs) ?? turnMsgs[turnMsgs.length - 1]
      const calls = turnMsgs.flatMap((m) => m.toolCalls ?? [])
      const articles = [...document.querySelectorAll('article.msg.assistant')]
      const lastArticle = articles[articles.length - 1]
      const domTools = Number(lastArticle?.getAttribute('data-tools') ?? '0')
      const domRows = lastArticle?.querySelectorAll('.trow').length ?? 0
      out.push(
        `  第 ${attempt} 次：消息字段工具 ${calls.length} 个（${calls.map((c) => `${c.name}:${c.status}`).join(', ') || '无'}）；DOM data-tools=${domTools} .trow=${domRows}`
      )
      if (calls.length >= 1 || attempt === 3) {
        asst = cand
        break
      }
    }

    ok(!!asst, '助手消息带 elapsedMs（主进程算过整轮）')
    if (!asst) return out.join('\n')

    const all = store.getState().messages
    let lastUser = -1
    for (let i = all.length - 1; i >= 0; i--) if (all[i].role === 'user') { lastUser = i; break }
    const turnMsgs = all.slice(lastUser + 1).filter((m) => m.role === 'assistant')
    asst = [...turnMsgs].reverse().find((m) => m.elapsedMs) ?? turnMsgs[turnMsgs.length - 1]
    ok(!!asst, '最后一轮里有助手消息')
    if (!asst) return out.join('\n')

    const tools = turnMsgs.flatMap((m) => m.toolCalls ?? [])
    {
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

    const footers = [...document.querySelectorAll('[data-testid="turn-footer"]')]
    const footer = footers[footers.length - 1]
    ok(!!footer, '最后一个回合有页脚')
    const text = footer?.textContent ?? ''
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

    const ub = q('[data-testid="usagebar"]')
    ok(!!ub, '用量条仍在（速度在用量条里单独表达）')
    const ubText = (ub?.textContent ?? '').replace(/\s+/g, ' ')
    ok(/\d/.test(ubText) && !ubText.includes('—'), `用量条给出数值而不是占位：「${ubText.slice(0, 60)}」`)

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
