/**
 * 在**真实运行的应用**里跑 DOM 断言。
 * 用法： YAN_PROBE=scripts/probe/live.js npx electron .
 *
 * 注意脚本会被 executeJavaScript 执行，必须是**表达式**（顶层 return 不行），
 * 所以整体包成 IIFE 并 return 字符串。
 */
;(() => {
  const out = []
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

  /* ---- 1. 右栏分区是否都渲染了内容 ---- */
  out.push('=== 右栏分区 ===')
  for (const s of qa('.sect')) {
    const id = s.dataset.sec
    const card = s.querySelector('.card')
    const r = s.getBoundingClientRect()
    out.push(
      `  ${id.padEnd(12)} class=${s.className.replace('sect ', '').padEnd(18)} ` +
        `card=${card ? Math.round(card.getBoundingClientRect().height) + 'px' : '缺失'} ` +
        `rect=${Math.round(r.height)}px`
    )
  }

  /* ---- 2. 记忆相关区块已随记忆功能移除，这里不再检查 ---- */

  /* ---- 4. 左栏会话 ---- */
  out.push('=== 左栏会话 ===')
  for (const it of qa('.rail .srow')) {
    const name = it.querySelector('.name')
    out.push(`  "${name?.textContent}" meta=${it.querySelector('.meta')?.textContent} sel=${it.classList.contains('sel')}`)
  }

  /* ---- 5. 溢出检测 ---- */
  out.push('=== 溢出 ===')

  // 5a. 滚动容器不应该出现横向滚动。
  //     曾经的 bug：overflow-y:auto 连带把 overflow-x 变 auto，
  //     纵向滚动条一出现就挤窄 clientWidth，于是冒出一条横向滚动条。
  for (const sel of ['.status', '.rail-body', '.stream', '.app', '.workspace']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    out.push(
      `  ${sel.padEnd(12)} scrollW=${el.scrollWidth} clientW=${el.clientWidth}` +
        (over > 0 ? `  ✗ 横向溢出 ${over}px` : '  ✓')
    )
  }

  // 5b. 元素不应越出父容器
  const overflow = []
  /**
   * 这个方向上父容器是不是“可以滚”？
   *
   * 为什么必须区分：`.rail-body` 是 `overflow: hidden auto` —— 纵向可滚。
   * 列表内容超过一屏时，下半部分的子元素**本来就在滚动区之外**，
   * 它们的 `bottom` 当然大于父容器的 `bottom`。那不是越界，是「还没滚到」。
   * 实测：fixture 里 3 份“最近的真实会话”归属的项目数一变，左栏项目行数就从
   * 几个变成十几个，于是 `.rail-more-projects` 落到滚动区之下 —— 旧判据这里
   * 会稳定报一个假阳性（npm run check 里 live 场景偶发失败）。
   * 所以：**父容器在该轴上可滚** → 该轴不比；`hidden`（裁切）仍然要比（真越界）。
   */
  const scrollsOn = (el, axis) => {
    const cs = getComputedStyle(el)
    const v = axis === 'y' ? cs.overflowY : cs.overflowX
    return v === 'auto' || v === 'scroll' || v === 'overlay'
  }
  qa('.rail *, .status *, .stream-inner *, .titlebar *, .continuity *').forEach((el) => {
    const p = el.parentElement
    if (!p) return
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) return
    if (p.checkVisibility && !p.checkVisibility({ contentVisibilityAuto: true })) return
    const a = el.getBoundingClientRect()
    const b = p.getBoundingClientRect()
    const badX = a.right - b.right > 1 && !scrollsOn(p, 'x')
    const badY = a.bottom - b.bottom > 1 && !scrollsOn(p, 'y')
    if (badX || badY) {
      overflow.push(
        `${el.tagName}.${String(el.className).split(' ')[0]} ⤬ ${p.tagName}.${String(p.className).split(' ')[0]}` +
          (badX && badY ? ' (右+下)' : badX ? ' (右)' : ' (下)')
      )
    }
  })
  out.push(`  子元素越界数量=${overflow.length}`)
  overflow.slice(0, 8).forEach((o) => out.push('  ✗ ' + o))

  /* ---- 6. 连接 / 状态 ---- */
  out.push('=== 连接 ===')
  out.push('  ' + (q('.tb-sync')?.textContent ?? '缺失'))
  out.push('  connbar=' + (q('.connbar') ? '显示(异常)' : '隐藏(正常)'))
  out.push('  三栏=' + ['.rail', '.center', '.status'].map((s) => Math.round(q(s)?.getBoundingClientRect().width ?? 0)).join(' / '))
  out.push('  视口=' + window.innerWidth + ' scrollW=' + document.documentElement.scrollWidth)

  /* ---- 7. 字体 ---- */
  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"'
  probe.textContent = '国'
  document.body.appendChild(probe)
  out.push('=== 字体 ===')
  out.push('  汉字格宽=' + probe.getBoundingClientRect().width.toFixed(2))
  probe.remove()

  /* ---- 8. 图标 ---- */
  const uses = qa('svg.ico use')
  const missing = uses.filter((u) => !document.getElementById((u.getAttribute('href') || '').slice(1)))
  out.push('=== 图标 ===')
  out.push(`  use=${uses.length} 空引用=${missing.length}`)

  /* ---- 9. 控制台报错残留 ---- */
  out.push('=== 其他 ===')

  return out.join('\n')
})()
