/**
 * 额度区（右面板「额度」）在真实窗口里的两条验收：
 *
 *   ① Command Code 的**月度口径**：接口的 `credits.monthlyCredits` 是「本月剩余」，
 *      不是「已用」。搞反时面板会显示「本月已用 99.9%」，用户以为额度用完了
 *      （2026-09-21 用户报的就是这个）。这里走**真实链路**（真实凭证 → 主进程
 *      https → IPC → 渲染）读一遍，确认月份百分比是「几乎没用过」的量级。
 *   ② **颜色分级**：<70% 绿 / 70–95% 黄 / ≥95% 红。真实额度落不到 70 / 95
 *      这两个点上，所以这里只验「低用量 ⇒ 绿」这一端（真实渲染）；
 *      黄 / 红两端与两个边界由 `test:unit` 的 `quotaTone` 单测钉住，
 *      整套配色另有视觉矩阵截图。
 *
 * ⚠️ 为什么不进 `npm run check`：① 需要本机 pi 的 commandcode 凭证与网络，
 *    而且「本月已用不到一半」这条方向判据依赖当月真实用量。没有凭证时本场景
 *    打印 `~` 跳过（不算失败），但放进 check 会变成靠环境碰运气的红灯。
 */

;(async () => {
  const out = []
  /*
   * 探针的 ok 约定：带条件调（与其他探针的 `ok('文案')` 不同，这里统一成
   * test-unit 那种 `ok(条件, 文案)`）——输出里任何一行 `✗` 都会被 test-live 判失败。
   */
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
    /* H-3b：新会话默认停在「开始」页；额度分区在「工具」页。 */
    await sleep(300)
    document.querySelector('[data-testid="right-window-tab-tools"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const hasPanel = await until(() => q('[data-testid="rp-quota"]'), 6000)
    if (!hasPanel) ok(false, '右面板没有「额度」分区（工具布局把它隐藏了？）')

    /* ────────────────── ① 真实接口 ────────────────── */
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
        /*
         * ★ 方向断言：本月已用应当远小于总额度（本账号当月几乎没用过）。
         * 口径反了的时候它是 total − 0.0038 ≈ 99.99% —— 这条会立刻红。
         */
        ok(
          mo.used < mo.total * 0.5,
          '本月已用不到总额度的一半（口径没反 —— 反了会是 99.9%）',
          `used=${mo.used} / total=${mo.total}`
        )
      }
    }

    /* ────────────────── ② 面板渲染真实数据 ────────────────── */
    out.push('')
    out.push('=== 2. 面板显示的口径 ===')
    /*
     * 额度区查的是**当前会话模型**的供应商。测试环境里会话模型不一定是
     * commandcode，所以这里给 store 补一个最小会话壳（只改查询目标，
     * 不碰消息/统计）。这也是「真实渲染 + 真实数据」所需要的唯一前置。
     */
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
      const pctNum = Number(/已用\s*([\d.]+)%/.exec(pctText)?.[1])
      const expect = ((realMonthly.used / realMonthly.total) * 100).toFixed(1)
      ok(Math.abs(pctNum - Number(expect)) < 0.05, '面板上的本月百分比 = 接口算出来的值', `${pctText} vs ${expect}%`)
      const amount = q('[data-testid="quota-win-monthly-amount"]').textContent ?? ''
      info('月度数值行: ' + JSON.stringify(amount))
      ok(/剩余/.test(amount), '月度行同时给出「剩余」')
    }

    /* ────────────────── ③ 颜色（真实渲染） ────────────────── */
    out.push('')
    out.push('=== 3. 颜色分级：<70% 绿 / 70–95% 黄 / ≥95% 红 ===')
    const toneOf = (id) => {
      const el = q(`[data-testid="quota-win-${id}-pct"]`)
      if (!el) return 'missing'
      return el.className.includes('err') ? 'err' : el.className.includes('warn') ? 'warn' : 'ok'
    }
    if (!painted) {
      skip('面板没渲染出月度窗口 —— 跳过颜色断言')
    } else {
      /* 当前用量只有万分之几 → 三个窗口都该是绿（并且真的落到 --ok 上，不是默认灰） */
      const cssVar = (name) => {
        const probe = document.createElement('span')
        probe.style.color = 'var(' + name + ')'
        document.body.appendChild(probe)
        const v = getComputedStyle(probe).color
        probe.remove()
        return v
      }
      const okColor = cssVar('--ok')
      for (const id of ['fiveHour', 'weekly', 'monthly']) {
        const el = q(`[data-testid="quota-win-${id}-pct"]`)
        const cls = el?.className ?? ''
        const color = el ? getComputedStyle(el).color : 'missing'
        ok(toneOf(id) === 'ok', `${id} 用量很低 ⇒ 绿色档`, cls)
        ok(cls.includes('ok') && color === okColor, `${id} 的颜色就是 --ok（不是默认前景色）`, color)
      }
      const mainEl = q('[data-testid="quota-main-value"]')
      const mainCls = mainEl?.className ?? ''
      ok(!/err|warn/.test(mainCls), '主值也不着红 / 黄色（<70%）', JSON.stringify(mainCls))
      ok((mainEl ? getComputedStyle(mainEl).color : '') === okColor, '主值也是 --ok', mainEl?.className)
      ok(!!q('[data-testid="quota-win-monthly-estimated"]'), '月度窗口带「推算」徽标')
      info('黄 / 红两端由单测（quotaTone 的 70 / 95 边界）与视觉矩阵覆盖 —— 真实额度落不到那两个点上')
    }

    return out.join('\n')
  } catch (e) {
    out.push('  ✗ 探针异常：' + (e instanceof Error ? e.message : String(e)))
    return out.join('\n')
  }
})()
