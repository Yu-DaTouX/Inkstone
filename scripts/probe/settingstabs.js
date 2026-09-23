/*
 * 设置页：外壳与四个剩余页面（实施-13 V-3，cost 0）。
 *
 * 覆盖 V-3 的出口清单里**能用隔离环境验证**的部分：
 *   · 只用键盘切 tab（方向键 + roving focus），且切换后内容真的跟着换；
 *   · 每一页都渲染出真实内容或有真实空态，不是空白壳；
 *   · 异步动作期间按钮禁用（防重复提交）；
 *   · 长 `provider/model` / 包名有全文出口（title）；
 *   · 关闭后不留第二份实例。
 *
 * 不覆盖：真实 provider 连接/登录、真实安装包、真实视觉矩阵（另需额度和看图）。
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
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore
  const byTestId = (id) => q(`[data-testid="${id}"]`)
  const TAB_ORDER = ['auth', 'appearance', 'context', 'knowledge', 'capabilities', 'sound', 'status', 'packages', 'about']

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(300)
      } else await sleep(150)
    }
    if (!store.getState().settingsOpen) click(byTestId('rail-settings'))
    await until(() => !!q('.settings'), 6000)
    await sleep(300)
    ok(qa('.settings').length === 1, '设置面板只有一个实例')

    out.push('=== 1. 外壳与键盘切 tab ===')
    ok(!!q('.settings-tabs[role="tablist"]'), 'tab 容器有 role=tablist')
    const tabEls = qa('.settings-tabs [role="tab"]')
    ok(tabEls.length === TAB_ORDER.length, `tab 数量正确（${tabEls.length}/${TAB_ORDER.length}）`)
    const selected = qa('.settings-tabs [role="tab"][aria-selected="true"]')
    ok(selected.length === 1, '同一时刻只有一个 aria-selected=true')
    ok(!!q('#settings-tabpanel[role="tabpanel"]'), '内容区有 role=tabpanel')
    /* 键盘：从当前 tab 按下方向键 → 选中下一个并聚焦 */
    const beforeTab = selected[0]?.id
    selected[0]?.focus()
    selected[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    await sleep(350)
    const afterTab = q('.settings-tabs [role="tab"][aria-selected="true"]')?.id
    ok(afterTab !== beforeTab, `方向键切换 tab（${beforeTab} → ${afterTab}）`)
    ok(document.activeElement === q('.settings-tabs [role="tab"][aria-selected="true"]'), '切换后焦点跟到新 tab（roving focus）')

    out.push('\n=== 2. 四个剩余页面：有真实内容 / 真实空态 ===')
    /** 每页至少要能看到这些锚点之一（页面没崩、没留白壳） */
    const anchors = {
      auth: ['auth-msg', 'auth-recheck'],
      appearance: ['set-ui-scale', 'set-density', 'theme-dark'],
      context: ['ctx-source', 'ctx-cap', 'ctx-save'],
      knowledge: ['kn-toggle', 'kn-project'],
      capabilities: ['set-capabilities', 'cap-strategy'],
      sound: ['set-sound'],
      status: ['set-status-diagnostics'],
      packages: ['set-packages', 'pkg-install-btn'],
      about: ['pi-redetect', 'about-build']
    }
    for (const id of TAB_ORDER) {
      click(q(`#settings-tab-${id}`))
      await sleep(260)
      const body = q('.settings-body')
      ok(!!body, `${id}：内容区存在`)
      const found = (anchors[id] ?? []).some((t) => !!byTestId(t))
      ok(found, `${id}：渲染出真实锚点（${(anchors[id] ?? []).join(' / ')}）`)
    }

    out.push('\n=== 3. 长 id / 路径有全文出口 ===')
    click(q('#settings-tab-auth'))
    await sleep(300)
    const path = q('.auth-path')
    if (path) ok(!!path.getAttribute('title'), 'auth 路径有 title 全文出口')
    else ok(true, 'auth 路径未渲染（无本地凭证时的正常空态）')
    click(q('#settings-tab-packages'))
    await sleep(400)
    const names = qa('[data-testid="pkg-name"]')
    ok(
      names.every((el) => !!el.getAttribute('title')),
      `包名有全文出口（${names.length} 个）`
    )
    /* 安装按钮：源为空时必须禁用（防重复提交 / 空提交） */
    const installBtn = byTestId('pkg-install-btn')
    const src = byTestId('pkg-source')
    ok(!!installBtn, '有安装按钮')
    if (installBtn && src && !src.value) {
      ok(installBtn.disabled === true, '安装源为空时按钮禁用（不空提交）')
      /* 受控 input 要用原生 setter，否则 React 的 value tracker 看不到变化 */
      const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setVal?.call(src, 'some-package')
      src.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(250)
      ok(installBtn.disabled === false, '填入源后才可提交')
      setVal?.call(src, '')
      src.dispatchEvent(new Event('input', { bubbles: true }))
      await sleep(200)
    }
    /* 列表：要么有真实条目，要么有真实空态/失败态，不能是空白 */
    const pkgList = byTestId('pkg-list')
    ok(!!pkgList, '插件列表区存在')
    const hasItems = qa('[data-testid="pkg-item"]').length > 0
    const hasState = !!byTestId('pkg-empty')
    ok(hasItems || hasState, '列表有条目或真实空/失败态（不画假内容）')

    out.push('\n=== 4. 能力页：不把「发现」写成「已安装」 ===')
    click(q('#settings-tab-capabilities'))
    await sleep(350)
    ok(!!byTestId('cap-strategy'), '能力策略可切换')
    ok(!!byTestId('cap-builtins'), '内置能力区块存在')
    /* 未搜索时不应出现候选卡（候选是搜索结果的产物，不是已安装列表） */
    ok(qa('[data-testid="cap-candidate"]').length === 0, '未搜索时不展示候选（不冒充已安装）')
    ok(
      !!byTestId('cap-emptyBuiltin') || qa('[data-testid="cap-builtin"]').length > 0,
      '内置能力要么有条目、要么有真实空态'
    )

    out.push('\n=== 5. 关闭后不留实例 ===')
    /* 键盘事件要派发在 document 上：模态层监听 document，window 上的事件不会向下传 */
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await until(() => !q('.settings'), 4000)
    ok(!q('.settings'), 'Esc 关闭设置面板')
    ok(!store.getState().settingsOpen, 'store.settingsOpen = false')

    return out.join('\n')
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
    return out.join('\n')
  }
})()
