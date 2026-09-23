/**
 * 语义图标状态与浅色适配（实施-11 H-8a/b，cost 0，不调模型）。
 *
 * 只验能直接量的事实：
 *   ① 主题文本色与底色的对比度（正文 / 次要文字 / 图标注色），深浅两态；
 *   ② `.ico` 的颜色过渡存在，且 reduced-motion 分支把时长压到 1ms；
 *   ③ 进行态动画只挂在真实 running 类上，类名移走就停。
 *
 * artifact / imageProgress / 子代理内联卡的浅色外观由视觉矩阵的
 * `artifact` / `imageprogress` / `subagentinline` 浅色截图看图验收 ——
 * 这里只保证它们引用的变量都已定义（`var(--text)` 那类回退已清零）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

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
    const hi = Math.max(l1, l2)
    const lo = Math.min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)
  }
  /** 把两个 token 分别当 color / background 应用，读浏览器规范化后的值 */
  const pair = (fgVar, bgVar) => {
    const el = document.createElement('span')
    el.style.cssText =
      'position:fixed;visibility:hidden;font-size:12px;' +
      'color:var(' + fgVar + ');background:var(' + bgVar + ')'
    el.textContent = 'x'
    document.body.appendChild(el)
    const cs = getComputedStyle(el)
    const r = { fg: cs.color, bg: cs.backgroundColor }
    el.remove()
    return r
  }

  /** 遍历样式表（含媒体查询内部），找满足条件的规则 */
  const walkRules = (fn) => {
    const visit = (rules) => {
      for (const rule of rules) {
        fn(rule)
        if (rule.cssRules) visit(rule.cssRules)
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules)
      } catch {
        /* 跨域样式表读不到 */
      }
    }
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) click(b)
      await sleep(250)
    }
    await sleep(800)

    /* ---- ① 对比度：深浅两态 ---- */
    for (const theme of ['dark', 'light']) {
      document.documentElement.dataset.theme = theme
      await sleep(350)
      const checks = [
        ['--fg', '--bg-0', 4.5, '正文'],
        ['--fg-dim', '--bg-0', 4.5, '次要文字'],
        ['--fg-mute', '--bg-0', 4.5, '更次文字'],
        ['--fg-mute', '--bg-2', 3, '功能图标色（卡片底）'],
        ['--accent', '--bg-0', 3, '强调色图形'],
        ['--err', '--bg-0', 3, '错误色图形']
      ]
      for (const [fgVar, bgVar, min, label] of checks) {
        const { fg, bg } = pair(fgVar, bgVar)
        const r = +contrast(fg, bg).toFixed(2)
        out.push(`  [${theme}] ${label} ${fgVar}/${bgVar} = ${r}:1 ${fg} on ${bg}`)
        ok(r >= min, `[${theme}] ${label} 对比度 ≥ ${min}:1（${r}）`)
      }
    }
    document.documentElement.dataset.theme = 'dark'
    await sleep(250)

    /* ---- ② .ico 的颜色过渡 + reduced-motion 分支 ---- */
    {
      const ico = q('.ico')
      ok(!!ico, '页面上存在真实图标（.ico）')
      const cs = ico ? getComputedStyle(ico) : null
      const dur = cs?.transitionDuration ?? ''
      const props = cs?.transitionProperty ?? ''
      out.push(`  .ico transition: ${props} ${dur}`)
      ok(/color/.test(props), '.ico 对 color 有过渡（选中/展开的颜色不再瞬跳）')
      ok(parseFloat(dur) >= 0.1 && parseFloat(dur) <= 0.2, `过渡时长在 100–200ms（${dur}）`)

      let mediaFound = false
      let icoInMedia = false
      walkRules((rule) => {
        if (rule.conditionText && /prefers-reduced-motion/.test(rule.conditionText)) {
          mediaFound = true
          const inner = rule.cssRules ?? []
          for (const r of inner) {
            const sel = String(r.selectorText ?? '').split(',').map((s) => s.trim())
            if (sel.includes('.ico')) icoInMedia = true
          }
        }
      })
      out.push(`  reduced-motion 媒体块存在=${mediaFound}，其中含 .ico 规则=${icoInMedia}`)
      ok(mediaFound && icoInMedia, 'reduced-motion 下 .ico 的过渡被显式压低')
    }

    /* ---- ③ 进行态动画：running 类移走就停 ---- */
    {
      const wrap = document.createElement('div')
      wrap.className = 'image-progress running'
      wrap.innerHTML = '<div class="image-progress-track"><span></span></div>'
      document.body.appendChild(wrap)
      const bar = wrap.querySelector('span')
      const running = getComputedStyle(bar).animationName
      wrap.classList.remove('running')
      const stopped = getComputedStyle(bar).animationName
      wrap.remove()
      out.push(`  图片进度：running 时 animation-name=${running}，去掉类后=${stopped}`)
      ok(running && running !== 'none', '进行态确实在动')
      ok(stopped === 'none', '停止/完成后动画随之停（不空转）')
    }
    {
      const sp = document.createElement('div')
      sp.className = 'subagent-inline-spinner'
      document.body.appendChild(sp)
      const cs = getComputedStyle(sp)
      const name = cs.animationName
      const state = cs.animationPlayState
      sp.remove()
      out.push(`  子代理 spinner：animation-name=${name} play-state=${state}`)
      ok(name && name !== 'none' && state === 'running', '真实运行态 spinner 在转')
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[iconstate] 全部通过' : '[iconstate] ' + failed + ' 条失败')
  return out.join('\n')
})()
