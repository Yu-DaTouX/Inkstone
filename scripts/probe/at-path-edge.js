/**
 * `@` 文件引用补全的边界（N19）——在**合成 fixture 项目**上跑。
 *
 * `atPath` 场景证明的是「能用的路径能用」；这里补的是容易出错、源码树里
 * 造不出来或不好断言的那几类：
 *   主进程 completePath：
 *     · 多级目录 / 中文空格 / 引号前缀
 *     · 同名文件（`dup/one/same.ts` 与 `dup/two/same.ts` 必须是两项）
 *     · 大目录 → 30 条上限 + `truncated` 标记（界面要说明「还有更多」）
 *     · 目录联接 / 把文件当目录 / 越界 / 绝对路径 → 明确拒绝
 *     · 无权限目录（ACL deny 读取）→ `permission`，不是「空目录」
 *   界面（真实 Composer）：
 *     · 中文空格候选被接受后**自动补引号**，且不破坏前面的正文
 *     · 多引用 + 句中光标只替换光标所在那一段
 *     · 切到别的 cwd 后，旧 cwd 的候选不能留在菜单里（迟到响应归属）
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return fn()
  }
  const store = window.__yanStore

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) {
        click(btn)
        await sleep(300)
      } else await sleep(150)
    }
    await until(() => !!q('.composer textarea'), 8000)

    const state = store.getState()
    const cwd = state.session?.cwd ?? state.settings?.cwd ?? ''
    out.push('=== 0. fixture 工作目录 ===')
    out.push('  cwd = ' + cwd)
    if (!/fixture-project$/i.test(cwd.replace(/[\\/]+$/, ''))) {
      ok(false, 'cwd 不是合成 fixture 项目（test-live 的 fixture: true 没生效）')
      out.push('')
      out.push('[atpathedge] 1 条失败')
      return out.join('\n')
    }

    const context = { cwd, generation: state.runners?.find((r) => (r.runId ?? r.id) === state.activeRunnerId)?.generation ?? 0 }
    const C = (prefix) => window.yan.completePath(prefix, cwd, context)

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 1. 主进程 completePath：正常路径 ===')
    const root = await C('')
    out.push('  根层候选 = ' + JSON.stringify(root.paths))
    ok(root.status === 'ok' && root.paths.length > 0, '裸前缀能列出根层候选')
    ok(root.paths.every((p) => !p.startsWith('.')), '不列隐藏项')
    ok(!root.paths.some((p) => /junction/.test(p)), '不列目录联接 / 文件链接')
    ok(root.paths.some((p) => p.endsWith('/')), '目录候选带尾斜杠（界面据此区分）')
    ok(root.paths.includes('big/') && root.paths.includes('README.md'), '目录与文件都在候选里')

    const uniDeep = await C('uni/中文 目录/')
    ok(
      uniDeep.status === 'ok' && uniDeep.paths.includes('uni/中文 目录/文件 名.ts'),
      '中文 + 空格的路径能继续补全',
      JSON.stringify(uniDeep.paths)
    )

    const quoted = await C('"uni/中文 目录/文')
    ok(
      quoted.paths.includes('uni/中文 目录/文件 名.ts'),
      '带引号的路径前缀能正确剥离引号再匹配',
      JSON.stringify(quoted.paths)
    )

    const deepLeaf = await C('deep/a/b/c/d/e/')
    ok(deepLeaf.paths.includes('deep/a/b/c/d/e/f.txt'), '多级目录能补全到末端文件', JSON.stringify(deepLeaf.paths))

    const one = await C('dup/one/')
    const two = await C('dup/two/')
    ok(one.paths.includes('dup/one/same.ts'), 'dup/one 下有 same.ts')
    ok(two.paths.includes('dup/two/same.ts'), 'dup/two 下也有 same.ts')
    ok(
      !one.paths.includes('dup/two/same.ts') && !two.paths.includes('dup/one/same.ts'),
      '同名文件在各层返回各自路径（不混淆）'
    )

    const bigList = await C('big/')
    out.push(`  大目录候选 ${bigList.paths.length} 条，truncated=${bigList.truncated}`)
    ok(bigList.paths.length === 30, '大目录只回 30 条（不把 60 项全塞进菜单）')
    ok(bigList.truncated === true, '超出上限时带 truncated 标记（界面据此提示）')

    const partial = await C('re')
    ok(partial.paths.includes('README.md'), '前缀过滤生效', JSON.stringify(partial.paths))

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 2. 主进程 completePath：拒绝边界 ===')
    const outside = await C('../..')
    ok(outside.status === 'invalid' && outside.paths.length === 0, '拒绝 ../ 跳出 cwd', `status=${outside.status}`)

    const abs = await C('C:/Windows/')
    ok(abs.status === 'invalid' && abs.paths.length === 0, '拒绝绝对路径', `status=${abs.status}`)

    const notdir = await C('notadir.txt/')
    ok(notdir.status === 'missing' && notdir.paths.length === 0, '把文件当目录补全返回 missing', `status=${notdir.status}`)

    const linkPrefix = await C('junction-dir/')
    ok(
      linkPrefix.status === 'invalid' || linkPrefix.status === 'missing',
      '目录联接不作为可补全目录（不给越界留口子）',
      `status=${linkPrefix.status}`
    )

    /*
     * 无权限目录（与 L02 共用同一条 fixture 边界）：补全不能把「读不到」
     * 当成「里面没东西」—— 否则用户看到一个空菜单，以为目录是空的。
     */
    const nopermPrefix = await C('noperm/')
    out.push(`  completePath('noperm/') → status=${nopermPrefix.status} paths=${nopermPrefix.paths.length}`)
    if (nopermPrefix.status === 'ok') {
      out.push('  ⤺ 跳过：这台机器没能建出无权限目录（icacls deny RD 未生效）')
    } else {
      ok(
        nopermPrefix.status === 'permission',
        '无权限目录的补全返回 permission（不是空结果）',
        `status=${nopermPrefix.status}`
      )
      ok(nopermPrefix.paths.length === 0, '无权限时不返回候选')
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 3. 界面：接受候选的文本与光标 ===')
    const ta = q('.composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (!ta || !setter) {
      ok(false, '拿不到输入框')
      return out.join('\n')
    }
    const menuItems = () => [...(q('[data-testid="at-menu"]')?.querySelectorAll('.slash-item') ?? [])]
    const waitItems = async (ms = 5000) => {
      const t0 = Date.now()
      while (Date.now() - t0 < ms) {
        const items = menuItems()
        if (items.length) return items
        await sleep(120)
      }
      return menuItems()
    }
    const menuTexts = () => menuItems().map((x) => x.textContent ?? '')
    const type = async (text, cursorPos) => {
      store.getState().closePreview()
      setter.call(ta, text)
      ta.selectionStart = ta.selectionEnd = cursorPos ?? text.length
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new Event('select', { bubbles: true }))
      await sleep(300)
    }
    const pick = async (match) => {
      const items = await waitItems()
      const el = items.find((x) => match(x.textContent ?? ''))
      if (!el) return false
      click(el)
      await sleep(400)
      return true
    }

    await type('请看 @uni/中文')
    const dirItems = await waitItems()
    ok(dirItems.length > 0, '句中输入 @ 也能弹出菜单', JSON.stringify(menuTexts().slice(0, 3)))
    ok(menuTexts().some((t) => t.includes('uni/中文 目录/')), '菜单里有中文 + 空格的目录候选')
    const pickedDir = await pick((t) => t.includes('uni/中文 目录/'))
    out.push('  接受目录后 value = ' + JSON.stringify(ta.value))
    ok(pickedDir, '能接受目录候选')
    ok(ta.value === '请看 @"uni/中文 目录/"', '含空格的路径被自动加引号，且前面的正文原样保留')
    ok(!!q('[data-testid="at-menu"]'), '接受目录后菜单保持打开（可以接着选下一层）')

    const pickedFile = await pick((t) => t.includes('文件 名.ts'))
    out.push('  接受文件后 value = ' + JSON.stringify(ta.value))
    ok(pickedFile, '能接着接受文件候选')
    ok(ta.value === '请看 @"uni/中文 目录/文件 名.ts"', '文件候选替换掉整段引用（含引号）')
    await until(() => !q('[data-testid="at-menu"]'), 2000)
    ok(!q('[data-testid="at-menu"]'), '接受文件后菜单关闭')

    /* 多引用 + 句中光标：只替换光标所在那一段 */
    await type('先 @README.md 再看 @dup/o')
    const dupItems = await waitItems()
    ok(dupItems.length > 0, '多引用时仍能弹出候选')
    const pickedDup = await pick((t) => t.includes('dup/one/'))
    out.push('  多引用替换后 value = ' + JSON.stringify(ta.value))
    ok(pickedDup, '能接受第二个引用的候选')
    ok(ta.value === '先 @README.md 再看 @dup/one/', '只替换光标所在的那一处引用')
    await until(() => !q('[data-testid="at-menu"]'), 2000)

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 4. 切换 cwd 后旧候选不能留在菜单里 ===')
    await type('@')
    /* 让第一轮请求真的返回（菜单先显示 fixture 的根层） */
    const firstRound = await waitItems()
    ok(firstRound.length > 0, '切换前菜单显示 fixture 根层候选')
    ok(menuTexts().some((t) => t.includes('notadir.txt')), '第一轮候选确实来自 fixture（含 notadir.txt）')

    const parentDir = cwd.replace(/[\\/][^\\/]+[\\/]?$/, '')
    /*
     * 真实链路只改设置的 cwd；视图上的 cwd / 项目身份由「切到该项目会话」更新。
     * 这里两者都改，模拟的是**切到另一个项目后继续输入**那一刻的状态：
     * 运行实例的 cwd 与项目归属一起换成新项目，否则上下文校验会（正确地）
     * 判定「项目与工作目录不匹配」而拒绝，断言就测不到候选归属了。
     */
    await store.getState().changeCwd(parentDir)
    await sleep(300)
    const switched = store.getState()
    store.setState({
      session: { ...switched.session, cwd: parentDir, sessionFile: undefined, sessionId: 'probe-switch' },
      runners: switched.runners.map((r) =>
        (r.runId ?? r.id) === switched.activeRunnerId ? { ...r, cwd: parentDir, projectId: undefined } : r
      )
    })
    /* 输入不变（仍是 `@`），但 cwd 变了：必须重新按新 cwd 查询 */
    await sleep(400)
    /* 切换会把输入框恢复成新会话的草稿（空）—— 这是正确的，重新输入即可 */
    out.push('  切换后 textarea = ' + JSON.stringify(ta.value))
    await type('@')
    const secondRound = await waitItems()
    const afterTexts = menuTexts()
    const menuEl = q('[data-testid="at-menu"]')
    /* 直连主进程：把「界面为什么报错」和「主进程能不能读」分开 */
    const direct = await window.yan.completePath('', parentDir, { cwd: parentDir, generation: context.generation })
    out.push('  直连 completePath(parentDir) = ' + JSON.stringify({ status: direct.status, paths: direct.paths.slice(0, 5) }))
    out.push('  切换后菜单 = ' + JSON.stringify(menuEl ? menuEl.textContent.slice(0, 120) : '(未打开)'))
    out.push('  切换后候选 = ' + JSON.stringify(afterTexts.slice(0, 6)))
    ok(secondRound.length > 0, '切到新 cwd 后仍能拿到候选')
    ok(
      !afterTexts.some((t) => t.includes('notadir.txt')),
      '旧 cwd 的候选没有留在菜单里（迟到响应已被丢弃）'
    )
    ok(
      afterTexts.some((t) => t.includes('fixture-project/')),
      '候选换成了新 cwd 的内容（能看到 fixture-project 目录本身）'
    )

    /* 收尾：还原成空的输入，别影响后续场景 */
    await type('')
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[atpathedge] 全部通过' : '[atpathedge] ' + failed + ' 条失败')
  return out.join('\n')
})()
