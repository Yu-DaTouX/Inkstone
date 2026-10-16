;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const q = (s) => document.querySelector(s)

  const parseColor = (value) => {
    const str = String(value || '').trim()
    const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(str)
    if (srgb) {
      return {
        r: Number(srgb[1]) * 255,
        g: Number(srgb[2]) * 255,
        b: Number(srgb[3]) * 255,
        a: srgb[4] === undefined ? 1 : Number(srgb[4])
      }
    }
    const m = str.match(/[\d.]+/g)
    if (!m || m.length < 3) return null
    return {
      r: Number(m[0]),
      g: Number(m[1]),
      b: Number(m[2]),
      a: m.length >= 4 ? Number(m[3]) : 1
    }
  }
  const luma = (rgba, fallback = 0) =>
    rgba ? (rgba.r * 0.299 + rgba.g * 0.587 + rgba.b * 0.114) / 255 : fallback

  for (let i = 0; i < 80; i++) {
    if (store.getState().conn === 'ready') break
    await sleep(500)
  }

  document.documentElement.dataset.theme = 'light'
  try {
    localStorage.setItem('yan.theme', 'light')
  } catch {
  }
  await sleep(500)

  const cats = store.getState().sessions.filter((s) => (s.messageCount ?? 0) > 2).slice(0, 12)
  let picked = false
  for (const s of cats) {
    await store.getState().switchSession(s.path)
    await sleep(1600)
    const spans = document.querySelectorAll('.md pre code span[class*="hljs"]')
    if (spans.length > 0) {
      picked = true
      if (q('.tool-head')) break
    }
  }
  if (!picked) {
    for (const s of cats) {
      await store.getState().switchSession(s.path)
      await sleep(1200)
      if (q('.md pre code')) break
    }
  }

  out.push('=== 1. 代码块：背景必须跟着主题走 ===')
  const code = q('.md pre code')
  if (code) {
    const bg = getComputedStyle(code).backgroundColor
    const lum = luma(parseColor(bg))
    out.push(`  pre code bg = ${bg}（亮度 ${lum.toFixed(2)}）`)
    ok(lum > 0.6, `浅色主题下代码块是**浅底**（亮度 ${lum.toFixed(2)}，> 0.6）`)
  } else {
    out.push('  （这份会话里没有代码块，跳过）')
  }

  out.push('')
  out.push('=== 2. 语法高亮真的生效 ===')
  const hl = document.querySelector('.md pre code')
  if (hl) {
    const spans = hl.querySelectorAll('span[class*="hljs"]')
    out.push('  hljs span 数 = ' + spans.length)
    if (spans.length === 0) {
      out.push('  ⚠️ 这份 fixture 的代码块没被识别出语言（detect 下会保持纯文本），跳过')
    } else {
      ok(true, 'code.hljs 里有语法 span（旧实现恒为 0 —— 高亮完全没生效）')

      const base = getComputedStyle(hl).color
      const colored = [...spans].filter((s) => getComputedStyle(s).color !== base)
      out.push(`  与底色不同的 span: ${colored.length}/${spans.length}`)
      ok(colored.length > 0, '至少一种 token 上了色')
      out.push('  样例色: ' + [...new Set(colored.slice(0, 5).map((s) => getComputedStyle(s).color))].join(' '))
    }
  } else {
    out.push('  （无代码块，跳过）')
  }

  out.push('')
  out.push('=== 3. 行内代码与工具行在浅色下读得清 ===')
  const inline = q('.prose code:not(pre code)')
  if (inline) {
    const c = getComputedStyle(inline)
    out.push(`  inline code color=${c.color} bg=${c.backgroundColor}`)
    ok(c.color !== 'rgb(0, 0, 0)' || c.backgroundColor !== 'rgba(0, 0, 0, 0)', '行内代码有独立配色')
  } else {
    out.push('  （无行内代码，跳过）')
  }

  const head = q('.trow-head')
  out.push('  工具行: ' + (head ? '有' : '无'))
  if (head) {
    const col = getComputedStyle(head).color
    const lum = luma(parseColor(col), 1)
    out.push(`  .trow-head color=${col}（亮度 ${lum.toFixed(2)}）`)
    ok(lum < 0.75, `工具行文字够深（亮度 ${lum.toFixed(2)}，< 0.75）`)
  } else {
    out.push('  ⚠️ 这份 fixture 里没有工具调用，跳过工具行的对比度断言')
  }

  out.push('')
  out.push('=== 4. 导航轨在浅色下有对比 ===')
  const bar = q('.outline-bar')
  if (bar) {
    const c = getComputedStyle(bar)
    out.push(`  .outline-bar bg=${c.backgroundColor} opacity=${c.opacity}`)
    ok(Number(c.opacity) >= 0.9, `浅色主题下导航轨不透明（实际 ${c.opacity}）`)
  } else {
    out.push('  （当前会话轮数不足，无导航轨）')
  }

  out.push('')
  out.push('=== 5. 终端窗口：内部的深色覆盖必须真的生效 ===')
  if (!q('.term')) {
    await store.getState().patchSettings({ toolDetail: true })
    await sleep(400)
    q('.trow-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(600)
  }
  const term = q('.term')
  if (!term) {
    out.push('  ⚠️ 这份 fixture 里没渲染出终端窗口，跳过')
  } else {
    const TERM_LUMA = 12 / 255
    const lumOn = (el, prop) => {
      const rgba = parseColor(getComputedStyle(el)[prop])
      if (!rgba) return null
      const ch = (c) => (c / 255) * rgba.a + TERM_LUMA * (1 - rgba.a)
      return ch(rgba.r) * 0.299 + ch(rgba.g) * 0.587 + ch(rgba.b) * 0.114
    }
    const termLum = lumOn(term, 'backgroundColor')
    out.push(`  .term bg=${getComputedStyle(term).backgroundColor}（亮度 ${termLum?.toFixed(2)}）`)
    ok(termLum !== null && termLum < 0.25, `终端窗口本身是深底（亮度 ${termLum?.toFixed(2)} < 0.25）`)

    const inner = [...term.querySelectorAll('.tool-pre, .tool-result, .term-body, .term-prompt, .tool-empty')]
    const cls = (el) => '.' + String(el.className).split(/\s+/).join('.')
    const bright = inner.filter((el) => {
      const l = lumOn(el, 'backgroundColor')
      return l !== null && l > 0.5
    })
    out.push(
      `  内部元素 ${inner.length} 个，亮底的 ${bright.length} 个` +
        (bright.length ? '：' + bright.map(cls).join(', ') : '')
    )
    ok(bright.length === 0, '终端内部没有亮底元素（深色覆盖确实生效）')

    const lightBorder = inner.filter((el) => {
      const cs = getComputedStyle(el)
      if (parseFloat(cs.borderBottomWidth) <= 0) return false
      const l = lumOn(el, 'borderBottomColor')
      return l !== null && l > 0.6
    })
    out.push(`  内部带浅色下边框的 ${lightBorder.length} 个` + (lightBorder.length ? '：' + lightBorder.map(cls).join(', ') : ''))
    ok(lightBorder.length === 0, '终端内部没有浅色下边框（不透明的那种）')
  }

  out.push('')
  out.push('=== 6. 浅色主题下不该出现「深色块」（终端除外）===')
  const DARK_BOX_MIN_AREA = 5000
  const darkBoxesIn = (root, label) => {
    if (!root) {
      out.push(`  ${label}: (节点不存在)`)
      return []
    }
    const hits = []
    for (const el of root.querySelectorAll('*')) {
      if (el.closest('.term')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width * rect.height < DARK_BOX_MIN_AREA) continue
      const rgba = parseColor(getComputedStyle(el).backgroundColor)
      if (!rgba) continue
      if (rgba.a < 0.9) continue
      const l = (rgba.r * 0.299 + rgba.g * 0.587 + rgba.b * 0.114) / 255
      if (l < 0.25) {
        hits.push(
          `.${String(el.className).split(/\s+/).filter(Boolean).join('.')}(${Math.round(rect.width)}×${Math.round(rect.height)},${l.toFixed(2)})`
        )
      }
    }
    out.push(`  ${label}: ${hits.length} 个${hits.length ? ' → ' + hits.slice(0, 6).join(' ') : ''}`)
    return hits
  }

  const dark = [
    ...darkBoxesIn(q('.rail'), '左栏'),
    ...darkBoxesIn(q('.center'), '中栏'),
    ...darkBoxesIn(q('[data-testid="rightpanel"]'), '右栏')
  ]

  store.getState().openSettings('appearance')
  await sleep(700)
  const darkSettings = darkBoxesIn(q('.settings'), '设置面板')
  store.getState().closeSettings()
  await sleep(300)

  ok(dark.length + darkSettings.length === 0, '浅色主题下没有意外的深色块')

  {
    const pseudoAnim = (sel) => {
      try {
        return String(getComputedStyle(document.documentElement, sel).animationName || '')
      } catch {
        return ''
      }
    }
    const liveNames = () =>
      [pseudoAnim('::view-transition-new(root)'), pseudoAnim('::view-transition-old(root)')].filter(
        (n) => n && n !== 'none'
      )
    const settle = async () => {
      await sleep(1000)
      for (let i = 0; i < 40 && liveNames().length; i++) await sleep(50)
    }

    const kick = async (next, expect) => {
      await settle()
      window.dispatchEvent(new CustomEvent('yan:theme', { detail: next }))
      let names = []
      for (let i = 0; i < 50; i++) {
        const now = liveNames()
        if (now.includes(expect)) {
          names = now
          break
        }
        if (now.length) names = now
        await sleep(30)
      }
      return { next, names, sawExpect: names.includes(expect), dir: document.documentElement.dataset.themeDir }
    }

    out.push(
      `  过渡能力：startViewTransition=${typeof document.startViewTransition}、` +
        `reduced-motion=${window.matchMedia('(prefers-reduced-motion: reduce)').matches}`
    )

    const expectOf = (t) => (t === 'dark' ? 'theme-spread' : 'theme-collapse')
    const runs = []
    for (const next of ['dark', 'light', 'dark', 'light']) runs.push(await kick(next, expectOf(next)))
    const darkRuns = runs.filter((r) => r.next === 'dark' && r.names.includes('theme-spread'))
    const lightRuns = runs.filter((r) => r.next === 'light' && r.names.includes('theme-collapse'))
    const dirs = (list) => list.map((r) => r.dir).join('/') || '—'

    ok(
      darkRuns.length > 0 && lightRuns.length > 0,
      `两个方向都真的触发了 View Transition（${runs.map((r) => r.next + ':' + (r.names.join('+') || '无')).join(' / ')}）`
    )
    ok(darkRuns.length > 0, '切到深色跑的是**向外晕开**（theme-spread）')
    ok(lightRuns.length > 0, '切到浅色跑的是**向心收拢**（theme-collapse）')
    ok(
      darkRuns.length > 0 && darkRuns.every((r) => r.dir === 'out'),
      `切到深色 → 方向 out（新层从中心向外晕开，实际 ${dirs(darkRuns)}）`
    )
    ok(
      lightRuns.length > 0 && lightRuns.every((r) => r.dir === 'in'),
      `切到浅色 → 方向 in（旧层从外缘向中心收拢，实际 ${dirs(lightRuns)}）`
    )

    const cssText = [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules].map((rule) => rule.cssText)
        } catch {
          return []
        }
      })
      .join('\n')
      .replace(/\s+/g, ' ')
    ok(
      /view-transition-new\(root\)[^}]{0,160}theme-spread/.test(cssText) && cssText.includes('760ms'),
      '向外扩散挂在**新层**上，且时长是 760ms（比原来的 380ms 慢一截）'
    )
    ok(
      /view-transition-old\(root\)[^}]{0,160}theme-collapse/.test(cssText),
      '向心收拢挂在**旧层**上（新层不动，否则两层一起动会糊）'
    )

    {
      const root = document.documentElement
      const bg = () => root.style.getPropertyValue('--bg-0') || '∅'
      const savedPreset = store.getState().settings?.backgroundPreset ?? 'default'
      await settle()
      await store.getState().patchSettings({ backgroundPreset: 'ink' })
      await sleep(300)
      window.dispatchEvent(new CustomEvent('yan:theme', { detail: 'light' }))
      await settle()

      const seen = { atCall: null, early: null, inUpdate: null }
      const raw = document.startViewTransition
      const orig = raw.bind(document)
      let armed = true
      document.startViewTransition = (cb) => {
        if (!armed) return orig(cb)
        armed = false
        seen.atCall = { theme: root.dataset.theme, bg: bg() }
        queueMicrotask(() => {
          seen.early = bg()
        })
        return orig(() => {
          cb()
          seen.inUpdate = { theme: root.dataset.theme, bg: bg() }
        })
      }
      window.dispatchEvent(new CustomEvent('yan:theme', { detail: 'dark' }))
      for (let i = 0; i < 60 && seen.inUpdate === null; i++) await sleep(30)
      document.startViewTransition = raw

      ok(
        seen.atCall?.theme === 'light' && seen.inUpdate?.theme === 'dark',
        `换主题时 data-theme 走过渡的更新回调（调用瞬间 ${seen.atCall?.theme} → 回调内 ${seen.inUpdate?.theme}）`
      )
      ok(
        seen.atCall && seen.early === seen.atCall.bg,
        `旧快照之前不先改背景令牌（要留旧底色：调用瞬间 ${seen.atCall?.bg} → 同轮任务末 ${seen.early}）`
      )
      ok(
        seen.inUpdate && seen.inUpdate.bg !== seen.atCall?.bg,
        `回调里背景令牌跟着新主题重算（${seen.atCall?.bg} → ${seen.inUpdate?.bg}）`
      )
      await store.getState().patchSettings({ backgroundPreset: savedPreset })
      await settle()
    }

    const clipAt = (selector) => {
      try {
        return String(getComputedStyle(document.documentElement, selector).clipPath || '')
      } catch {
        return ''
      }
    }

    const boxOf = (selector) => {
      try {
        const cs = getComputedStyle(document.documentElement, selector)
        const t = cs.transform === 'none' ? '∅' : cs.transform
        return `${selector.split('::')[1]} ${cs.width}×${cs.height} @ ${cs.top},${cs.left} tf=${t}`
      } catch (err) {
        return `${selector} 读不到（${err.message}）`
      }
    }
    const geometry = () => [
      `视口 ${window.innerWidth}×${window.innerHeight} dpr=${window.devicePixelRatio} vv=${window.visualViewport?.width}×${window.visualViewport?.height}@${window.visualViewport?.offsetTop}`,
      `  ${boxOf('::view-transition(root)')}`,
      `  ${boxOf('::view-transition-group(root)')}`,
      `  ${boxOf('::view-transition-image-pair(root)')}`,
      `  ${boxOf('::view-transition-new(root)')}`,
      `  ${boxOf('::view-transition-old(root)')}`
    ]
    const clipAny = () => {
      const fresh = clipAt('::view-transition-new(root)')
      if (fresh.includes('circle(')) return fresh
      const old = clipAt('::view-transition-old(root)')
      return old.includes('circle(') ? old : ''
    }
    const readClip = async (pseudo) => {
      for (let i = 0; i < 240; i++) {
        const now = pseudo ? clipAt(pseudo) : clipAny()
        if (now.includes('circle(')) return now
        await sleep(50)
      }
      return ''
    }

    const reachTheme = async (value) => {
      for (let i = 0; i < 4 && document.documentElement.dataset.theme !== value; i++) {
        window.dispatchEvent(new CustomEvent('yan:theme', { detail: value }))
        await settle()
        await sleep(600)
      }
      return document.documentElement.dataset.theme === value
    }

    const originOf = (clip) => {
      const m = /at\s+([\d.]+)(px|%)\s+([\d.]+)(px|%)/.exec(clip || '')
      if (!m) return null
      const axis = (v, unit, total) => (unit === '%' ? (Number(v) / 100) * total : Number(v))
      return { x: axis(m[1], m[2], window.innerWidth), y: axis(m[3], m[4], window.innerHeight) }
    }
    const onPoint = (clip, ...points) => {
      const o = originOf(clip)
      if (!o) return false
      return points.some((p) => Math.abs(o.x - p.x) < 1 && Math.abs(o.y - p.y) < 1)
    }
    const centerOf = (el) => {
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
    const show = (p) => (p ? `x=${p.x.toFixed(1)} y=${p.y.toFixed(1)}` : '—')

    const clickTheme = async (which) => {
      const button = document.querySelector(`[data-testid="theme-${which}"]`)
      const pseudo = which === 'light' ? '::view-transition-old(root)' : '::view-transition-new(root)'
      if (!button) return { clicked: false, want: '', clip: '', rect: null, vars: '' }
      await settle()
      const rect = button.getBoundingClientRect()
      const want = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      button.click()
      const clip = await readClip(pseudo)
      if (!clip) {
        out.push('  [几何]', ...geometry())
        const samples = []
        for (let i = 0; i < 8; i++) {
          samples.push(`new=${clipAt('::view-transition-new(root)') || '∅'}|old=${clipAt('::view-transition-old(root)') || '∅'}`)
          await sleep(120)
        }
        out.push(`  ✗ 未读到 ${which} 的动画（theme=${document.documentElement.dataset.theme}）`)
        for (const line of samples) out.push(`    ${line}`)
      }
      const style = document.documentElement.style
      return {
        clicked: true,
        want: show(want),
        wantPoint: want,
        clip,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        vars: `${style.getPropertyValue('--theme-origin-x') || '∅'} / ${style.getPropertyValue('--theme-origin-y') || '∅'}`
      }
    }

    store.getState().openSettings('appearance')
    await sleep(700)
    ok(await reachTheme('light'), '先把主题切到浅色，作为起点')
    const toDark = await clickTheme('dark')
    ok(toDark.clicked, '设置面板里有主题按钮（data-testid=theme-dark）')
    ok(
      toDark.clicked && onPoint(toDark.clip, toDark.wantPoint),
      `切到深色的圆心落在按钮中心（要 ${toDark.want}，实际 ${show(originOf(toDark.clip))}；clip=${toDark.clip || '没读到'}）`
    )
    const toLight = await clickTheme('light')
    ok(
      toLight.clicked && onPoint(toLight.clip, toLight.wantPoint),
      `切到浅色的圆心也落在按钮中心（要 ${toLight.want}，实际 ${show(originOf(toLight.clip))}；` +
        `按钮 ${JSON.stringify(toLight.rect)}，变量 ${toLight.vars}）`
    )

    const themeBtnCenters = ['theme-dark', 'theme-light']
      .map((id) => document.querySelector(`[data-testid="${id}"]`))
      .filter(Boolean)
      .map((el) => centerOf(el))
    window.dispatchEvent(new CustomEvent('yan:theme', { detail: 'dark' }))
    const fromDom = await readClip('::view-transition-new(root)')
    ok(
      onPoint(fromDom, ...themeBtnCenters),
      `事件载荷没带位置时，从 DOM 找回主题按钮（要 ${themeBtnCenters.map(show).join(' 或 ')}，实际 ${show(originOf(fromDom))}）`
    )

    store.getState().closeSettings()
    for (let i = 0; i < 40 && document.querySelector('[data-testid^="theme-"]'); i++) await sleep(50)
    await settle()
    window.dispatchEvent(new CustomEvent('yan:theme', { detail: 'light' }))
    const centered = await readClip('::view-transition-old(root)')
    ok(
      onPoint(centered, { x: window.innerWidth / 2, y: window.innerHeight / 2 }),
      `没有按钮可依时回退屏幕中心（实际 ${show(originOf(centered))}，clip=${centered || '没读到'}）`
    )
    await settle()

    const before = store.getState().settings?.uiScale ?? 0
    await window.yan.setUiScale(1.25)
    await sleep(1500)
    store.getState().openSettings('appearance')
    await sleep(700)
    ok(await reachTheme('light'), '缩放前把主题归位到浅色')
    const zoomed = await clickTheme('dark')
    out.push(`  缩放 ${window.devicePixelRatio} 下的圆心：${zoomed.clip || '没读到'}`)
    ok(
      zoomed.clicked && onPoint(zoomed.clip, zoomed.wantPoint),
      `缩放 125% 下圆心仍在按钮中心（要 ${zoomed.want}，实际 ${show(originOf(zoomed.clip))}；按钮 ${JSON.stringify(zoomed.rect)}）`
    )
    store.getState().closeSettings()
    await window.yan.setUiScale(before)
    await sleep(1200)
  }

  document.documentElement.dataset.theme = 'dark'
  try {
    localStorage.setItem('yan.theme', 'dark')
  } catch {
  }

  return out.join('\n')
})()
