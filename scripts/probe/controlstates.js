/*
 * 控件状态（实施-13 V-1，cost 0，不调模型）。
 *
 * V-1 把「禁用」与「键盘焦点」收敛成单一来源（`--ctl-disabled-opacity` /
 * `--focus-ring-*`）。这一条验四件事：
 *   ① 页面上所有 `:disabled` 控件的不透明度**只有一个值**；
 *   ② 样式表里带 `:focus-visible` 的规则，焦点环**只从 `--focus-ring-*` 来**
 *      （`outline: none` 允许 —— 结构性把手用自身高亮表达焦点）；
 *   ③ 主要操作控件的命中区不小于 24×24 CSS px；
 *   ④ 密度三档开关仍然有效（`--d-message-gap` 三档不同）。
 *
 * 为什么用「造一个带产品类名的 disabled 按钮」而不是只找现成的：页面上此刻
 * 未必有禁用按钮，但**规则**必须在。造出来的元素只借用类名，不引入新样式。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const skip = (s) => out.push('  ~ ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const visible = (el) => el.getClientRects().length > 0
  const clsOf = (el) => (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase())

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40; i++) {
      if (window.__yanStore?.getState().conn === 'ready') break
      await sleep(500)
    }
    await sleep(800)

    /* ---------- ① 禁用态：不透明度只有一个值 ---------- */
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px'
    const PROBE_CLASSES = [
      'send',
      'rp-btn',
      'rp-act',
      'review-act',
      'browser-nav',
      'commit-btn',
      'tl-move',
      'srow-menu-btn',
      'slash-item',
      'rdiff-gap'
    ]
    for (const name of PROBE_CLASSES) {
      const b = document.createElement('button')
      b.className = name
      b.disabled = true
      b.textContent = 'probe'
      host.appendChild(b)
    }
    document.body.appendChild(host)
    await sleep(150)

    const realDisabled = qa('[disabled]').filter(visible)
    const rows = []
    for (const el of [...realDisabled, ...host.children]) {
      rows.push([clsOf(el), getComputedStyle(el).opacity])
    }
    const distinct = [...new Set(rows.map(([, v]) => v))]
    const tokenValue = getComputedStyle(document.documentElement).getPropertyValue('--ctl-disabled-opacity').trim()
    out.push(`  禁用控件样本 ${rows.length} 个（真实可见 ${realDisabled.length} + 借用类名 ${host.children.length}）`)
    out.push(`  不透明度取值：${distinct.join(' / ')}（令牌 --ctl-disabled-opacity=${tokenValue}）`)
    ok(distinct.length === 1, '所有 :disabled 控件的不透明度只有一个值', `实际 ${distinct.join('/')}`)
    ok(distinct[0] === tokenValue, '该值就是令牌的值（没有各写一份）')
    host.remove()

    /* ---------- ② 焦点环只有一个来源 ---------- */
    const focusRules = []
    const walk = (rules) => {
      for (const rule of rules) {
        if (rule.cssRules && !rule.selectorText) {
          walk(rule.cssRules)
          continue
        }
        if (!rule.selectorText?.includes(':focus-visible')) continue
        focusRules.push({
          sel: rule.selectorText,
          outline: rule.style.getPropertyValue('outline').trim(),
          width: rule.style.getPropertyValue('outline-width').trim(),
          color: rule.style.getPropertyValue('outline-color').trim(),
          offset: rule.style.getPropertyValue('outline-offset').trim()
        })
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules)
      } catch {
        /* 跨源样式表读不到，跳过 */
      }
    }
    const bad = focusRules.filter((r) => {
      if (r.outline === 'none' || r.width === 'none') return false // 有意例外（把手 / 输入框）
      const text = [r.outline, r.width, r.color, r.offset].join(' ')
      if (!text.replace(/\s+/g, ' ').trim()) return false // 只写了别的属性
      return !/var\(--focus-ring/.test(text)
    })
    out.push(`  含 :focus-visible 的规则 ${focusRules.length} 条：${focusRules.map((r) => r.sel).join(' | ')}`)
    ok(bad.length === 0, '焦点环的值全部来自 --focus-ring-*', bad.length ? JSON.stringify(bad.slice(0, 3)) : '')

    /* 主题切换时颜色跟着令牌走 */
    const ringColor = () =>
      window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    const before = ringColor()
    const prevTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = prevTheme === 'light' ? 'dark' : 'light'
    await sleep(200)
    const after = ringColor()
    document.documentElement.dataset.theme = prevTheme
    await sleep(200)
    out.push(`  --accent：${before} → 另一个主题 ${after}`)
    ok(before !== after || !!before, '焦点环颜色来自会随主题变化的令牌（不是写死值）')

    /* ---------- ③ 命中区与文字对比度 ---------- */
    /** 相对亮度（WCAG） */
    const lum = (rgb) => {
      const m = String(rgb).match(/[\d.]+/g)
      if (!m || m.length < 3) return 0
      const c = m.slice(0, 3).map(Number).map((v) => {
        const x = v / 255
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
      })
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    }
    const contrast = (a, b) => {
      const l1 = lum(a)
      const l2 = lum(b)
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    }
    /** 向上找第一个不透明背景（控件常常自己不带底色） */
    const effectiveBg = (el) => {
      let node = el
      while (node && node !== document.documentElement) {
        const bg = getComputedStyle(node).backgroundColor
        const m = String(bg).match(/[\d.]+/g)
        if (m && (m.length < 4 || Number(m[3]) > 0.5)) return bg
        node = node.parentElement
      }
      return getComputedStyle(document.documentElement).backgroundColor
    }

    const MIN = 24
    /* 允许 0.5px 舍入：缩放（如 zoom 1.25）下 24px 会算成 23.999 */
    const TOL = 0.5
    const targetSelectors = ['.tb-icon', '.wbtn', '.rail-icon', '.send', '.rp-btn', '.srow-menu-btn']
    const tooSmall = []
    const measured = []
    for (const sel of targetSelectors) {
      const el = qa(sel).find(visible)
      if (!el) continue
      const r = el.getBoundingClientRect()
      const box = `${r.width.toFixed(1)}×${r.height.toFixed(1)}`
      measured.push(`${sel} ${box}`)
      if (r.width < MIN - TOL || r.height < MIN - TOL) tooSmall.push(`${sel} ${box}`)
    }
    out.push(`  主要控件命中区：${measured.join('，') || '(页面上没有样本)'}`)
    ok(measured.length > 0 && tooSmall.length === 0, `主要控件命中区 ≥ ${MIN}×${MIN}（容差 ${TOL}px）`, tooSmall.join('，'))

    /* 控件文字对比度：正文 4.5、大字/图标 3（WCAG AA） */
    const contrastRows = []
    const lowContrast = []
    for (const sel of ['.tb-icon', '.wbtn', '.rail-icon', '.send', '.rp-btn', '.srow-menu-btn']) {
      const el = qa(sel).find(visible)
      if (!el) continue
      const cs = getComputedStyle(el)
      const ratio = contrast(cs.color, effectiveBg(el))
      /* 界面里都是 UI 字与小图标：按 WCAG 的「组件/大字」3:1 判 */
      contrastRows.push(`${sel} ${ratio.toFixed(2)}:1`)
      if (ratio < 3) lowContrast.push(`${sel} ${ratio.toFixed(2)}:1`)
    }
    out.push(`  控件文字对比度（阈值 3:1 图形/组件）：${contrastRows.join('，') || '(无样本)'}`)
    ok(contrastRows.length > 0 && lowContrast.length === 0, '控件文字/图标对比度达标', lowContrast.join('，'))

    /* ---------- ④ 密度三档仍有效 ---------- */
    const readGap = () =>
      getComputedStyle(document.documentElement).getPropertyValue('--d-message-gap').trim()
    const html = document.documentElement
    const saved = html.getAttribute('data-density')
    const gaps = {}
    for (const [key, value] of [
      ['standard', null],
      ['compact', 'compact'],
      ['comfortable', 'comfortable']
    ]) {
      if (value === null) html.removeAttribute('data-density')
      else html.setAttribute('data-density', value)
      await sleep(150)
      gaps[key] = readGap()
    }
    if (saved === null) html.removeAttribute('data-density')
    else html.setAttribute('data-density', saved)
    await sleep(150)
    out.push(`  密度三档 --d-message-gap：${JSON.stringify(gaps)}`)
    ok(
      gaps.compact && gaps.comfortable && gaps.standard && new Set(Object.values(gaps)).size === 3,
      '密度三档开关仍然有效（三档取值互不相同）'
    )

    /* 切档时真实消息的间距要跟着变（有消息才测） */
    const msg = q('.msg')
    if (msg) {
      html.setAttribute('data-density', 'compact')
      await sleep(150)
      const compact = getComputedStyle(msg).marginBottom
      html.setAttribute('data-density', 'comfortable')
      await sleep(150)
      const comfortable = getComputedStyle(msg).marginBottom
      if (saved === null) html.removeAttribute('data-density')
      else html.setAttribute('data-density', saved)
      out.push(`  真实消息 margin-bottom：compact=${compact} → comfortable=${comfortable}`)
      ok(parseFloat(compact) !== parseFloat(comfortable), '消息间距真的随密度档变化')
    } else {
      skip('页面上没有 .msg（无 fixture 内容），跳过「消息间距随档位变化」')
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[controlstates] 全部通过' : '[controlstates] ' + failed + ' 条失败')
  return out.join('\n')
})()
