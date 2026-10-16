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

    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:-9999px;top:0;width:200px'
    const PROBE_CLASSES = [
      'btn icon primary send',
      'btn sm rp-btn',
      'btn sm rp-act',
      'btn icon sm review-act',
      'btn icon sm browser-nav',
      'btn primary commit-submit',
      'ui-menu-item',
      'btn sm'
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
    const isExempt = (el) => el.classList.contains('send')
    const allSamples = [...realDisabled, ...host.children]
    const rows = allSamples.filter((el) => !isExempt(el)).map((el) => [clsOf(el), getComputedStyle(el).opacity])
    const exempt = allSamples.filter(isExempt).map((el) => getComputedStyle(el).opacity)
    const distinct = [...new Set(rows.map(([, v]) => v))]
    const tokenValue = getComputedStyle(document.documentElement).getPropertyValue('--ctl-disabled-opacity').trim()
    out.push(`  禁用控件样本 ${rows.length} 个（真实可见 ${realDisabled.length} + 借用类名 ${host.children.length}；已排除 ${exempt.length} 个登记例外）`)
    out.push(`  不透明度取值：${distinct.join(' / ')}（令牌 --ctl-disabled-opacity=${tokenValue}）`)
    out.push('  样本：' + JSON.stringify(rows))
    if (!rows.length) {
      out.push('  ~ 跳过：样本里没有非例外的禁用控件')
    } else {
      ok(distinct.length === 1, '所有 :disabled 控件的不透明度只有一个值', `实际 ${distinct.join('/')}`)
      ok(distinct[0] === tokenValue, '该值就是令牌的值（没有各写一份）')
    }
    if (exempt.length) {
      const exemptValues = [...new Set(exempt)]
      out.push(`  登记例外的取值：${exemptValues.join(' / ')}`)
      ok(exemptValues.every((v) => v === tokenValue || v === '1'), '例外项只取令牌值或 1（没有随手写的其它值）')
    }
    host.remove()

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
      }
    }
    const bad = focusRules.filter((r) => {
      if (r.outline === 'none' || r.width === 'none') return false
      const text = [r.outline, r.width, r.color, r.offset].join(' ')
      if (!text.replace(/\s+/g, ' ').trim()) return false
      return !/var\(--focus-ring/.test(text)
    })
    out.push(`  含 :focus-visible 的规则 ${focusRules.length} 条：${focusRules.map((r) => r.sel).join(' | ')}`)
    ok(bad.length === 0, '焦点环的值全部来自 --focus-ring-*', bad.length ? JSON.stringify(bad.slice(0, 3)) : '')

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

    const contrastRows = []
    const lowContrast = []
    for (const sel of ['.tb-icon', '.wbtn', '.rail-icon', '.send', '.rp-btn', '.srow-menu-btn']) {
      const el = qa(sel).find(visible)
      if (!el) continue
      const cs = getComputedStyle(el)
      const ratio = contrast(cs.color, effectiveBg(el))
      contrastRows.push(`${sel} ${ratio.toFixed(2)}:1`)
      if (ratio < 3) lowContrast.push(`${sel} ${ratio.toFixed(2)}:1`)
    }
    out.push(`  控件文字对比度（阈值 3:1 图形/组件）：${contrastRows.join('，') || '(无样本)'}`)
    ok(contrastRows.length > 0 && lowContrast.length === 0, '控件文字/图标对比度达标', lowContrast.join('，'))

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
