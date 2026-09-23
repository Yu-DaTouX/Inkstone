/*
 * 设置页异步与项目漂移（实施-13 V-3 / 审核问题表 R10·R11，cost 0，不调模型）。
 *
 * 先复现、再定范围 —— 这一条验的是「设置页打开期间项目变了会怎样」：
 *   ① 切会话后设置面板还在不在（在的话界面会不会跟着刷新项目身份）；
 *   ② 迟到的旧请求会不会覆盖新项目的结果（请求代次）；
 *   ③ 来源跳转 / 导出的 IPC reject 有没有就地反馈，而不是变成
 *      unhandled rejection（用户什么都看不到）。
 *
 * ⚠️ 判据是**界面行为**，不是主进程身份（那是 `knowledge-isolation` 的范围）。
 * ②③ 需要替换 `window.yan.knowledge.*`：contextBridge 暴露的对象通常是只读的，
 * 所以先做**真实判定**（拿哨兵函数比引用，不能自赋值 —— 只读赋值会静默失败，
 * 自赋值永远是 true，那是假阳性）。替换不了就如实跳过，不伪造通过。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const skip = (s) => out.push('  ~ ' + s)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const S = () => store.getState()
  const until = async (fn, ms = 15000) => {
    const t0 = Date.now()
    for (;;) {
      const v = fn()
      if (v) return v
      if (Date.now() - t0 > ms) return null
      await sleep(150)
    }
  }
  const norm = (p) => String(p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const projectText = () => q('[data-testid="kn-project"]')?.textContent?.trim() ?? null
  const emptyCounts = { all: 0, active: 0, candidate: 0, review: 0 }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = q('.ob-card')
      if (!card) break
      const b = [...card.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) b.click()
      await sleep(250)
    }
    for (let i = 0; i < 60; i++) {
      if (S().conn === 'ready') break
      await sleep(500)
    }

    /* 找两条 cwd 不同的会话（projectSessions fixture 提供 N05-A / N05-B） */
    const byCwd = new Map()
    for (const s of S().sessions ?? []) {
      const key = norm(s.cwd)
      if (key && !byCwd.has(key)) byCwd.set(key, s)
    }
    const pairs = [...byCwd.values()]
    out.push(`  会话按 cwd 去重后 ${pairs.length} 个项目：${pairs.map((s) => s.title).join(' | ')}`)
    if (pairs.length < 2) {
      ok(false, '需要两个不同 cwd 的会话才能验项目漂移（fixture 没造出来？）')
      return out.join('\n')
    }

    const switchTo = async (session) => {
      await S().switchSession(session.path)
      await until(() => (norm(S().session?.cwd) === norm(session.cwd) ? S().session : null), 30000)
      await sleep(600)
    }

    await switchTo(pairs[0])
    S().openSettings('knowledge')
    const first = await until(() => projectText(), 12000)
    out.push(`  A 项目（${pairs[0].title}）设置页项目标识 = ${JSON.stringify(first)}`)
    ok(!!first, '设置页报告了当前项目身份')

    /* ---- ① 设置页打开期间切到另一个项目 ---- */
    await switchTo(pairs[1])
    const panelAlive = !!q('[data-testid="kn-project"]')
    out.push(`  切到 B（${pairs[1].title}）后设置面板还在=${panelAlive}`)
    ok(panelAlive, '设置面板没有被切会话关掉（R10 的前提成立）')
    if (panelAlive) {
      const after = await until(() => {
        const v = projectText()
        return v && v !== first ? v : null
      }, 8000)
      out.push(`  切到 B 之后设置页项目标识 = ${JSON.stringify(projectText())}（期望 ${pairs[1].cwd}）`)
      ok(after !== null, '切会话后项目身份跟着刷新（不是停在 A 的旧列表）')
    }

    /* ---- ④ 宿主拒绝项目身份漂移（R10 的写侧，可直接调 IPC，不需要注入） ---- */
    {
      const bogus = await window.yan.knowledge.action({
        action: 'confirm',
        id: 'whatever',
        expectedRevision: 1,
        expectedProjectId: 'BOGUS-project'
      })
      out.push(`  带错误 expectedProjectId 的写操作 = ${JSON.stringify(bogus)}`)
      ok(bogus?.ok === false && /项目已切换/.test(bogus?.error ?? ''), '宿主拒绝项目身份漂移')
      const legacy = await window.yan.knowledge.action({ action: 'confirm', id: 'definitely-missing', expectedRevision: 1 })
      out.push(`  不带身份字段的写操作 = ${JSON.stringify(legacy)}`)
      ok(
        legacy?.ok === false && !/项目已切换/.test(legacy?.error ?? ''),
        '不带身份字段时不做漂移判定（兼容旧调用）'
      )
    }

    /* ---- ② 迟到的旧结果不得覆盖新结果（代次） ---- */
    const sentinel = async () => ({ ok: true, enabled: true, projectId: 'PROBE-SENTINEL', entries: [], counts: emptyCounts })
    let methodPatch = false
    let topPatch = false
    const desc = Object.getOwnPropertyDescriptor(window, 'yan')
    const kdesc = Object.getOwnPropertyDescriptor(window.yan ?? {}, 'knowledge')
    try {
      const orig = window.yan.knowledge.list
      window.yan.knowledge.list = sentinel
      methodPatch = window.yan.knowledge.list === sentinel
      window.yan.knowledge.list = orig
    } catch {
      methodPatch = false
    }
    try {
      const prev = window.yan
      window.yan = { ...prev, knowledge: { ...prev.knowledge, list: sentinel } }
      topPatch = window.yan?.knowledge?.list === sentinel
      window.yan = prev
    } catch {
      topPatch = false
    }
    out.push(
      `  patch 诊断：window.yan writable=${desc?.writable} configurable=${desc?.configurable}；` +
        `knowledge writable=${kdesc?.writable} configurable=${kdesc?.configurable}`
    )
    out.push(`  patch 可行：改方法=${methodPatch}，换 window.yan=${topPatch}`)

    const setList = (fn) => {
      if (methodPatch) window.yan.knowledge.list = fn
      else window.yan = { ...window.yan, knowledge: { ...window.yan.knowledge, list: fn } }
    }
    const setExport = (fn) => {
      if (methodPatch) window.yan.knowledge.export = fn
      else window.yan = { ...window.yan, knowledge: { ...window.yan.knowledge, export: fn } }
    }
    const canPatch = methodPatch || topPatch

    if (canPatch) {
      const origList = window.yan.knowledge.list
      /*
       * 伪造两次可区分的响应：第 1 次故意迟到（旧项目的），第 2 次立即（新项目的）。
       * 代次存在 → 最终显示 PROBE-2；没有 → 迟到的 PROBE-1 会覆盖它。
       */
      let call = 0
      setList(async () => {
        call += 1
        const n = call
        if (n === 1) await sleep(1800)
        return { ok: true, enabled: true, projectId: 'PROBE-' + n, entries: [], counts: emptyCounts }
      })
      const session = S().session
      const base = session?.cwd ?? 'C:/probe-base'
      /* 用会话 cwd 变化触发两次刷新（组件就是在它变化时重取的） */
      store.setState({ session: { ...(session ?? {}), cwd: base + '-a' } })
      await sleep(80)
      store.setState({ session: { ...(session ?? {}), cwd: base + '-b' } })
      await sleep(3200)
      const finalText = projectText()
      out.push(`  两次并发刷新之后项目标识 = ${JSON.stringify(finalText)}（期望 PROBE-2）`)
      ok(String(finalText).includes('PROBE-2'), '迟到的旧结果没有覆盖当前项目（请求代次生效）')
      setList(origList)
      await sleep(300)
    } else {
      skip('window.yan 只读（contextBridge），跳过「迟到旧结果」这一维（不改判为通过）')
    }

    /* ---- ③ IPC reject 的就地反馈 ---- */
    if (canPatch) {
      const origExport = window.yan.knowledge.export
      let unhandled = 0
      const onUnhandled = () => {
        unhandled += 1
      }
      window.addEventListener('unhandledrejection', onUnhandled)
      setExport(async () => {
        throw new Error('probe: 传输异常')
      })
      S().openSettings('knowledge')
      await sleep(500)
      const btn = q('[data-testid="kn-export-save"]')
      ok(!!btn, '导出按钮在（reject 反馈的触发点）')
      if (btn) {
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        await sleep(900)
        const notice = q('[data-testid="kn-notice"]')?.textContent?.trim() ?? null
        out.push(`  导出 IPC 抛错后：notice=${JSON.stringify(notice)} unhandled=${unhandled}`)
        ok(!!notice, '导出失败有就地反馈（不是静默）')
        ok(unhandled === 0, '没有 unhandled rejection')
      }
      setExport(origExport)
      window.removeEventListener('unhandledrejection', onUnhandled)
    } else {
      skip('window.yan 只读，跳过 IPC reject 反馈这一维（源码层 catch 无法在 live 里注入）')
    }
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[knowledgeasync] 全部通过' : '[knowledgeasync] ' + failed + ' 条失败')
  return out.join('\n')
})()
