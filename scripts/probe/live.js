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

  /* ---- 2. 身份卡的三个值 ---- */
  out.push('=== 身份卡 ===')
  const soulLines = qa('.sect[data-sec="soul"] .soul-line')
  out.push(`  行数=${soulLines.length}`)
  for (const l of soulLines) {
    out.push(`  ${l.querySelector('dt')?.textContent} = ${l.querySelector('dd')?.textContent}`)
  }
  out.push(`  soul-ro 文本=${q('.sect[data-sec="soul"] .soul-ro')?.textContent ?? '缺失'}`)

  /* ---- 3. 记忆行 ---- */
  out.push('=== 记忆行 ===')
  for (const r of qa('.memrow')) {
    const cs = getComputedStyle(r.querySelector('.bar'))
    out.push(
      `  ${r.className.replace('memrow ', '').padEnd(18)} bar=${cs.backgroundColor} ` +
        `txt=${(r.querySelector('.txt')?.textContent ?? '').slice(0, 22)}`
    )
  }
  out.push(`  空状态块=${qa('.mem-empty').length}`)
  out.push(`  添加行=${qa('.mem-add').length}（出现在: ${qa('.sect').filter((s) => s.querySelector('.mem-add')).map((s) => s.dataset.sec).join(',')}）`)

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
  qa('.rail *, .status *, .stream-inner *, .titlebar *, .continuity *').forEach((el) => {
    const p = el.parentElement
    if (!p) return
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) return
    if (p.checkVisibility && !p.checkVisibility({ contentVisibilityAuto: true })) return
    const a = el.getBoundingClientRect()
    const b = p.getBoundingClientRect()
    if (a.right - b.right > 1 || a.bottom - b.bottom > 1) {
      overflow.push(`${el.tagName}.${String(el.className).split(' ')[0]} ⤬ ${p.tagName}.${String(p.className).split(' ')[0]}`)
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
  out.push('  未确认记忆数=' + qa('.sect[data-sec="impressions"] .memrow').length)
  out.push('  审阅条=' + (q('.review') ? q('.review').textContent.replace(/\s+/g, ' ').trim() : '隐藏'))

  return out.join('\n')
})()
