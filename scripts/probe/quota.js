;(async () => {
  const out = []
  const ok = (cond, label, extra = '') => out.push((cond ? '  ✓ ' : '  ✗ ') + label + (extra ? '  ' + extra : ''))
  const info = (m) => out.push('  · ' + m)
  const skip = (m) => out.push('  ~ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(300)
      } else await sleep(150)
    }
    if (!store.getState().settings?.rightPanelOpen) await store.getState().toggleRightPanel()
    await sleep(300)
    document.querySelector('[data-testid="right-window-tab-start"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const hasPanel = await until(() => q('[data-testid="rp-quota"]'), 6000)
    if (!hasPanel) ok(false, '右面板没有「额度」分区（工具布局把它隐藏了？）')

    out.push('')
    out.push('=== 1. 真实接口（只读，不打桩）===')
    const real = await window.yan.providerQuota('commandcode')
    info('raw=' + JSON.stringify(real).slice(0, 420))
    let realMonthly = null
    if (real.error) {
      skip('读不到真实额度（' + real.error + '）—— 需要本机 pi 的 commandcode 凭证，跳过真实数据断言')
    } else {
      const wins = real.windows ?? []
      const mo = wins.find((w) => w.id === 'monthly')
      const fh = wins.find((w) => w.id === 'fiveHour')
      ok(wins.length >= 2, '至少拿到 5 小时 / 每周两个官方窗口', wins.map((w) => w.id).join(', '))
      ok(!!fh, '有 5 小时窗口')
      if (!mo) {
        ok(false, '没有月度窗口（weekly.cap 或 monthlyCredits 缺失）—— 月度是这次要看的重点')
      } else {
        realMonthly = mo
        ok(mo.total > 0 && Number.isFinite(mo.used), '月度窗口的 used/total 都是数字', `${mo.used} / ${mo.total}`)
        ok(mo.used >= 0 && mo.used <= mo.total + 1e-9, '本月已用在 [0, 总额度] 区间内（不是负数、不越界）')
        ok(mo.estimated === true, '月度上限被标为「推算」（接口没有官方月额度字段）')
        ok(
          Math.abs(real.remaining - Math.max(0, mo.total - mo.used)) < 1e-6,
          '主值 remaining 与月度窗口的 total − used 自洽'
        )
        ok(
          mo.used < mo.total * 0.9,
          '本月已用不到总额度的九成（口径没反 —— 反了会是 99.9%）',
          `used=${mo.used} / total=${mo.total}`
        )
      }
    }

    out.push('')
    out.push('=== 2. 面板显示的口径 ===')
    const before = store.getState().session?.model?.provider ?? ''
    if (before !== 'commandcode') {
      const s = store.getState().session
      store.setState({
        session: {
          ...(s ?? {}),
          sessionId: s?.sessionId ?? 'quota-probe',
          thinkingLevel: s?.thinkingLevel ?? 'medium',
          availableThinkingLevels: s?.availableThinkingLevels ?? [],
          isStreaming: false,
          isCompacting: false,
          model: { provider: 'commandcode', id: 'commandcode/probe' }
        }
      })
      info('会话 provider 从 ' + JSON.stringify(before) + ' 改为 commandcode（探针前置）')
      await sleep(500)
    }
    const painted = await until(() => q('[data-testid="quota-win-monthly-pct"]'), 15_000)
    if (!painted) {
      skip('面板没渲染出月度窗口（真实查询失败时界面会只留错误行）—— 跳过渲染断言')
    } else if (realMonthly) {
      const pctText = q('[data-testid="quota-win-monthly-pct"]').textContent ?? ''
      const pctNum = Number(/([\d.]+)%/.exec(pctText)?.[1])
      const expect = ((realMonthly.used / realMonthly.total) * 100).toFixed(1)
      ok(Math.abs(pctNum - Number(expect)) < 0.05, '面板上的本月百分比 = 接口算出来的值', `${pctText} vs ${expect}%`)
      const amount = q('[data-testid="quota-win-monthly-amount"]').textContent ?? ''
      const amountTip = q('[data-testid="quota-win-monthly-amount"]').getAttribute('title') ?? ''
      info('月度数值行: ' + JSON.stringify(amount) + ' / 悬停: ' + JSON.stringify(amountTip))
      ok(amount.includes('/'), '月度行写「已用 / 总额」')
      const leftText = Math.max(0, realMonthly.total - realMonthly.used).toFixed(2)
      ok(amountTip.includes(leftText), '剩余额度放在月度数值的悬停提示里', leftText)
    }

    out.push('')
    out.push('=== 3. 颜色分级：<70% 正常 / 70–95% 黄 / ≥95% 红 ===')
    const toneOf = (id) => {
      const el = q(`[data-testid="quota-win-${id}-pct"]`)
      if (!el) return 'missing'
      return el.className.includes('err') ? 'err' : el.className.includes('warn') ? 'warn' : 'ok'
    }
    if (!painted) {
      skip('面板没渲染出月度窗口 —— 跳过颜色断言')
    } else {
      const cssVar = (name) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(' + name + ')'
        document.body.appendChild(probe)
        const v = getComputedStyle(probe).color
        probe.remove()
        return v
      }
      const fgColor = cssVar('--fg')
      const accentColor = cssVar('--accent')
      for (const id of ['fiveHour', 'weekly', 'monthly']) {
        const el = q(`[data-testid="quota-win-${id}-pct"]`)
        const cls = el?.className ?? ''
        const color = el ? getComputedStyle(el).color : 'missing'
        ok(toneOf(id) === 'ok', `${id} 用量很低 ⇒ 正常档`, cls)
        ok(cls.includes('ok') && color === fgColor, `${id} 的百分比用前景色（不是绿色）`, color)
        const fill = el?.parentElement?.querySelector('.rp-meter > i')
        ok(!!fill && getComputedStyle(fill).backgroundColor === accentColor, `${id} 的条用强调色`)
      }
      ok(!q('[data-testid="quota-main-value"]'), '有分窗口时不重复显示主值')
      ok(!!q('[data-testid="quota-win-monthly-estimated"]'), '月度窗口带「推算」徽标')
      info('黄 / 红两端由单测（quotaTone 的 70 / 95 边界）与视觉矩阵覆盖 —— 真实额度落不到那两个点上')
    }

    return out.join('\n')
  } catch (e) {
    out.push('  ✗ 探针异常：' + (e instanceof Error ? e.message : String(e)))
    return out.join('\n')
  }
})()
