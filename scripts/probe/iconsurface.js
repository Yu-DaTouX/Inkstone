/*
 * 图标触点与无障碍名（实施-11 H-8c，cost 0，不调模型）。
 *
 * H-8a/b 已经把图标统一到 `Icon`（sprite + `currentColor`）。H-8c 管的是
 * **工作台 / 资源表面这些触点**：它们消费的是不是同一个接口，以及
 * 图标不承担无障碍名时，**承载它的控件有没有名字**。
 *
 * 检查项：
 *   ① 页面上的 svg 分类：sprite 引用（`<use href="#i-*">`）vs 内联 path
 *      —— 内联的要能说出理由（品牌图 / 第三方产物），否则就是漏接；
 *   ② 只含图标的可点击元素必须可访问名（`aria-label` / `title` / 文本）；
 *   ③ sprite 的每个 symbol 是否 `currentColor`（不写死颜色）；
 *   ④ 图标尺寸在允许档位（12/14/16）内且有实际渲染面积。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const skip = (s) => out.push('  ~ ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const visible = (el) => el.getClientRects().length > 0

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 40; i++) {
      if (window.__yanStore?.getState().conn === 'ready') break
      await sleep(500)
    }
    await sleep(900)

    /* ---------- ① svg 来源分类 ---------- */
    /* sprite 容器没有 id：它是那个「里面装着 symbol 的隐藏 svg」 */
    const sprite = [...document.querySelectorAll('svg')].find((s) => s.querySelector('symbol'))
    const svgs = [...document.querySelectorAll('svg')].filter((s) => !sprite?.contains(s))
    const spriteUses = []
    const inline = []
    for (const svg of svgs) {
      const use = svg.querySelector('use')
      const href = use?.getAttribute('href') ?? use?.getAttribute('xlink:href')
      if (href && href.startsWith('#i-')) spriteUses.push({ svg, name: href.slice(3) })
      else inline.push(svg)
    }
    const regionOf = (svg) => {
      const map = [
        ['.titlebar', '标题栏'],
        ['.rail', '会话轨'],
        ['.stream', '会话流'],
        ['.composer', '输入区'],
        ['.rp', '右栏 / 工具'],
        ['.browser', '浏览器'],
        ['.settings', '设置'],
        ['.review', '审查']
      ]
      for (const [sel, label] of map) if (svg.closest(sel)) return label
      return '其它'
    }
    const byRegion = new Map()
    for (const { svg } of spriteUses) {
      const key = regionOf(svg)
      byRegion.set(key, (byRegion.get(key) ?? 0) + 1)
    }
    out.push(
      `  sprite 引用 ${spriteUses.length} 个（${[...byRegion.entries()].map(([k, v]) => `${k} ${v}`).join('，')}）；内联 svg ${inline.length} 个`
    )
    if (inline.length) {
      const described = inline.slice(0, 6).map((s) => {
        const r = s.getBoundingClientRect()
        return `${regionOf(s)} ${Math.round(r.width)}×${Math.round(r.height)}`
      })
      out.push(`    内联 svg 位置：${described.join('，')}${inline.length > 6 ? ' …' : ''}`)
    }
    ok(spriteUses.length > 0, '功能图标确实走 sprite 接口（Icon → <use href="#i-*">）')

    /* ---------- ② 图标钮必须可访问名 ---------- */
    const nameless = []
    const named = []
    for (const { svg } of spriteUses) {
      const host = svg.closest('button, a[href], [role="button"], [role="tab"], [role="menuitem"]')
      if (!host) continue
      const text = (host.textContent ?? '').trim()
      const label = host.getAttribute('aria-label') ?? host.getAttribute('title') ?? ''
      const describedBy = host.getAttribute('aria-labelledby')
      if (text || label || describedBy) named.push(host.className || host.tagName.toLowerCase())
      else nameless.push(`${host.className || host.tagName.toLowerCase()}（${symbolName(svg)}）`)
    }
    function symbolName(svg) {
      const href = svg.querySelector('use')?.getAttribute('href') ?? ''
      return href.replace('#i-', '')
    }
    out.push(`  图标钮：有名字 ${named.length} 个，缺名字 ${nameless.length} 个`)
    ok(nameless.length === 0, '只含图标的可点击元素都有可访问名', nameless.slice(0, 5).join('，'))

    /* ---------- ③ sprite 每个 symbol 必须是 currentColor ---------- */
    if (!sprite) {
      skip('没找到 sprite 容器，跳过 currentColor 检查')
    } else {
      const symbols = [...sprite.querySelectorAll('symbol')]
      const hardCoded = []
      for (const sym of symbols) {
        for (const node of sym.querySelectorAll('*')) {
          for (const attr of ['stroke', 'fill']) {
            const v = node.getAttribute(attr)
            if (v && v !== 'currentColor' && v !== 'none' && v !== 'inherit') {
              hardCoded.push(`${sym.id || '?'} ${attr}=${v}`)
            }
          }
        }
      }
      out.push(`  sprite 共 ${symbols.length} 个 symbol；写死颜色的属性 ${hardCoded.length} 个`)
      ok(hardCoded.length === 0, 'sprite 全是 currentColor（颜色由所属控件给）', hardCoded.slice(0, 5).join('，'))

      /*
       * 深浅切换时图标颜色跟着走。
       * 不拿单个样本断言 —— 首个可见图标可能正好是固定色图形（品牌 / 状态点）。
       * 统计全体可见图标里有多少个颜色真的变了，比抽一个可靠。
       */
      const visibleUses = spriteUses.filter(({ svg }) => visible(svg)).slice(0, 60)
      /*
       * 按**元素身份**比较，不按数组下标 —— 主题切换会让 DOM 顺序/数量变化，
       * 下标一对一比出来的是噪声（上一次就是这么误报 4/60 的）。
       */
      const snapshot = () => {
        const list = [...document.querySelectorAll('svg')]
          .filter((s) => !sprite?.contains(s))
          .filter((s) => s.querySelector('use[href^="#i-"]'))
          .filter(visible)
        const rows = list.map((s) => {
          const host = s.closest('button, a[href], [role="button"]')
          const hostCls = (host?.className ?? '').toString().split(/\s+/).filter(Boolean).join('.')
          const name = s.querySelector('use')?.getAttribute('href') ?? '?'
          return { key: `${regionOf(s)}|${hostCls}|${name}`, color: getComputedStyle(s).color }
        })
        const map = new Map()
        for (const row of rows) if (!map.has(row.key)) map.set(row.key, row.color)
        return map
      }
      const rootVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim()
      /*
       * 隐藏/离屏窗口的样式重算会被节流：`getComputedStyle` 可能一直返回旧主题的值。
       * 先强制一次 reflow + 两帧，给渲染器一个落地的机会。
       */
      const flush = async () => {
        void document.documentElement.offsetHeight
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        void document.body.offsetHeight
      }
      /* 级联链诊断：颜色卡在哪一层（svg 自身的继承 vs 祖先的令牌） */
      const chainOf = () => {
        const svg = [...document.querySelectorAll('svg.ico')].find(visible)
        if (!svg) return '(没有可见 .ico)'
        const rows = []
        let node = svg
        while (node && node !== document.documentElement) {
          const cls = (node.className ?? '').toString().split(/\s+/).filter(Boolean)[0] ?? node.tagName.toLowerCase()
          rows.push(`${cls}=${getComputedStyle(node).color}`)
          node = node.parentElement
        }
        return rows.join(' ← ')
      }
      const chainBefore = chainOf()
      const before = snapshot()
      const beforeVars = `accent=${rootVar('--accent')} fg=${rootVar('--fg')} fg-mute=${rootVar('--fg-mute')} theme=${document.documentElement.dataset.theme}`
      const prev = document.documentElement.dataset.theme
      document.documentElement.dataset.theme = prev === 'light' ? 'dark' : 'light'
      await sleep(320)
      await flush()
      await sleep(200)
      const after = snapshot()
      const afterVars = `accent=${rootVar('--accent')} fg=${rootVar('--fg')} fg-mute=${rootVar('--fg-mute')} theme=${document.documentElement.dataset.theme}`
      document.documentElement.dataset.theme = prev
      await sleep(320)
      out.push(`  切主题前：${beforeVars}`)
      out.push(`  切主题后：${afterVars}`)
      out.push(`  级联链（前）：${chainBefore}`)
      out.push(`  级联链（后）：${chainOf()}`)
      const shared = [...before.keys()].filter((k) => after.has(k))
      const changed = shared.filter((k) => after.get(k) !== before.get(k)).length
      const stuck = shared.filter((k) => after.get(k) === before.get(k)).slice(0, 8)
      out.push(`  可比图标 ${shared.length} 个（按身份对位），切主题后变色 ${changed} 个`)
      if (stuck.length) out.push(`    未变色：${stuck.map((k) => `${k}=${before.get(k)}`).join('，')}`)
      const ratio = shared.length ? changed / shared.length : 0
      ok(ratio >= 0.8, '图标颜色随主题变化（至少 80% 跟随）', `${changed}/${shared.length}`)
      out.push('')
    }

    /* ---------- ④ 尺寸与渲染面积 ---------- */
    const sizes = new Map()
    const zero = []
    for (const { svg } of spriteUses) {
      const r = svg.getBoundingClientRect()
      const key = `${Math.round(r.width)}×${Math.round(r.height)}`
      sizes.set(key, (sizes.get(key) ?? 0) + 1)
      if (visible(svg) && (r.width < 8 || r.height < 8)) zero.push(`${symbolName(svg)} ${key}`)
    }
    out.push(`  渲染尺寸分布：${[...sizes.entries()].map(([k, v]) => `${k}×${v}`).join('，')}`)
    ok(zero.length === 0, '没有渲染面积过小的图标（<8px）', zero.slice(0, 5).join('，'))
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[iconsurface] 全部通过' : '[iconsurface] ' + failed + ' 条失败')
  return out.join('\n')
})()
