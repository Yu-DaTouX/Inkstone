/**
 * 模型选项菜单（N08）：可见行数 / 不越界 / 当前模型在视野内 / 键盘选择。
 *
 * 用户报的「五个半」：菜单固定 400px 高，上方两块说明 + 搜索占掉大头，
 * 900px 高的窗口里只能看到 5 行多。修法：打开时按触发器上方的真实空间
 * 算 max-height，说明文字在矮窗口让位给列表，列表 flex 占满剩余高度。
 *
 * 为什么不连真 pi：隔离环境没有凭证，models 为空。这里往 store 里注入
 * 合成模型（跨 3 个 provider、24 条）—— 量的是**布局与交互**，
 * 与模型是真是假无关；真实模型列表由真实环境验证。
 */
;(async () => {
  const out = []
  const ok = (c, s) => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s)
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const store = window.__yanStore
  const until = async (fn, ms = 6000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(80)
    }
    return false
  }
  const box = (el) => (el ? el.getBoundingClientRect() : null)

  try {
    for (let i = 0; i < 60; i++) {
      if (q('[data-testid="model-picker"]') && store?.getState().settings) break
      await sleep(250)
    }
    await sleep(600)

    /* ---- 造一份确定的数据：3 个 provider / 24 个模型，当前模型在第 17 个 ---- */
    const providers = ['anthropic', 'openai', 'google']
    const models = []
    for (let i = 0; i < 24; i++) {
      const provider = providers[i % providers.length]
      models.push({
        id: `probe-model-${String(i).padStart(2, '0')}-with-a-rather-long-name`,
        name: `Probe Model ${i} 一个偏长的模型名`,
        provider,
        reasoning: i % 2 === 0
      })
    }
    const currentModel = models[16]
    const s0 = store.getState().session ?? {}
    store.setState({
      models,
      session: {
        ...s0,
        model: { id: currentModel.id, name: currentModel.name, provider: currentModel.provider, reasoning: true }
      }
    })
    await sleep(400)

    click(q('[data-testid="model-picker"]'))
    ok(await until(() => !!q('[data-testid="model-menu"]')), '点击触发器打开模型菜单')
    await sleep(500)

    const pop = q('[data-testid="model-menu"]')
    const list = q('.mt-list')
    const pb = box(pop)
    const lb = box(list)
    const vh = window.innerHeight
    const vw = window.innerWidth
    out.push(`  窗口 ${vw}×${vh}  菜单 ${pb?.width.toFixed(0)}×${pb?.height.toFixed(0)} @ top=${pb?.top.toFixed(1)} left=${pb?.left.toFixed(1)}`)
    out.push(`  列表可视高 ${lb?.height.toFixed(0)}px / 内容高 ${list?.scrollHeight}px`)

    /* ---- 不越界 ---- */
    ok(!!pb && pb.top >= -1, `菜单上沿不越出窗口（top=${pb?.top.toFixed(1)}）`)
    ok(!!pb && pb.bottom <= vh + 1, `菜单下沿不越出窗口（bottom=${pb?.bottom.toFixed(1)} ≤ ${vh}）`)
    ok(!!pb && pb.left >= -1 && pb.right <= vw + 1, '菜单左右不越出窗口')
    /*
     * 不被输入框/边缘裁切：菜单是向上弹的，会盖住输入框上方的聊天区
     *（那是原设计，不算缺陷）；关键是它得**紧贴触发器、完整可见**。
     */
    const trigger = box(q('[data-testid="model-picker"]'))
    ok(!!trigger && !!pb && pb.bottom <= trigger.top + 1, '菜单紧贴触发器上方（不盖住触发器本身）')
    ok(!!pb && pb.height >= 200, `菜单有可用高度（${pb?.height.toFixed(0)}px）`)

    /* ---- 完整可见行数 ---- */
    const items = qa('.mt-item')
    const fully = items.filter((el) => {
      const b = box(el)
      return b.top >= lb.top - 0.5 && b.bottom <= lb.bottom + 0.5
    })
    out.push(`  模型行 ${items.length} 条，完整可见 ${fully.length} 条`)
    if (vh >= 700) {
      ok(fully.length >= 8, `普通窗口至少 8 个完整模型行（实际 ${fully.length}）`)
    } else {
      ok(fully.length >= 4, `矮窗口仍有可用行数（实际 ${fully.length}）`)
    }
    ok(items.length === 24, '列表里是全部 24 个模型（没有被截断成前 N 条）')

    /* ---- 分组与完整名称提示 ---- */
    const heads = qa('.mt-group-head').map((h) => h.textContent)
    out.push('  provider 分组 = ' + heads.join(' / '))
    ok(heads.length === 3, '按 provider 分组（3 组）')
    ok(items.every((el) => (el.getAttribute('title') || '').length > 0), '每个模型行都有完整名称提示（title）')

    /* ---- 当前模型滚入视野 ---- */
    const curEl = q('.mt-item[data-current="1"]')
    const cb = box(curEl)
    ok(!!curEl, '当前模型那一行存在')
    ok(!!cb && cb.top >= lb.top - 0.5 && cb.bottom <= lb.bottom + 0.5, '当前模型在打开时已滚入视野')

    /* ---- 滚动：列表能到底 ---- */
    if (list) {
      list.scrollTop = list.scrollHeight
      await sleep(250)
      const last = items[items.length - 1]
      const lb2 = box(list)
      ok(box(last).bottom <= lb2.bottom + 0.5, '滚到底后最后一个模型完整可见')
      list.scrollTop = 0
      await sleep(200)
      ok(box(items[0]).top >= box(list).top - 0.5, '滚回顶部后第一个模型完整可见')
    }

    /* ---- 键盘：高亮移动 + Enter 接受 ---- */
    const search = q('[data-testid="model-search"]')
    ok(!!search, '搜索框存在（键盘入口）')
    const cursorOf = () => q('.mt-item[data-cursor="1"]')
    const cursorText = () => (cursorOf()?.querySelector('.mt-item-name')?.textContent ?? '').trim()
    ok(!!cursorOf(), '打开时有一个键盘高亮项（落在当前模型上）')
    const before = cursorText()

    search.focus()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await sleep(300)
    const after = cursorText()
    out.push(`  高亮 ${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    ok(after !== before && after.length > 0, 'ArrowDown 把高亮移到下一项')
    const cursorBox = box(cursorOf())
    const lb3 = box(q('.mt-list'))
    ok(!!cursorBox && cursorBox.top >= lb3.top - 0.5 && cursorBox.bottom <= lb3.bottom + 0.5, '高亮项自动滚入视野')

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    await sleep(250)
    ok(cursorText() === before, 'ArrowUp 回到上一项')

    /* Enter 只接受当前候选：不发送消息、不关面板 */
    const msgsBefore = store.getState().messages.length
    let picked = null
    try {
      window.yan.setModel = async (provider, id) => {
        picked = `${provider}|${id}`
        return { ok: true }
      }
    } catch {
      /* contextBridge 暴露的对象可能不可写 —— 那就只断言不误发送 */
    }
    const target = cursorText()
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await sleep(500)
    if (picked) {
      out.push(`  Enter 选中了 ${picked}`)
      ok(/probe-model/.test(picked), 'Enter 调用了 setModel 接受当前高亮模型')
    }
    ok(store.getState().messages.length === msgsBefore, 'Enter 没有发送消息（接受候选 ≠ 发送）')
    ok(!!q('[data-testid="model-menu"]'), 'Enter 后面板仍然打开（还可以接着调强度）')

    /* ---- 搜索过滤后仍可用 ---- */
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setValue.call(search, 'google')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(400)
    const filtered = qa('.mt-item')
    out.push(`  搜 "google" → ${filtered.length} 条`)
    ok(filtered.length === 8, '按 provider 过滤到 google 的 8 条')
    ok(!!q('.mt-item[data-cursor="1"]'), '过滤后仍有键盘高亮项')
    setValue.call(search, '')
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)

    /* 关闭：把焦点和状态还给后续场景 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await sleep(300)
    ok(!q('[data-testid="model-menu"]'), 'Esc 关闭菜单')
    void target
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
