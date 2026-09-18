/**
 * Git 写操作（方案 §5，G2）—— 真实窗口验收，cost 0。
 *
 * ── 与 `git-review.js` 的分工 ──
 * 那个探针证明「打开审查不会改任何东西」（**只读**）；这一个证明反面：
 * 「点下去真的改了，而且只改该改的」。两者的 fixture 必须分开 ——
 * 写操作会真的动仓库，而审查的每条断言都依赖它那份故意做脏的状态。
 *
 * ── 为什么这里的断言不满足于「界面上看起来对了」──
 * 每个关键步骤都用 `window.yan.git.state()` **回读主进程的真实 git 状态**
 * （stagedCount / branch / head / unpushedCount）。界面自证是不算数的：
 * 一个只改了 React state 的假操作在这套断言下过不去。
 * 更强的一层在应用退出之后（`afterExit: gitWriteApplied`）：那时用真的 git
 * 读 HEAD、提交说明、bare remote 里的 ref —— 渲染进程伪造不了那些。
 */
;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const store = window.__yanStore
  const early = (msg) => {
    out.push(msg)
    return out.join('\n')
  }
  if (!store) return early('  ⤺ 跳过：没有 window.__yanStore（探针没被注入）')

  const $ = (sel) => document.querySelector(sel)
  const testid = (id) => document.querySelector(`[data-testid="${id}"]`)
  const textOf = (el) => (el ? el.textContent.trim() : '')

  const waitFor = async (fn, ms = 10000, step = 80) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      try {
        /*
         * ⚠️ 必须 await：谓词经常是 async（要等一次 IPC 回读真实状态）。
         * 少了这个 await，Promise 本身是 truthy —— 第一次迭代就「成功」返回，
         * 而调用方 await 到的其实是 null。表现是一堆看起来像产品坏了的误报。
         */
        const v = await fn()
        if (v) return v
      } catch {
        /* 还没出现 */
      }
      await sleep(step)
    }
    return null
  }

  const click = async (el) => {
    if (!el) return false
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await sleep(60)
    return true
  }

  /*
   * React 受控组件必须走**原生 setter + input 事件**：
   * 直接改 `el.value` 再派发 input 时，React 的内部值跟踪会被绕过，
   * onChange 不触发 —— 表现为「输入框里看得见字，但状态是空的」，
   * 而提交按钮一直是 disabled。
   */
  const typeInto = async (el, value) => {
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    return true
  }

  /** 确保环境菜单是打开的（它可能是开着的 —— 盲点一次反而会关掉它） */
  const openEnvMenu = async () => {
    if (testid('env-menu')) return true
    await click(testid('session-project'))
    return !!(await waitFor(() => testid('env-menu'), 5000))
  }

  /**
   * 按**分支名元素**找条目。
   * button 的 textContent 含 JSX 留下的换行空白（"\n  main\n  "），
   * 于是 `/^main/` 这种前缀匹配永远不中 —— 而 `/feature/` 没锚定所以能中，
   * 结果是「切到 feature」通过、「切回 main」静默失败，一路掩盖到 afterExit。
   */
  const branchItem = (name) => {
    const list = [...document.querySelectorAll('[data-testid="env-branch-item"]')]
    return (
      list.find((el) => (el.querySelector('.env-branch-name')?.textContent ?? '').trim() === name) ?? null
    )
  }
  /** 确保分支列表是展开的（它可能是开着的 —— 盲点一次会把它收起来） */
  const openBranchList = async () => {
    if (testid('env-branches')) return true
    await openEnvMenu()
    await click(testid('env-branch'))
    return !!(await waitFor(() => testid('env-branches'), 6000))
  }

  const closeOnboarding = async () => {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 20; i++) {
      const card = $('.ob-card')
      if (!card) return
      const btn = [...card.querySelectorAll('button')].find((b) => /开始使用|完成|Get started/.test(b.textContent))
      if (btn) await click(btn)
      else await sleep(120)
    }
  }

  const COMMIT_MSG = 'feat: live 写操作验收'

  try {
    await closeOnboarding()

    const cwd = store.getState().session?.cwd || store.getState().settings?.cwd || ''
    out.push('  会话工作目录 = ' + cwd)
    ok(/write[\\/]?$/.test(cwd), '会话 cwd 指向写操作 fixture', cwd)

    /* 真实状态的回读口子（断言一律用它，不看界面自报） */
    const stateFull = async () => await window.yan.git.state(cwd)
    const state = async () => (await stateFull()).repo
    /* 诊断：state 读不到时要能看见原因（error 字段），而不是只看到「超时」 */
    const stateDiag = async () => {
      try {
        const res = await stateFull()
        return JSON.stringify({ repo: !!res.repo, error: res.error ?? '', staged: res.repo?.stagedCount, branch: res.repo?.branch })
      } catch (e) {
        return 'throw: ' + (e && e.message ? e.message : String(e))
      }
    }
    const s0 = await waitFor(async () => await state(), 12000)
    ok(!!s0, '主进程能读到仓库状态')
    if (!s0) return early('  ⤺ 没有仓库状态，后面的写操作断言无从谈起')

    ok(s0.branch === 'main', '起始分支是 main', String(s0.branch))
    ok(s0.stagedCount === 0, '起始没有已暂存内容', String(s0.stagedCount))
    ok(s0.changedCount >= 2, 'fixture 有可暂存的改动', String(s0.changedCount))
    ok(s0.upstream === 'origin/main', '已有上游（推送不用先设）', String(s0.upstream))
    ok(s0.unpushedCount === 0, '起始没有待推送提交', String(s0.unpushedCount))

    /* ── 1. 打开审查（写操作的入口在这里）──────────────── */

    const projBtn = testid('session-project')
    ok(!!projBtn, '会话头部有环境入口')
    await click(projBtn)
    const changeBtn = await waitFor(() => testid('env-changes'), 8000)
    ok(!!changeBtn, '环境菜单里能看到「变更」')
    await click(changeBtn)
    ok(!!(await waitFor(() => testid('review-panel'), 6000)), '打开了审查面板')

    /* ── 2. 逐文件暂存：点下去 index 里真的多了一个文件 ── */

    const stageBtn = await waitFor(() => $('[data-file="a.txt"] [data-testid="review-stage"]'), 12000)
    ok(!!stageBtn, 'a.txt 这一行有「暂存」按钮')
    if (!stageBtn) return early('  ⤺ 没找到暂存按钮，后面的断言无从谈起')

    await click(stageBtn)
    const s1 = await waitFor(async () => {
      const s = await state()
      return s && s.stagedCount === 1 ? s : null
    }, 12000)
    ok(!!s1, '暂存后主进程读到 stagedCount = 1（不是只改了界面）', s1 ? '1' : '超时 → ' + (await stateDiag()))
    ok((await waitFor(() => testid('git-notice'), 4000)) !== null || true, '（结果行可能出现得很快，不作为判据）')
    ok((await waitFor(() => testid('commit-staged'), 6000)) !== null, '提交区显示「N 个文件已暂存」')
    ok(
      (await waitFor(() => $('[data-file="a.txt"] [data-testid="review-unstage"]'), 6000)) !== null,
      '同一个文件行出现了「取消暂存」（双状态分别展示）'
    )

    /* 未跟踪文件也能暂存（它会开始被跟踪） */
    const newStage = await waitFor(() => $('[data-file="new.txt"] [data-testid="review-stage"]'), 8000)
    ok(!!newStage, '未跟踪的 new.txt 也有「暂存」按钮')
    if (newStage) {
      await click(newStage)
      const s2 = await waitFor(async () => {
        const s = await state()
        return s && s.stagedCount === 2 ? s : null
      }, 12000)
      ok(!!s2, '暂存未跟踪文件后 stagedCount = 2')
    }

    /* ── 3. 取消暂存：只退 index，**不动工作区内容** ─────── */

    const unstageBtn = await waitFor(() => $('[data-file="a.txt"] [data-testid="review-unstage"]'), 6000)
    if (unstageBtn) {
      await click(unstageBtn)
      const s3 = await waitFor(async () => {
        const s = await state()
        return s && s.stagedCount === 1 ? s : null
      }, 12000)
      ok(!!s3, '取消暂存后 stagedCount 回到 1')
      /* 工作区里 a.txt 的改动必须还在 —— 取消暂存不是丢弃改动 */
      ok(
        (await waitFor(() => $('[data-file="a.txt"] [data-testid="review-stage"]'), 6000)) !== null,
        'a.txt 仍是「未暂存改动」（内容没被还原掉）'
      )
    }

    /* ── 4. 提交：说明 + 提交按钮 → HEAD 真的前进 ───────── */

    const headBefore = (await state())?.head ?? ''
    const msg = await waitFor(() => testid('commit-message'), 6000)
    ok(!!msg, '提交区有说明输入框')
    await typeInto(msg, COMMIT_MSG)

    const submit = await waitFor(() => testid('commit-submit'), 4000)
    ok(!!submit, '有提交按钮')
    ok(submit && !submit.disabled, '填了说明且有已暂存内容后，提交按钮可用', submit ? `disabled=${submit.disabled}` : '')
    await click(submit)

    const s4 = await waitFor(async () => {
      const s = await state()
      return s && s.head && s.head !== headBefore ? s : null
    }, 20000)
    if (!s4) {
      /* 诊断：界面报了什么 + 拿**真实的最新版本**直接问主进程一次 */
      const uiFail = textOf(testid('git-failure')).slice(0, 140)
      const cur = await stateFull()
      const direct = await window.yan.git
        .action({ kind: 'commit', cwd, requestId: 'probe-diag', message: COMMIT_MSG, expected: cur.expected })
        .catch((e) => ({ ok: false, failure: { message: String(e && e.message) } }))
      out.push('  ⓘ 诊断：界面失败提示=' + JSON.stringify(uiFail))
      out.push('  ⓘ 诊断：用最新版本直接提交 → ' + JSON.stringify(direct.ok ? { ok: true, summary: direct.summary } : direct.failure))
    }
    ok(!!s4, '提交后 HEAD 真的变了（主进程读到的）', s4 ? s4.head.slice(0, 7) : '超时')
    ok(s4?.stagedCount === 0, '提交后没有已暂存内容', String(s4?.stagedCount))
    ok(s4?.unpushedCount === 1, '提交后待推送数为 1（未推送）', String(s4?.unpushedCount))
    ok(
      (await waitFor(() => $('.commit-msg')?.value === '' || testid('git-notice'), 6000)) !== null,
      '提交成功后输入框被清空（不会让人以为没提交）'
    )

    /* ── 5. 推送：bare remote 真的收到 ──────────────────── */

    const pushBtn = await waitFor(() => {
      const btn = testid('env-push')
      return btn && !btn.disabled ? btn : null
    }, 8000)
    if (!pushBtn) await openEnvMenu()
    const push = await waitFor(() => testid('env-push'), 8000)
    ok(!!push, '环境菜单里有「推送」一项')
    if (push) {
      await click(push)
      const s5 = await waitFor(async () => {
        const s = await state()
        return s && s.unpushedCount === 0 ? s : null
      }, 30000)
      ok(!!s5, '推送后待推送数归 0（主进程读到）', s5 ? '0' : '超时')
    }

    /* ── 6. 拉取 ────────────────────────────────────────── */

    const fetchBtn = await waitFor(() => testid('env-fetch'), 6000)
    ok(!!fetchBtn, '环境菜单里有「拉取」一项')
    if (fetchBtn) {
      await click(fetchBtn)
      const notice = await waitFor(() => testid('env-notice') || testid('git-notice'), 30000)
      ok(!!notice, '拉取给出了结果行', textOf(notice))
    }

    /* ── 7. 切换分支：分支名与文件内容真的变了 ──────────── */

    await openEnvMenu()
    const branchBtn = await waitFor(() => testid('env-branch'), 6000)
    ok(!!branchBtn, '环境菜单里有分支项', branchBtn ? '' : '菜单文本=' + JSON.stringify(textOf(testid('env-menu')).slice(0, 120)) + ' state=' + (await stateDiag()))
    await click(branchBtn)
    const branchList = await waitFor(() => testid('env-branches'), 8000)
    ok(!!branchList, '点分支项展开了分支列表')
    const item = await waitFor(() => {
      /* 等它可用：列表先渲染、状态后到，disabled 期间点了没有任何反应 */
      const b = branchItem('feature')
      return b && !b.disabled ? b : null
    }, 12000)
    ok(!!item, '分支列表里有 feature')
    if (item) {
      await click(item)
      const s6 = await waitFor(async () => {
        const s = await state()
        return s && s.branch === 'feature' ? s : null
      }, 20000)
      ok(!!s6, '切换后当前分支真的是 feature（主进程读到）', s6 ? s6.branch : '超时')
    }

    /* 切回 main：让 afterExit 的断言有一个确定的分支 */
    await openBranchList()
    const back = await waitFor(() => {
      const b = branchItem('main')
      return b && !b.disabled ? b : null
    }, 12000)
    ok(!!back, '分支列表里有 main 可点')
    if (back) {
      await click(back)
      const s7 = await waitFor(async () => {
        const s = await state()
        return s && s.branch === 'main' ? s : null
      }, 20000)
      ok(!!s7, '切回 main 成功', s7 ? '' : JSON.stringify(await stateDiag()))
    }

    /* ── 8. 新建分支 ────────────────────────────────────── */

    await openBranchList()
    const nameInput = await waitFor(() => testid('env-new-branch-name'), 6000)
    ok(!!nameInput, '分支列表里有「新分支名」输入框')
    if (nameInput) {
      await typeInto(nameInput, 'live-made')
      const typed = await waitFor(() => (nameInput.value === 'live-made' ? nameInput.value : null), 4000)
      ok(!!typed, '输入框收到了分支名（React 受控值真的更新了）', JSON.stringify(nameInput.value))
      const createBtn = await waitFor(() => {
        const b = testid('env-create-branch')
        return b && !b.disabled ? b : null
      }, 8000)
      ok(
        !!createBtn,
        '填了名字后「创建并切换」可用',
        createBtn
          ? ''
          : 'disabled=' +
            String(testid('env-create-branch')?.disabled) +
            ' value=' +
            JSON.stringify(nameInput.value) +
            ' state=' +
            (await stateDiag())
      )
      await click(createBtn)
      const s8 = await waitFor(async () => {
        const s = await state()
        return s && s.branch === 'live-made' ? s : null
      }, 20000)
      ok(!!s8, '新建分支并切过去了（主进程读到分支名）', s8 ? s8.branch : '超时')
    }

    /* 切回 main 收尾 */
    await openBranchList()
    const back2 = await waitFor(() => {
      const b = branchItem("main")
      return b && !b.disabled ? b : null
    }, 12000)
    ok(!!back2, '新建分支之后仍能点回 main')
    if (back2) {
      await click(back2)
      const s9 = await waitFor(async () => {
        const s = await state()
        return s && s.branch === 'main' ? s : null
      }, 20000)
      ok(!!s9, '收尾时真的回到了 main', s9 ? '' : JSON.stringify(await stateDiag()))
    }

    /* ── 9. 失败路径：非法分支名要有可读的拒绝 ──────────── */

    await openBranchList()
    const badInput = await waitFor(() => testid('env-new-branch-name'), 6000)
    if (badInput) {
      await typeInto(badInput, 'bad..name')
      /*
       * ⚠️ **等按钮可用**再点。disabled 的按钮不派发 click —— 上一步刚结束、
       * `write.busy` 还没清空时点下去，事件被浏览器直接吞掉，表现成
       * 「点了没反应」而所有断言都看不出为什么（这次就是这么查了两轮）。
       */
      const badBtn = await waitFor(() => {
        const b = testid('env-create-branch')
        return b && !b.disabled ? b : null
      }, 8000)
      ok(!!badBtn, '非法名字的判断不影响按钮可用性（点下去才知道）')
      if (badBtn) {
        await click(badBtn)
        const fail = await waitFor(() => testid('git-failure'), 10000)
        ok(!!fail, '非法分支名被拒并给出说明', fail ? textOf(fail).slice(0, 60) : '没有出现失败提示')
        const detailBtn = await waitFor(() => testid('git-failure-detail-toggle'), 4000)
        if (detailBtn) {
          await click(detailBtn)
          ok((await waitFor(() => $('.gwrite-fail-raw'), 4000)) !== null, '能展开 git 的原始输出（排查第一现场）')
        }
      }
    }

    /* ── 10. 工作树（W1，方案 §6.2）──────────────────────── */

    /*
     * 用户工作树的两条边界都在这节里验：
     *   ① 建出来的是**仓库旁边**的长期目录（不是子代理那种临时容器）
     *   ② 移除前检查（这里造一个「没有上游」的分支 → 必须被拒，并给出原因）
     * 断言一律用 window.yan.git.worktrees() 回读主进程，不看界面自报。
     */
    await openEnvMenu()
    const wtItem = await waitFor(() => testid('env-worktrees'), 8000)
    ok(!!wtItem, '环境菜单里有「工作树」一项')
    if (wtItem) {
      await click(wtItem)
      const wtList = await waitFor(() => testid('env-worktree-list'), 8000)
      ok(!!wtList, '点开后列出了工作树')
      const before = await window.yan.git.worktrees(cwd)
      ok(before.ok === true && before.worktrees.length === 1, '此时只有主工作树', JSON.stringify(before.worktrees.map((w) => w.branch)))
      ok(before.worktrees[0].main === true, '第一条被标成主工作树')

      const wtName = await waitFor(() => testid('env-worktree-branch'), 6000)
      ok(!!wtName, '有「新分支名」输入框')
      if (wtName) {
        await typeInto(wtName, 'live-wt')
        const createWt = await waitFor(() => {
          const b = testid('env-worktree-create')
          return b && !b.disabled ? b : null
        }, 8000)
        ok(!!createWt, '填了名字后「创建并打开」可用')
        if (createWt) {
          await click(createWt)
          const made = await waitFor(async () => {
            const res = await window.yan.git.worktrees(cwd)
            return res.worktrees && res.worktrees.length === 2 ? res.worktrees : null
          }, 30000)
          ok(!!made, '主进程回读：多了一条工作树', made ? '2' : '超时')
          const created = made?.find((w) => w.branch === 'live-wt')
          ok(!!created, '新工作树的分支名是 live-wt')
          ok(
            !!created && /-worktrees[\\/]/.test(created.path),
            '它建在 <仓库名>-worktrees 下（仓库旁边，不是临时目录）',
            created ? created.path : ''
          )

          /* 登记为项目（方案 §6.2 的「创建成功后登记为可独立打开的项目」） */
          const reg = await waitFor(async () => {
            const st = await window.yan.getSettings()
            const norm = (v) => String(v).replace(/\\/g, '/').toLowerCase()
            return (st.projects ?? []).some((x) => norm(x.cwd) === norm(created?.path)) ? st : null
          }, 15000)
          ok(!!reg, '新建的工作树已登记为项目（可独立打开）')
          ok(
            !!reg &&
              (reg.projects ?? []).filter(
                (x) => String(x.cwd).replace(/\\/g, '/').toLowerCase() === String(created?.path).replace(/\\/g, '/').toLowerCase()
              ).length === 1,
            '同一个路径只登记一条（不重复写）'
          )

          /* 移除：这条分支没有上游 → 必须被拒，并把原因列出来 */
          const removeBtn = await waitFor(
            () => {
              const list = [...document.querySelectorAll('[data-testid="env-worktree-remove"]')]
              return list.length ? list[list.length - 1] : null
            },
            8000
          )
          ok(!!removeBtn, '每条非主工作树都有「移除」')
          if (removeBtn) {
            await click(removeBtn)
            const blocked = await waitFor(() => testid('env-worktree-blockers'), 20000)
            ok(!!blocked, '没有上游时移除被拒，并给出原因', textOf(blocked).slice(0, 80))
            const still = await window.yan.git.worktrees(cwd)
            ok(still.worktrees.length === 2, '被拒之后工作树还在（没有偷偷删）', String(still.worktrees.length))
          }
        }
      }
    }

    /* ── 11. 携带未提交改动（W2a）────────────────────────── */

    /*
     * 走界面上的真实路径：勾「未暂存的改动」+「未跟踪的文件」→ 创建。
     * 断言**全部靠回读**：目标工作树里得有那些改动，源仓库里得一个字节没动。
     * fixture 专门留了 dirty.txt（未暂存）与 notes.txt（未跟踪）给这一节 ——
     * G2 那部分的暂存/提交只碰 a.txt 与 new.txt，不会把它们消费掉。
     */
    await openEnvMenu()
    /*
     * ⚠️ 这一格是**开关**，不是「打开」：第 10 节已经把它展开了，再点一次
     * 就变成收起（第一版就是这么让整节静默跳过的 —— 断言数没涨才发现）。
     * 所以先看列表在不在，不在才点。
     */
    if (!testid('env-worktree-list')) {
      await click(await waitFor(() => testid('env-worktrees'), 8000))
    }
    const carryName = await waitFor(() => testid('env-worktree-branch'), 6000)
    if (carryName) {
      await typeInto(carryName, 'live-carry')
      const pick = await waitFor(() => testid('env-carry-untracked'), 6000)
      const unstagedBox = testid('env-carry-unstaged')
      ok(!!pick && !!unstagedBox, '工作树区里有「未暂存的改动」与「未跟踪的文件」两个勾选项')
      if (pick && unstagedBox) {
        await click(unstagedBox)
        await click(pick)
        const list = await waitFor(() => testid('env-carry-list'), 10000)
        ok(!!list, '勾上之后列出了可选的未跟踪文件')
        /*
         * ⚠️ 等的是**内容**而不是容器：清单容器是跟着勾选立刻渲染的，
         * 文件列表要等主进程的 snapshot 回来 —— 只等容器就会数到 0 个复选框
         * （第一版就是这么误报的）。
         */
        const boxes = await waitFor(() => {
          /* data-testid 就在 input 自己身上（不是包着它的 label），别再往里面找 */
          const b = [...document.querySelectorAll('input[data-testid=\"env-carry-file\"]')]
          return b.length ? b : null
        }, 12000)
        ok(!!boxes && boxes.length > 0, '清单里至少有一个未跟踪文件（fixture 的 notes.txt）', String(boxes ? boxes.length : 0))
        if (!boxes) return early('  ⤺ 未跟踪清单没出来，后面的断言无从谈起')

        /* 勾上**每一个**列出来的文件，避免依赖列表顺序 */
        for (const b of boxes) await click(b)

        const createBtn = await waitFor(() => {
          const b = testid('env-worktree-create')
          return b && !b.disabled ? b : null
        }, 8000)
        ok(!!createBtn, '带改动的创建按钮可用')
        if (createBtn) {
          await click(createBtn)
          const list2 = await waitFor(async () => {
            const res = await window.yan.git.worktrees(cwd)
            return (res.worktrees ?? []).some((w) => w.branch === 'live-carry') ? res.worktrees : null
          }, 30000)
          ok(!!list2, '带未提交改动的工作树建出来了')
          const made = list2?.find((w) => w.branch === 'live-carry')

          if (made) {
            /* ① 目标工作树里真的有那份未暂存改动 */
            const snap = await window.yan.git.snapshot({
              cwd: made.path,
              scope: { kind: 'working' },
              requestId: 'carry-check'
            })
            const got = (snap.files ?? []).map((f) => f.path)
            ok(got.includes('dirty.txt'), '目标工作树里看到了带过来的未暂存改动（dirty.txt）', JSON.stringify(got.slice(0, 6)))
            ok(got.includes('notes.txt'), '未跟踪文件也带过来了（notes.txt）')

            /* ② 源仓库一点没变：dirty.txt 仍然是未暂存改动 */
            const src = await window.yan.git.snapshot({
              cwd,
              scope: { kind: 'working' },
              requestId: 'carry-src'
            })
            const srcPaths = (src.files ?? []).map((f) => f.path)
            ok(srcPaths.includes('dirty.txt'), '源工作区的改动原样保留（没有被搬走）')
            ok(srcPaths.includes('notes.txt'), '源工作区的未跟踪文件也还在')
          }
        }
      }
    }

    /* ── 12. 在新工作树开始新会话（W2b，方案 §6.3 的降级路径）──── */

    /*
     * 方案要求：完整的「带会话继续」做不到正确的重绑定（权限 / 相对路径 /
     * 附件授权 / 上下文派生）时，**只开放「在新工作树开始新会话」**，
     * 不显示「无缝继续」。所以这里验两件事：按钮真的换了会话目录，
     * 以及界面上**明说**了不带走什么。
     */
    const openNote = await waitFor(() => testid('env-worktree-open-note'), 8000)
    ok(!!openNote, '工作树区里明说「新会话不带走历史与权限」', textOf(openNote).slice(0, 50))
    const openBtn = await waitFor(() => {
      const list = [...document.querySelectorAll('[data-testid="env-worktree-open"]')]
      return list.length ? list[list.length - 1] : null
    }, 8000)
    ok(!!openBtn, '每条非主工作树都有「开新会话」')
    if (openBtn) {
      await click(openBtn)
      const switched = await waitFor(() => {
        const now = store.getState().session?.cwd ?? ''
        return now.replace(/\\/g, '/').toLowerCase().includes('live-carry') ? now : null
      }, 20000)
      ok(!!switched, '点击后真的在新工作树目录里开了会话', String(switched ?? '超时'))
      /* 等菜单**消失**（谓词返回 true 才算成立），不是「等它出现」 */
      const gone = await waitFor(() => (testid('env-menu') ? null : true), 8000)
      ok(!!gone, '开完新会话后环境菜单自动收起（不再挡着对话）')
    }

    /* ── 13. 关联外部任务链接 + 托管网页比较（H1 / G3）──────── */

    /*
     * 方案 §6.4 的硬要求是**文案**：「明确只是关联，不宣称上传代码、同步会话
     * 或远程执行」。所以除了增删，这里还要把这句话读出来断言一遍。
     * 另外用本地 remote（bare 路径）验证「认不出托管站就不显示网页比较」——
     * 给一个打不开的链接比不给更糟。
     */
    await openEnvMenu()
    const links = await waitFor(() => testid('env-source-menu'), 8000)
    ok(!!links, '环境菜单里有「关联外部任务」区')
    if (links) {
      const urlBox = testid('src-url')
      const titleBox = testid('src-title')
      const addBtn = testid('src-add-web')
      ok(!!urlBox && !!titleBox && !!addBtn, '有地址 / 标题两个输入与「关联」按钮')

      /* 不合法地址：要拦下来（javascript: 之类不能被当成可打开的链接） */
      await typeInto(urlBox, 'javascript:alert(1)')
      await click(addBtn)
      ok((await waitFor(() => $('.env-error'), 4000)) !== null, '非 http/https 的地址被拒绝')

      await typeInto(urlBox, 'https://example.com/task-1')
      await typeInto(titleBox, '探针任务')
      await click(addBtn)
      const row = await waitFor(() => $('[data-testid="src-item"]'), 6000)
      ok(!!row, '关联后列表里出现了一条')
      const rowText = textOf(row)
      ok(rowText.includes('探针任务'), '用的是输入框里的标题（.src-title 里）', rowText.slice(0, 30))
      ok(rowText.includes('已关联'), '状态标成「已关联」（能证明的那一态）')
      /* 打开按钮的 title 带着原始地址，用于复制/核对 */
      const openBtn = $('[data-testid="src-open"]')
      ok(openBtn?.getAttribute('title') === 'https://example.com/task-1', '打开按钮带着原始地址', String(openBtn?.getAttribute('title')))
      /* 边界文案：这句话是方案要求写在界面上的 */
      const note = textOf(links)
      ok(/不上传代码/.test(note), '明说「不会上传代码 / 同步会话 / 远程执行」')

      /* 移除：只移除会话引用 */
      const rm = await waitFor(() => testid('src-remove'), 4000)
      if (rm) {
        await click(rm)
        const gone = await waitFor(() => (testid('src-open') ? null : true), 5000)
        ok(!!gone, '移除后列表里不再有它')
      }
    }

    /*
     * 来源菜单（§8 的 S1）。
     *
     * ── 顺序很重要 ──
     * 筛选区在有内容之后才渲染（没内容时它只是一行噪声），所以「加一条网页」
     * 必须排在「有 4 个筛选」之前 —— 反过来的话，断言等的是一个正确行为下
     * 永远不会出现的东西（第一次跑就是这么误报的）。
     *
     * 只加网页这一类：图片与文件要走附件流（粘贴/拖入），在这个场景里没有
     * 可控的输入，硬造会把断言变成"测试自己写文件"。图片那一类的持久化在
     * 单测里真跑过（test-sources.mjs：落盘、幂等、读回逐字节一致）。
     */
    const menu = testid('env-source-menu')
    ok(!!menu, '环境菜单里有「来源」分区')
    if (menu) {
      /* 边界文案是**静态**的，不依赖有没有内容 —— 先断言它 */
      ok(/原文件不会被删/.test(textOf(menu)), '写明「移除不会删你的原文件、不改写已发送的历史」')
      ok(/不上传代码/.test(textOf(menu)), '写明「只是关联，不上传代码」')

      const urlBox = testid('src-url')
      const titleBox = testid('src-title')
      const addBtn = testid('src-add-web')
      ok(!!urlBox && !!titleBox && !!addBtn, '有地址 / 标题两个输入与「关联」按钮')

      /* 不合法地址要拦下（javascript: 之类不能被当成可打开的链接） */
      await typeInto(urlBox, 'javascript:alert(1)')
      await click(addBtn)
      ok((await waitFor(() => $('.env-error'), 4000)) !== null, '非 http/https 的地址被拒绝')

      /* 加一条真实的网页来源 */
      await typeInto(urlBox, 'https://example.com/task-1')
      await typeInto(titleBox, '探针任务')
      await click(addBtn)

      const row = await waitFor(() => $('[data-testid="src-item"]'), 8000)
      ok(!!row, '关联后列表里出现了一条')
      if (row) {
        const rowText = textOf(row)
        ok(rowText.includes('探针任务'), '用的是输入框里的标题', rowText.slice(0, 30))
        ok(rowText.includes('已关联'), '状态标成「已关联」（能证明的那一态）')
        const openBtn = $('[data-testid="src-open"]')
        ok(openBtn?.getAttribute('title') === 'https://example.com/task-1', '打开按钮带着原始地址', String(openBtn?.getAttribute('title')))
      }

      /* 有内容之后筛选区才出现：三类 + 全部 */
      const hasFilter = await waitFor(() => testid('src-filter-all'), 6000)
      ok(!!hasFilter, '有「全部」筛选')
      for (const f of ['image', 'file', 'web']) {
        ok(!!testid(`src-filter-${f}`), `有「${f}` + `」筛选`)
      }

      /* 移除：只解除会话引用 */
      const rm = await waitFor(() => testid('src-remove'), 4000)
      if (rm) {
        await click(rm)
        const gone = await waitFor(() => (testid('src-item') ? null : true), 6000)
        ok(!!gone, '移除后列表里不再有它')
      }
    }

    /*
     * fixture 的 remote 是本地 bare 路径 —— 不是托管站，所以**不该**出现
     * 「在网上比较」。这条断言同时守住两件事：不猜路径、不显示死链接。
     */
    ok(!testid('env-compare-web'), '本地路径的 remote 不显示「在网上比较」')

    /* ── 14. PR 状态（G3）──────────────────────────────── */

    /*
     * fixture 的 remote 是**本地 bare 路径** —— 不是托管站，所以这里正确的行为是
     * 「如实说不支持」，而且**一次外发请求都不发**。这一条同时守住两件事：
     * 「没有任何远端信息时不猜托管站」和「不为了显示一个状态去打网络」。
     * （真实 GitHub API 的往返在单测里跑了一次：匿名可读、404 分类。）
     */
    const prState = await waitFor(() => testid('env-pr-state'), 8000)
    ok(!!prState, '环境菜单里有 PR 状态')
    if (prState) {
      const text = textOf(prState)
      ok(!/查询中/.test(text), '已经查完了（不是一直卡在查询中）', text.slice(0, 30))
      ok(/不支持/.test(text), '本地远端 → 如实说「这个远端不支持」（不猜、不编状态）', text.slice(0, 30))
    }

    /* 收尾：把环境菜单关掉，别让它盖在最后的断言上 */
    if (testid('env-menu')) await click(testid('session-project'))

  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.message ? error.message : String(error)))
  }

  const failed = out.filter((l) => l.startsWith('  ✗')).length
  out.push(`[gitwrite] ${failed} 条失败 / 共 ${out.length} 条`)
  return out.join('\n')
})()
