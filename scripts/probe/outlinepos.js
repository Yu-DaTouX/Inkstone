/**
 * 导航轨与**消息列**的对齐（用户报的「侧边隐藏时导航轨位置错位」）。
 *
 * 根因：内容列是 max-width: var(--w-stream) **居中**的。
 *   · 左栏展开 → 中栏 877 < 900 → 内容满宽，导航轨（钉在中栏左缘）刚好贴上
 *   · 左栏收起 → 中栏 1139 > 900 → 内容居中右移 ~120px，导航轨不动 → 错位
 * 所以判据不能是「离中栏左缘多少」（那本来就会变），
 * 而是**收起/展开时「刻度到正文」的距离必须稳定**（实测 4.8px，修复前 110px）。
 */
;(async () => {
  const out = []
  const ok = (m) => out.push('  ✓ ' + m)
  const bad = (m) => out.push('  ✗ ' + m)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const R = (sel) => {
    const e = document.querySelector(sel)
    if (!e) return null
    const r = e.getBoundingClientRect()
    return { x: +r.x.toFixed(1), right: +r.right.toFixed(1), w: +r.width.toFixed(1) }
  }
  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) { const c = document.querySelector('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent)); if (b) { click(b); await sleep(300) } else await sleep(150) }
    store.getState().setRailPinned(true)
    await sleep(600)
    /*
     * 导航轨要 ≥3 轮才渲染（少于它就只是噪声）。
     * 直接注入 4 轮消息 —— 不依赖 fixture 会话（那还得先切会话，脆弱）。
     */
    const fake = []
    for (let i = 1; i <= 4; i++) {
      fake.push({ id: 'u' + i, role: 'user', text: '第 ' + i + ' 个问题' })
      fake.push({ id: 'a' + i, role: 'assistant', text: '第 ' + i + ' 个回答' + 'x'.repeat(60) })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    await sleep(1200)
    out.push('  注入 4 轮后 .outline 存在=' + !!document.querySelector('.outline'))

    /** 导航轨的刻度是否贴在消息列的左边（而不是中栏的左边） */
    const check = async (label) => {
      const oc = R('.outline')
      const inner = R('.stream-inner')
      const center = R('.center')
      if (!oc || !inner || !center) { bad(label + '：量不到元素'); return }
      // 量**看得见的那条刻度**的右缘（不是命中区/容器的左缘）
      const tick = R('.outline-hit .outline-bar')
      const gap = tick ? +(inner.x + 24 - tick.right).toFixed(1) : NaN
      out.push(`  ${label}: center.x=${center.x} inner.x=${inner.x} outline.x=${oc.x} bar.x=${tick ? tick.x : '?'} → 刻度右缘距正文 ${gap}px`)
      /*
       * 判据：刻度右缘到正文左缘的距离应该**与中栏宽度无关**（一个固定的小值）。
       * 内容居中时这个距离会变成上百 px —— 那就是用户报的错位。
       */
      return gap
    }

    const g1 = await check('左栏展开')
    store.getState().setRailPinned(false)
    await sleep(900)
    const g2 = await check('左栏收起')
    /*
     * 真正要保证的性质：**收起/展开时刻度与正文的距离不变**。
     * 之前是 2px → 112px（差 110），所以用户一眼看出错位。
     * 绝对距离是多少不重要（它在内边距的空隙里就行），关键是**稳定**。
     */
    if (Number.isFinite(g1) && Number.isFinite(g2)) {
      const d = Math.abs(g1 - g2)
      out.push('  两态距离差 ' + d.toFixed(1) + 'px（展开 ' + g1 + ' / 收起 ' + g2 + '）')
      if (d <= 12) ok('收起/展开时刻度与正文的相对位置稳定')
      else bad('两态错位 ' + d.toFixed(1) + 'px')
      if (g1 >= 6 && g1 <= 34 && g2 >= 6 && g2 <= 34) ok('刻度落在正文左侧的空隙里（不压字）')
      else bad('刻度离正文太远/太近：' + g1 + ' / ' + g2)
    }
    store.getState().setRailPinned(true)
    await sleep(600)
  } catch (e) { bad('抛异常：' + (e && e.message ? e.message : String(e))) }
  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[outlinepos] 全部通过' : '[outlinepos] ' + failed + ' 条失败')
  return out.join('\n')
})()
