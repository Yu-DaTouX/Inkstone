/**
 * 界面密度：三档真的改变间距、真的落盘（方案 A1）。
 *
 * 为什么这么测：密度是**全局尺寸**改动，最容易出现「改了档位但界面没动」
 * 或者「标准档不再是原来的样子」。所以两件事都要钉住：
 *   ① 同一元素在 compact / standard / comfortable 下实测间距不同；
 *   ② standard 档的实测值 = 改动前的值（--sp-6 = 32px）。
 *
 * 不改字号是设计约束，这里也顺带断言一次（字号三档一致）。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore

  try {
    for (let i = 0; i < 60; i++) {
      if (q('.stream') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(800)

    /** 量一个真实元素的间距：优先消息，其次推理胶囊 */
    const target = () => q('.msg') ?? q('.reason') ?? q('.stream-row')
    const gapOf = () => {
      const el = target()
      if (!el) return NaN
      const cs = getComputedStyle(el)
      return parseFloat(cs.marginBottom) || parseFloat(cs.paddingBottom) || 0
    }
    const fontOf = () => {
      const el = target()
      return el ? parseFloat(getComputedStyle(el).fontSize) : NaN
    }

    if (!target()) {
      out.push('  （跳过）当前会话没有可测量的消息/推理元素')
      return out.join('\n')
    }

    const before = store.getState().settings?.density
    out.push(`  初始 density = ${JSON.stringify(before)}`)
    ok(before === 'standard', '默认是 standard（不改老用户的观感）')

    const measure = async (d) => {
      await store.getState().patchSettings({ density: d })
      await sleep(350)
      return { gap: Math.round(gapOf() * 100) / 100, font: Math.round(fontOf() * 100) / 100 }
    }

    const std = await measure('standard')
    const compact = await measure('compact')
    const comfy = await measure('comfortable')

    out.push(`  实测间距：compact=${compact.gap} / standard=${std.gap} / comfortable=${comfy.gap}`)
    out.push(`  实测字号：compact=${compact.font} / standard=${std.font} / comfortable=${comfy.font}`)

    ok(Math.abs(std.gap - 32) < 1.5, `standard 档 = 改动前的 32px（实测 ${std.gap}）`)
    ok(compact.gap < std.gap - 8, `紧凑档确实更紧（${compact.gap} < ${std.gap}）`)
    ok(comfy.gap > std.gap + 8, `舒适档确实更松（${comfy.gap} > ${std.gap}）`)
    ok(
      compact.font === std.font && comfy.font === std.font,
      `三档字号一致（${std.font}px）—— 密度只调间距`
    )

    /* html 上的标记与设置同步（CSS 覆盖靠它） */
    ok(
      document.documentElement.dataset.density === 'comfortable',
      'html[data-density] 跟着设置变'
    )

    /* 落盘：重新读一次设置 */
    const persisted = (await window.yan.getSettings())?.density
    out.push(`  落盘 density = ${JSON.stringify(persisted)}`)
    ok(persisted === 'comfortable', '档位落盘')

    /* 收尾：改回 standard，别把探针的档位留给后面的场景 */
    await store.getState().patchSettings({ density: 'standard' })
    await sleep(300)
    ok(store.getState().settings?.density === 'standard', '能改回 standard')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
