/**
 * 项目切换（N05）——在**合成 fixture 项目**上跑（`cwd` 由 test-live 指向它）。
 *
 * `projectlimit` 验的是项目列表的排序/分组/落盘；这里验的是**切过去之后**
 * 的那几件事（HANDOFF 里 N05 的剩余缺口）：
 *   · 视图与文件树真的跟着 cwd 走（不是只改设置里的记录）
 *   · 草稿按运行实例隔离：切走再切回来，A 的草稿还在、B 的不串
 *   · 附件是绝对路径，跨项目不会被错误的 cwd 重解释
 *   · 目标目录不存在 / 读不了时的**真实反馈**（不许假装切成功）
 *
 * ⚠️ 项目列表里的真实点击需要设置里存在该项目记录，而 fixture cwd 是临时目录、
 * 不在项目列表里。所以这里走的就是 `Rail.switchProject` 的实现体
 * （`yan:setCwd` → `newSession` / `switchSession`），不重复点 UI。
 *
 * “不存在的目录”用 fixture 里**从未存在**的路径：这与“先存在、后来被删掉”
 * 在主进程是同一条分支（`stat` 失败 → `工作目录不存在或不可访问`），
 * 而探针在渲染端没有删目录的能力（也不需要为了这条断言加一个 IPC）。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const qa = (s) => [...document.querySelectorAll(s)]
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (fn()) return true
      await sleep(100)
    }
    return false
  }
  const store = window.__yanStore
  const composer = () => q('[data-testid="composer"]')
  const setComposer = (text) => {
    const ta = composer()
    if (!ta) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, text)
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  }
  const rowsOf = () => qa('[data-testid="rp-files"] .rp-fs-row')
  const fsReady = () => !!q('[data-testid="rp-files"]')
  /*
   * 右栏的“文件”分区是可收起的（`ToolSection` 的 `.rp-sec-head`，收起时不渲染内容）。
   * check 里跑时前面有场景会把分区收起，所以这里先把它展开 —— 不能假定默认态。
   */
  const ensureSection = async (id, ms = 6000) => {
    const sec = q(`[data-testid="${id}"]`)
    if (!sec) return false
    const head = sec.querySelector('.rp-sec-head')
    if (head && head.getAttribute('aria-expanded') !== 'true') head.click()
    return until(() => !!q(`[data-testid="${id}"] .rp-sec-body`), ms)
  }
  /* 路径比较：Windows 上 `/` 与 `\` 会混用、大小写不敏感 —— 直接比字符串会假失败 */
  const norm = (p) => (p ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const samePath = (a, b) => !!a && !!b && norm(a) === norm(b)
  const sessionCwd = () => store.getState().session?.cwd ?? ''
  const pathOfCwd = (cwd) => {
    const fromList = (store.getState().sessions.find((s) => samePath(s.cwd, cwd)) ?? {}).path
    if (fromList) return fromList
    /* 新会话不一定马上进会话列表（pi 先建实例、再落盘），但运行实例已经带着会话文件 */
    const fromRunner = store.getState().runners.find((r) => samePath(r.cwd, cwd) && r.sessionFile)
    return fromRunner?.sessionFile ?? ''
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const card = document.querySelector('.ob-card')
      if (!card) break
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) {
        btn.click()
        await sleep(300)
      } else await sleep(150)
    }

    const cwdA = (store.getState().session?.cwd ?? store.getState().settings?.cwd ?? '').replace(/[\\/]+$/, '')
    out.push('=== 0. 环境 ===')
    out.push('  A = ' + cwdA)
    if (!/fixture-project$/i.test(cwdA)) {
      ok(false, 'cwd 不是合成 fixture 项目（test-live 的 fixture: true 没生效）')
      out.push('')
      out.push('[projectswitch] 1 条失败')
      return out.join('\n')
    }
    const cwdB = `${cwdA}/other`
    const cwdNoPerm = `${cwdA}/noperm`
    const cwdGone = `${cwdA}/gone-dir`
    ok(true, 'A 是合成 fixture 项目')

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 1. 打开 A 的会话 + 写草稿 + 加一个附件 ===')
    /*
     * 用**已落盘**的合成会话（`YAN-N05-A`）当「该项目最近访问的会话」：
     * 草稿是按 sessionId 存的，要验「切回来草稿还在」就必须切回同一个会话。
     */
    let sessA = null
    await until(() => {
      sessA = store.getState().sessions.find((s) => /YAN-N05-A/i.test(s.title)) ?? null
      return !!sessA
    }, 15000)
    ok(!!sessA, '会话列表里有 A 的合成会话', sessA?.title ?? '')
    if (sessA) await store.getState().switchSession(sessA.path)
    const inA = await until(() => samePath(sessionCwd(), cwdA), 20000)
    ok(inA, 'A 的会话就绪（session.cwd 指向 A）', sessionCwd())
    const pathA = sessA?.path ?? ''
    ok(!!pathA, '拿到 A 的会话文件（切回时要靠它）', pathA ? pathA.split(/[\\/]/).slice(-1)[0] : '（空）')

    const draftA = 'N05-DRAFT-A'
    setComposer(draftA)
    const draftKept = await until(() => composer()?.value === draftA, 3000)
    ok(draftKept, '草稿写进输入框', composer()?.value ?? '')

    /* 附件走真实的「加入上下文」入口（文件树的加号），不是直接塞 store */
    if (!store.getState().settings?.rightPanelOpen) await store.getState().setRightPanelOpen(true)
    await until(() => fsReady(), 8000)
    ok(await ensureSection('rp-files'), '右栏「文件」分区已展开')
    const fsShown = await until(() => fsReady() && rowsOf().length > 1, 20000)
    if (!fsShown) {
      out.push('  文件树状态元素 = ' + JSON.stringify(qa('[data-testid^="fs-"]').map((e) => e.dataset.testid + ':' + (e.textContent ?? '').trim().slice(0, 24))))
      out.push('  行数 = ' + rowsOf().length + '，settings.cwd = ' + (store.getState().settings?.cwd ?? ''))
    }
    ok(fsShown, 'A 的文件树已加载')
    const addBtn = qa('[data-testid^="fs-add-"]')[0]
    if (addBtn) addBtn.click()
    await sleep(300)
    const attachA = store.getState().attachments
    out.push('  附件 = ' + JSON.stringify(attachA.map((a) => a.path)))
    if (attachA.length === 1) {
      ok(/^[A-Za-z]:[\\/]/.test(attachA[0].path), '附件记录的是绝对路径（不依赖当前 cwd）')
    } else {
      out.push('  ⤺ 跳过附件断言：文件树里没有可加入的文件行（不影响其它断言）')
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 2. 切到项目 B：视图/草稿/文件树都跟着走 ===')
    const setB = await window.yan.setCwd(cwdB)
    ok(setB.ok === true, 'yan:setCwd(B) 成功', setB.error ?? '')
    const sessB = store.getState().sessions.find((s) => /YAN-N05-B/i.test(s.title))
    if (sessB) await store.getState().switchSession(sessB.path)
    else await store.getState().newSession({ cwd: cwdB, scope: 'global' })
    const inB = await until(() => samePath(sessionCwd(), cwdB), 20000)
    ok(inB, 'B 的会话就绪（session.cwd 指向 B）', sessionCwd())
    const draftInB = composer()?.value ?? ''
    out.push('  B 的输入框 = ' + JSON.stringify(draftInB))
    ok(draftInB === '', 'B 看到的是自己的空草稿，不串 A 的草稿')

    const rootInB = await until(() => /other/i.test(q('[data-testid="fs-row-root"]')?.textContent ?? ''), 10000)
    out.push('  B 的文件树根行 = ' + JSON.stringify((q('[data-testid="fs-row-root"]')?.textContent ?? '').trim()))
    ok(rootInB, '文件树根名变成 B 的项目名（不是还停在 A）')

    /*
     * 附件是绝对路径：切项目后既不该消失，也不该被 B 的 cwd 重新解释。
     */
    const attachInB = store.getState().attachments
    if (attachA.length === 1) {
      ok(attachInB.length === 1 && attachInB[0].path === attachA[0].path, '切项目后附件仍在，且路径未被改写')
    }

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 3. 切回项目 A：草稿恢复 + 文件树回到 A ===')
    const setA = await window.yan.setCwd(cwdA)
    ok(setA.ok === true, 'yan:setCwd(A) 成功', setA.error ?? '')
    /*
     * `Rail.switchProject` 里选「最近会话」用的是组件里那份 `sessions`。
     * 刚建的会话要等 pi 落盘后才会进列表，所以这里先刷新一次再选 ——
     * 不刷新就只能靠 `newSession`（新会话 = 新 sessionId，草稿就回不来了）。
     */
    /*
     * 选目标会话用 store 的纯逻辑（与 `Rail.switchProject` 同一处实现）：
     * 运行实例优先，其次会话列表。
     */
    const target = store.getState().pickProjectSession(cwdA)
    out.push('  运行实例 = ' + JSON.stringify(store.getState().runners.map((r) => ({ cwd: r.cwd, file: !!r.sessionFile, run: r.runId }))))
    out.push('  候选会话（列表）= ' + store.getState().sessions.filter((s) => samePath(s.cwd, cwdA)).length + ' 条')
    out.push('  选中的会话 = ' + JSON.stringify(target ? target.split(/[\\/]/).slice(-1)[0] : '（无）'))
    if (target) await store.getState().switchSession(target)
    else await store.getState().newSession({ cwd: cwdA, scope: 'global' })
    const backInA = await until(() => samePath(sessionCwd(), cwdA), 20000)
    ok(backInA, '回到 A 的会话', sessionCwd())
    const draftBack = await until(() => composer()?.value === draftA, 6000)
    out.push('  输入框 = ' + JSON.stringify(composer()?.value ?? ''))
    ok(draftBack, 'A 的草稿原样恢复（按运行实例隔离，不与 B 串）')
    const rootInA = await until(() => /fixture-project/i.test(q('[data-testid="fs-row-root"]')?.textContent ?? ''), 10000)
    ok(rootInA, '文件树根名回到 A')

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 4. 不存在的工作目录：拒绝 + 明确文案，视图不动 ===')
    const settingsBefore = store.getState().settings?.cwd ?? ''
    const sessionBefore = store.getState().session?.cwd ?? ''
    const gone = await window.yan.setCwd(cwdGone)
    out.push('  setCwd(不存在的目录) = ' + JSON.stringify(gone))
    ok(gone.ok === false, '不存在的目录被拒绝')
    ok(/不存在|不可访问/.test(gone.error ?? ''), '错误文案说明是“不存在/不可访问”', gone.error ?? '')
    ok((gone.error ?? '').includes('gone-dir'), '错误文案里带上用户给的那个路径')
    ok((store.getState().session?.cwd ?? '') === sessionBefore, '当前会话的 cwd 没被改掉（视图不动）')
    const settingsAfter = store.getState().settings?.cwd ?? ''
    ok(samePath(settingsAfter, settingsBefore), '设置里的当前项目也没被写坏', settingsAfter)
    ok(!!composer(), '输入框还在（没有因为一次失败切换就白屏）')

    /* ---------------------------------------------------------- */
    out.push('')
    out.push('=== 5. 无权限目录：不假装能读 ===')
    /*
     * 两种真实反馈都算通过，但要**说清是哪种**：
     *   · Windows：`fs.access(R_OK)` 只查属性、不做真实读取，所以这里会切成功，
     *     随后文件树必须明确说「没有读取权限」；
     *   · 类 Unix：access 会失败 → 切换本身就被拒。
     * 无论哪条，都不允许“切过去显示成空目录”。
     */
    const noPerm = await window.yan.setCwd(cwdNoPerm)
    out.push('  setCwd(noperm) = ' + JSON.stringify(noPerm))
    if (noPerm.ok === false) {
      ok(/不可访问|不存在/.test(noPerm.error ?? ''), '无权限目录在切换时就被拒绝', noPerm.error ?? '')
    } else {
      /*
       * 只调 setCwd 只改了设置，文件树还是旧项目的（请求绑定 cwd），
       * 所以这里要真的把视图切过去 —— 与用户点项目走的是同一条路。
       */
      const noticesBefore = store.getState().notices.length
      await store.getState().newSession({ cwd: cwdNoPerm, scope: 'global' })
      const moved = await until(() => samePath(sessionCwd(), cwdNoPerm), 15000)
      if (moved) {
        const permShown = await until(() => !!q('[data-testid="fs-permission"]'), 12000)
        ok(permShown, '切过去后文件树明确给出「没有读取权限」（不是空目录）')
        ok(!q('[data-testid="fs-empty"]'), '没有把它显示成「（空目录）」')
      } else {
        const fresh = store.getState().notices.slice(noticesBefore)
        const err = fresh.filter((n) => n.type === 'error').slice(-1)[0]
        out.push('  在该目录建立会话失败，界面提示 = ' + JSON.stringify(err?.text ?? '（没有提示）'))
        ok(!!err, '切不进无权限目录时给出明确错误，而不是静默失败')
      }
    }

    /* 收尾：切回 A，别把后面的场景（或用户下次打开）留在无权限目录上 */
    await window.yan.setCwd(cwdA)
    if (pathA) await store.getState().switchSession(pathA)
    else await store.getState().newSession({ cwd: cwdA, scope: 'global' })
    await until(() => samePath(sessionCwd(), cwdA), 15000)
    store.getState().clearAttachments()
  } catch (e) {
    ok(false, '抛异常：' + (e && e.message ? e.message : String(e)))
  }

  out.push('')
  const failed = out.filter((l) => l.includes('✗')).length
  out.push(failed === 0 ? '[projectswitch] 全部通过' : '[projectswitch] ' + failed + ' 条失败')
  return out.join('\n')
})()
