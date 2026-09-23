/**
 * 浅色主题：对比度 / 代码高亮 / 工具行。
 *
 * 用户报「白色背景下渲染有问题」。查出来的两个真 bug：
 *   ① highlight.css 的选择器被一次全局替换搞坏了
 *      （`.hljs` → `.md pre code`，于是成了 `pre code.md pre code-keyword`
 *       这种无意义选择器）—— 语法高亮**一条规则都没匹配上**，
 *       `code.hljs` 里的 `span[class^="hljs"]` 数量恒为 0。
 *   ② 主题里写死了 `background:#0d1117`（深色）—— 浅色主题下就变成
 *      「白页面上一个黑框」，框里还是浅色字。
 *
 * 这个场景把这两条钉住。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const q = (s) => document.querySelector(s)

  /*
   * 颜色解析。
   *
   * `color-mix()` / `oklab()` 这类颜色在 computed style 里会序列化成
   * `color(srgb r g b)`（0–1 的小数，且第一个词就是字面的 `srgb`）。
   * 用 `match(/\d+/g)` 去抽数字会把 `srgb` 里的 0 当成红色通道，
   * 于是浅色面板被读成纯黑（2026-09-23 实际误报过 `.goal-panel`）。
   * 所以两种写法都显式支持。
   */
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

  /* ---- 切到浅色 ---- */
  document.documentElement.dataset.theme = 'light'
  try {
    localStorage.setItem('yan.theme', 'light')
  } catch {
    /* ignore */
  }
  await sleep(500)

  /* ---- 找一条既带**可高亮代码块**、又带工具调用的消息 ----
     注意：不是每个 ``` 代码块都会被 highlight.js 识别出语言。
     `detect: true` 下无语言的块会保持纯文本（0 个 hljs span）——
     那种块不能用来断言「高亮生效」。 */
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
    // 退而求其次：至少找一条有代码块的（后续断言会自己降级）
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

      // 至少有一个 span 的颜色与容器不同 —— 否则「有 span 但没上色」
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

  /*
   * ⚠️ 选择器是 `.trow-head`（ToolRow 重构后的名字）。
   *    这里原来写的是已废弃的 `.tool-head` / `.tool-sum` —— 选择器永远
   *    匹配不到，断言于是**静默走了「跳过」分支**，工具行的对比度其实
   *    一直没人看着（与 sessions 探针的悬停断言同一类失效方式）。
   */
  const head = q('.trow-head')
  out.push('  工具行: ' + (head ? '有' : '无'))
  if (head) {
    // 浅色下的可读性标准：颜色不能是“黑的不彻底、浅的不明显”
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
  /*
   * 设计上终端「无论浅色/深色都是深底」（见 chat.css 里 .term 的注释），
   * 内部把 `--bg-*` / `--border` 这些主题令牌都覆盖成深底上的颜色。
   *
   * 但那组覆盖规则曾经**全线失效**：`.term .tool-pre` 与 `.tool-pre.args`
   * 同为 (0,2,0)，而它写在前面 —— 后写者赢。于是浅色主题下终端里的参数块
   * 成了白底（--bg-0）+ 浅色下边框（--border）+ 中灰字，基本看不清。
   * 深色主题下 --bg-0 与 #0c0c0c 接近，所以只有浅色能暴露它。
   */
  if (!q('.term')) {
    /*
     * 已结束的工具默认收起，而且 `detailOn` 关着时**连展开入口都没有**
     * （`canExpand = detailOn || running || failed`，见 ToolRow）。
     * fixture 里的工具都是成功结束的，所以先把设置打开再点行头。
     */
    await store.getState().patchSettings({ toolDetail: true })
    await sleep(400)
    q('.trow-head')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(600)
  }
  const term = q('.term')
  if (!term) {
    out.push('  ⚠️ 这份 fixture 里没渲染出终端窗口，跳过')
  } else {
    /*
     * 把颜色**合成到终端深底上**再算亮度。
     *
     * 为什么不直接看声明值：终端里很多颜色是半透明的，而且是刻意如此 ——
     * `.term-prompt` 的 `rgba(255,255,255,0.08)` 分隔线、`.term .diff` 的
     * 提亮底色。它们在深底上叠出来仍然很暗，不构成「亮底」。
     * 直接看声明值就得写 alpha 特判，而合成之后这些情况自然就落到暗端。
     */
    const TERM_LUMA = 12 / 255 // .term 的 #0c0c0c
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
  /*
   * 这一节是那类 bug 的**泛化**：主题令牌被写死成深色时，浅色主题下就是
   * 「白页面上一个黑框」（本文件头那两个 bug 都是这么来的；后来终端里
   * 那个白底是同一族的反向情况）。
   *
   * 终端是**刻意**深色的（chat.css 里写明了「无论浅色/深色都是深底」），
   * 所以排除 `.term` 子树；代码块走 `--code-bg`，浅色主题下本来就是浅的。
   *
   * 只查**不透明**的背景（alpha ≥ 0.9）：半透明的压暗层/阴影要与祖先
   * 合起来才有意义（如 modal 的 scrim）。
   *
   * 小面积也跳过：按钮/指示条用深色填充是常见设计 —— 发送键就是
   * `--fg` 实心 + 白图标（30×30），导航轨的视口条在浅色下也是 `--fg`。
   * 这里要抓的是**成片**的深色背景，那才是「白页面上的黑框」。
   */
  /** 小于这个面积（px²）的深色块当设计，不算「黑框」（≈ 70×70） */
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

  /* ---- 主题切换的方向与时长（DESIGN §5）----
     必须走**真实入口**（设置面板改主题 dispatch 的就是 `yan:theme`）：
     方向标记是 App 的 effect 写的，直接改 `dataset.theme` 验不到它。 */
  {
    /*
     * 读**过渡伪元素**的动画名。
     * `document.getAnimations()` 看不到 View Transition 的伪元素树（实测总数为 0 条 theme-*），
     * 而 `getComputedStyle(el, '::view-transition-new(root)')` 在过渡进行中是可读的 ——
     * 它验的也正是“我们定义的那条动画真的应用上了”。
     */
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
    /* 上一次过渡要跑 760ms，没结束就读伪元素会读到**上一次**的动画名（实测误判过）。 */
    const settle = async () => {
      for (let i = 0; i < 40; i++) {
        if (!liveNames().length) return
        await sleep(30)
      }
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

    /*
     * 四次（dark → light → dark → light）：本文件前面是**直接改 dataset**
     * 验证浅色渲染的，App 的 theme state 未必与之一致 —— 万一某次 dispatch
     * 的值就是当前 state，那一次不会产生过渡。四次能保证两个方向都真的跑到。
     */
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
  }

  /* ---- 恢复深色，别把用户设置改了（隔离目录里其实无所谓，但保持一致）---- */
  document.documentElement.dataset.theme = 'dark'
  try {
    localStorage.setItem('yan.theme', 'dark')
  } catch {
    /* ignore */
  }

  return out.join('\n')
})()
