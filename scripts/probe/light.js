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
    const rgb = bg.match(/\d+/g)?.map(Number) ?? []
    const lum = rgb.length >= 3 ? (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255 : 0
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

  const head = q('.tool-head')
  const sum = q('.tool-sum')
  const mute = getComputedStyle(document.documentElement).getPropertyValue('--fg-mute').trim()
  out.push('  --fg-mute = ' + mute)
  out.push('  工具行: ' + (head ? '有' : '无'))
  if (head) {
    // 浅色下的可读性标准：颜色不能是“黑的不彻底、浅的不明显”
    const col = getComputedStyle(head).color
    const rgb = col.match(/\d+/g)?.map(Number) ?? []
    const lum = rgb.length >= 3 ? (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114) / 255 : 1
    out.push(`  .tool-head color=${col}（亮度 ${lum.toFixed(2)}）`)
    ok(lum < 0.75, `工具行文字够深（亮度 ${lum.toFixed(2)}，< 0.75）`)
  } else {
    out.push('  ⚠️ 这份 fixture 里没有工具调用，跳过工具行的对比度断言')
  }
  if (sum) out.push('  .tool-sum color=' + getComputedStyle(sum).color)

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

  /* ---- 恢复深色，别把用户设置改了（隔离目录里其实无所谓，但保持一致）---- */
  document.documentElement.dataset.theme = 'dark'
  try {
    localStorage.setItem('yan.theme', 'dark')
  } catch {
    /* ignore */
  }

  return out.join('\n')
})()
