;(() => {
  const out = []
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]

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

  out.push('=== 左栏会话 ===')
  for (const it of qa('.rail .srow')) {
    const name = it.querySelector('.name')
    out.push(`  "${name?.textContent}" meta=${it.querySelector('.meta')?.textContent} sel=${it.classList.contains('sel')}`)
  }

  out.push('=== 溢出 ===')

  for (const sel of ['.status', '.rail-body', '.stream', '.app', '.workspace']) {
    const el = q(sel)
    if (!el) continue
    const over = el.scrollWidth - el.clientWidth
    out.push(
      `  ${sel.padEnd(12)} scrollW=${el.scrollWidth} clientW=${el.clientWidth}` +
        (over > 0 ? `  ✗ 横向溢出 ${over}px` : '  ✓')
    )
  }

  const overflow = []
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

  out.push('=== 连接 ===')
  out.push('  ' + (q('.tb-sync')?.textContent ?? '缺失'))
  out.push('  connbar=' + (q('.connbar') ? '显示(异常)' : '隐藏(正常)'))
  out.push('  三栏=' + ['.rail', '.center', '.status'].map((s) => Math.round(q(s)?.getBoundingClientRect().width ?? 0)).join(' / '))
  out.push('  视口=' + window.innerWidth + ' scrollW=' + document.documentElement.scrollWidth)

  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;visibility:hidden;font:12.5px "Maple Mono CN"'
  probe.textContent = '国'
  document.body.appendChild(probe)
  out.push('=== 字体 ===')
  out.push('  汉字格宽=' + probe.getBoundingClientRect().width.toFixed(2))
  probe.remove()

  const uses = qa('svg.ico use')
  const missing = uses.filter((u) => !document.getElementById((u.getAttribute('href') || '').slice(1)))
  out.push('=== 图标 ===')
  out.push(`  use=${uses.length} 空引用=${missing.length}`)

  out.push('=== 其他 ===')

  return out.join('\n')
})()
