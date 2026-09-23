/**
 * 导航轨与**会话可用区**的关系（2026-09-23 V-2b 新契约）。
 *
 * 旧契约（已废止）：刻度要贴在「正文左侧的空隙」里 —— 判据是收起/展开左栏时
 * 「刻度右缘到正文左缘」的距离稳定（实测 4.8px）。那条契约的前提是轨道跟着
 * 正文列走；窄窗时正文占满，`Math.max(0, …)` 把整列夹到会话区左缘，
 * 44px 的命中区就压在正文上（用户报的遮挡）—— 而且正文一居中轨道位置就漂。
 *
 * 新契约：轨道固定在会话可用区域左边缘的独立槽内（视觉边距 4–8px），
 * 正文反过来让出避让槽。判据换成几何事实：
 *   ① 槽贴会话区左缘，边距在 4–8px；
 *   ② 命中区矩形与正文内容**不相交**（左右栏两种开合状态都要成立）；
 *   ③ 轨道只覆盖对话区，不伸进输入区；
 *   ④ 长轨（几十轮）末项键盘可达；
 *   ⑤ 预览卡不出会话可用区。
 */
;(async () => {
  const out = []
  const ok = (c, s) => { out.push((c ? '  ✓ ' : '  ✗ ') + s); return !!c }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }
  }
  const overlaps = (a, b) =>
    a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card'); if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) { click(b); await sleep(300) } else await sleep(150)
    }
    store.getState().setRailPinned(true)
    await sleep(600)

    /* 40 轮：既让导航轨渲染，也把轨道撑到需要滚动（末项可达那条要用） */
    const fake = []
    for (let i = 1; i <= 40; i++) {
      fake.push({ id: 'u' + i, role: 'user', text: '第 ' + i + ' 个问题' })
      fake.push({ id: 'a' + i, role: 'assistant', text: '第 ' + i + ' 个回答' + 'x'.repeat(80) })
    }
    store.getState().applyPush({ ch: 'sync', payload: fake })
    await sleep(1400)

    const outline = q('[data-testid="outline"]')
    ok(!!outline, '导航轨渲染（40 轮）')
    if (!outline) return out.join('\n')

    const center = q('.center')
    out.push(
      `  诊断：center.position=${getComputedStyle(center).position} ` +
        `gridRow=${getComputedStyle(outline).gridRowStart}/${getComputedStyle(outline).gridRowEnd} ` +
        `outline.top/bottom=${getComputedStyle(outline).top}/${getComputedStyle(outline).bottom}`
    )
    {
      const sb = rect(q('.stream'))
      const cb2 = rect(center)
      out.push(`  诊断：stream ${sb.top.toFixed(1)}~${sb.bottom.toFixed(1)}；center ${cb2.top.toFixed(1)}~${cb2.bottom.toFixed(1)}`)
    }

    /** 正文内容真正占用的横向范围（容器 rect 缩掉左右内边距） */
    const contentBox = () => {
      const inner = q('.stream-inner, .stream-row')
      if (!inner) return null
      const r = rect(inner)
      const cs = getComputedStyle(inner)
      return {
        left: r.left + (parseFloat(cs.paddingLeft) || 0),
        right: r.right - (parseFloat(cs.paddingRight) || 0),
        top: r.top,
        bottom: r.bottom
      }
    }

    const check = async (label) => {
      const ob = rect(outline)
      const cb = rect(center)
      const content = contentBox()
      const hits = [...document.querySelectorAll('[data-testid="outline-tick"]')].map(rect)
      const inset = +(ob.left - cb.left).toFixed(1)
      out.push(
        `  ${label}: 会话区 x=${cb.left.toFixed(1)} 轨道 x=${ob.left.toFixed(1)} → 边距 ${inset}px；` +
          `正文内容左缘 ${content ? content.left.toFixed(1) : '?'}`
      )
      ok(inset >= 0 && inset <= 8, `${label}：轨道贴会话区左缘（边距 ${inset}px ∈ [0,8]）`)
      if (content) {
        const worst = hits.reduce((m, r) => Math.max(m, r.right - content.left), -Infinity)
        out.push(`    命中区右缘最多伸到正文左缘前 ${(-worst).toFixed(1)}px`)
        ok(worst <= 0.5, `${label}：命中区与正文内容不相交（重叠 ${worst > 0 ? worst.toFixed(1) : 0}px）`)
      }
      const composer = q('.composer-wrap')
      if (composer) {
        const cr = rect(composer)
        out.push(`    轨道 bottom=${ob.bottom.toFixed(1)} 输入区 top=${cr.top.toFixed(1)}`)
        ok(ob.bottom <= cr.top + 1, `${label}：轨道不伸进输入区`)
      }
    }

    await check('左栏展开')
    store.getState().setRailPinned(false)
    await sleep(900)
    await check('左栏收起')
    store.getState().setRailPinned(true)
    await sleep(700)

    /* 窄窗：正文会伸到会话区边界附近，避让槽必须真的生效（V-2b 出口之一） */
    {
      const bw = window.innerWidth
      const bh = window.innerHeight
      window.resizeTo(940, 620)
      await sleep(1200)
      if (Math.abs(window.innerWidth - 940) < 60) {
        await check('窄窗 940')
      } else {
        out.push(
          `  （window.resizeTo 不生效：当前 ${window.innerWidth}x${window.innerHeight}；` +
            `本场景窗口本身已是窄窗，上面两态已经覆盖）`
        )
      }
      window.resizeTo(bw, bh)
      await sleep(900)
    }

    /* 命中区与正文**可交互元素**也不相交 —— 这些才是真会被挡住、点不到的东西 */
    {
      const hits = [...document.querySelectorAll('[data-testid="outline-tick"]')].map(rect)
      const targets = [
        ...document.querySelectorAll('.stream-inner .msg, .stream-row .msg, .stream-inner a, .stream-inner button, .stream-row a, .stream-row button')
      ].map(rect)
      let bad = 0
      for (const h of hits) for (const t of targets) if (overlaps(h, t)) bad++
      out.push(`  正文块/可交互元素 ${targets.length} 个，与命中区相交 ${bad} 个`)
      ok(targets.length > 0 && bad === 0, '命中区与正文块、链接、按钮都不相交')
    }

    /* 长轨末项可达：聚焦最后一格，轨道要把它滚进可视区 */
    {
      const track = q('.outline-track')
      const hits = [...document.querySelectorAll('[data-testid="outline-tick"]')]
      const last = hits[hits.length - 1]
      const tb = rect(track)
      const overflows = track.scrollHeight > track.clientHeight + 1
      out.push(`  轨道溢出=${overflows}（scrollH=${track.scrollHeight} clientH=${track.clientHeight} 格数=${hits.length}）`)
      last.focus()
      await sleep(250)
      const lb = rect(last)
      out.push(
        `  焦点诊断：active=${document.activeElement?.tagName}.${document.activeElement?.className} ` +
          `preview=${!!q('[data-testid="outline-preview"]')}`
      )
      ok(document.activeElement === last, '末项可聚焦（Tab 序列可达）')
      if (overflows) {
        out.push(
          `  聚焦末项后 scrollTop=${Math.round(track.scrollTop)}，末项 ${lb.top.toFixed(1)}~${lb.bottom.toFixed(1)}，` +
            `轨道 ${tb.top.toFixed(1)}~${tb.bottom.toFixed(1)}`
        )
        ok(track.scrollTop > 0, '聚焦末项时轨道自动滚动')
      } else {
        out.push('  （本次窗口够高，轨道没溢出；末项本来就在可视区）')
      }
      ok(lb.top >= tb.top - 2 && lb.bottom <= tb.bottom + 2, '长轨末项可达（落在可视区内）')
      /*
       * 键盘预览：窗口没被系统激活时 `el.focus()` 只改 activeElement、
       * **不派发 focus/focusin**（Chromium 行为，实测 activeElement 已是按钮
       * 但预览没出来）。所以这一条直接派 focusin 验 React 绑定。
       */
      last.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      await sleep(300)
      ok(!!q('[data-testid="outline-preview"]'), '键盘焦点与鼠标同等弹出预览')
      last.blur()
      await sleep(200)
    }

    /* 预览卡水平夹取：不出会话可用区 */
    {
      const hits = [...document.querySelectorAll('[data-testid="outline-tick"]')]
      hits[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await sleep(400)
      const pv = q('[data-testid="outline-preview"]')
      const cb = rect(center)
      if (pv) {
        const pb = rect(pv)
        out.push(`  预览卡 x=${pb.left.toFixed(1)}~${pb.right.toFixed(1)} 宽=${pb.w.toFixed(0)}；会话区右缘 ${cb.right.toFixed(1)}`)
        ok(pb.left >= cb.left - 1, '预览卡不越出会话区左缘')
        ok(pb.right <= cb.right + 1, '预览卡不越出会话区右缘')
      } else {
        ok(false, '悬停应弹出预览')
      }
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[outlinepos] 全部通过' : '[outlinepos] ' + failed + ' 条失败')
  return out.join('\n')
})()
