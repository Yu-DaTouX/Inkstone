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
        const v = await fn()
        if (v) return v
      } catch {
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

  const typeInto = async (el, value) => {
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(80)
    return true
  }

  const openEnvMenu = async () => {
    if (testid('env-menu')) return true
    await click(testid('session-project'))
    return !!(await waitFor(() => testid('env-menu'), 5000))
  }

  const branchItem = (name) => {
    const list = [...document.querySelectorAll('[data-testid="env-branch-item"]')]
    return (
      list.find((el) => (el.querySelector('.env-branch-name')?.textContent ?? '').trim() === name) ?? null
    )
  }
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

    const stateFull = async () => await window.yan.git.state(cwd)
    const state = async () => (await stateFull()).repo
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

    const action = async input => {
      const current = await stateFull()
      return window.yan.git.action({ ...input, cwd, requestId: crypto.randomUUID(), expected: current.expected })
    }
    ok((await action({ kind: 'stage', paths: ['a.txt', 'new.txt'] })).ok, '夹具文件暂存成功')
    ok((await action({ kind: 'unstage', paths: ['a.txt'] })).ok, '取消暂存只退 index')
    const headBefore = (await state()).head
    ok((await action({ kind: 'commit', message: COMMIT_MSG })).ok, '夹具提交成功')
    ok((await state()).head !== headBefore, '提交后 HEAD 前进')
    await openEnvMenu()

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

    const fetchBtn = await waitFor(() => testid('env-fetch'), 6000)
    ok(!!fetchBtn, '环境菜单里有「拉取」一项')
    if (fetchBtn) {
      await click(fetchBtn)
      const notice = await waitFor(() => testid('env-notice') || testid('git-notice'), 30000)
      ok(!!notice, '拉取给出了结果行', textOf(notice))
    }

    await openEnvMenu()
    const branchBtn = await waitFor(() => testid('env-branch'), 6000)
    ok(!!branchBtn, '环境菜单里有分支项', branchBtn ? '' : '菜单文本=' + JSON.stringify(textOf(testid('env-menu')).slice(0, 120)) + ' state=' + (await stateDiag()))
    await click(branchBtn)
    const branchList = await waitFor(() => testid('env-branches'), 8000)
    ok(!!branchList, '点分支项展开了分支列表')
    const item = await waitFor(() => {
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

    await openBranchList()
    const badInput = await waitFor(() => testid('env-new-branch-name'), 6000)
    if (badInput) {
      await typeInto(badInput, 'bad..name')
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

          const reg = await waitFor(async () => {
            const st = await window.yan.getSettings()
            const norm = (v) => String(v).replace(/\\/g, '/').toLowerCase()
            return (st.projects ?? []).some((x) => norm(x.cwd) === norm(created?.path)) ? st : null
          }, 15000)
          ok(!!reg, '新建的工作树已登记为项目（可独立打开）')
          if (!reg) {
            const dbg = await window.yan.getSettings()
            out.push(
              '  诊断：projects=' +
                JSON.stringify((dbg.projects ?? []).map((x) => x.cwd)) +
                ' 新建路径=' +
                String(created?.path ?? '(空)') +
                ' worktrees=' +
                JSON.stringify(((await window.yan.git.worktrees(cwd)).worktrees ?? []).map((w) => w.path))
            )
          }
          ok(
            !!reg &&
              (reg.projects ?? []).filter(
                (x) => String(x.cwd).replace(/\\/g, '/').toLowerCase() === String(created?.path).replace(/\\/g, '/').toLowerCase()
              ).length === 1,
            '同一个路径只登记一条（不重复写）'
          )

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

    await openEnvMenu()
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
        const boxes = await waitFor(() => {
          const b = [...document.querySelectorAll('input[data-testid=\"env-carry-file\"]')]
          return b.length ? b : null
        }, 12000)
        ok(!!boxes && boxes.length > 0, '清单里至少有一个未跟踪文件（fixture 的 notes.txt）', String(boxes ? boxes.length : 0))
        if (!boxes) return early('  ⤺ 未跟踪清单没出来，后面的断言无从谈起')

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
            const snap = await window.yan.git.state(made.path)
            const got = await window.yan.git.untracked(made.path)
            ok(snap.repo?.unstagedCount > 0, '目标工作树里看到了带过来的未暂存改动（dirty.txt）', JSON.stringify(got.slice(0, 6)))
            ok(got.includes('notes.txt'), '未跟踪文件也带过来了（notes.txt）')

            const src = await window.yan.git.state(cwd)
            const srcPaths = await window.yan.git.untracked(cwd)
            ok(src.repo?.unstagedCount > 0, '源工作区的改动原样保留（没有被搬走）')
            ok(srcPaths.includes('notes.txt'), '源工作区的未跟踪文件也还在')
          }
        }
      }
    }

    const openNote = await waitFor(() => testid('env-worktree-open-note'), 8000)
    ok(!!openNote, '工作树区里明说「派生新会话」的取舍', textOf(openNote).slice(0, 80))
    const carryLine = await waitFor(() => testid('env-worktree-fork-carry'), 8000)
    const skipLine = await waitFor(() => testid('env-worktree-fork-skip'), 8000)
    ok(!!carryLine && !!skipLine, '「会带 / 不带」分两行列出（不是一句笼统话）')
    if (carryLine) ok(/来源关系/.test(textOf(carryLine)), '「会带」写的是来源关系（可追溯）', textOf(carryLine).slice(0, 70))
    if (skipLine) {
      const s = textOf(skipLine)
      ok(/历史/.test(s) && /权限/.test(s) && /附件/.test(s), '「不带」逐项写了历史 / 权限 / 附件', s.slice(0, 70))
    }
    const openBtn = await waitFor(() => {
      const list = [...document.querySelectorAll('[data-testid="env-worktree-open"]')]
      return list.length ? list[list.length - 1] : null
    }, 8000)
    ok(!!openBtn, '每条非主工作树都有「开新会话」')
    const fromSession = store.getState().session?.sessionId ?? ''
    if (openBtn) {
      await click(openBtn)
      const switched = await waitFor(() => {
        const now = store.getState().session?.cwd ?? ''
        return now.replace(/\\/g, '/').toLowerCase().includes('live-carry') ? now : null
      }, 20000)
      ok(!!switched, '点击后真的在新工作树目录里开了会话', String(switched ?? '超时'))
      const link = await waitFor(async () => {
        const list = await window.yan.git.worktreeLinks()
        return (list ?? []).find((x) => String(x.worktree ?? '').replace(/\\/g, '/').toLowerCase().includes('live-carry')) ?? null
      }, 12000, 250)
      ok(!!link, '工作树来源关系真的登记了', JSON.stringify(link ?? null))
      if (link) {
        ok(link.fromSessionId === fromSession, '来源会话就是点按钮之前那个', link.fromSessionId)
        ok(!!link.branch, '分支记下来了', link.branch)
        out.push(`  worktreelink.sessionId=${link.sessionId}`)
        out.push(`  worktreelink.worktree=${link.worktree}`)
      }
      const gone = await waitFor(() => (testid('env-menu') ? null : true), 8000)
      ok(!!gone, '开完新会话后环境菜单自动收起（不再挡着对话）')
      await openEnvMenu()
      await click(testid('env-worktrees'))
      const origin = await waitFor(() => testid('env-worktree-origin'), 8000)
      ok(!!origin, '环境菜单里显示了这个会话的来源工作树', textOf(origin).slice(0, 60))
      if (origin) ok(textOf(origin).includes('live-carry'), '显示的是真实分支/目录（不是一句模板文案）', textOf(origin).slice(0, 60))

      const composerEl = testid('composer')
      const draft = composerEl ? String(composerEl.value ?? '') : ''
      ok(/\[yan-fork-context:[^\]]+\]/.test(draft), '输入框里有一段 Fork 上下文草稿（带标记行）', draft.slice(0, 70))
      ok(draft.includes('live-carry'), '草稿里写的是这个工作树（不是通用模板）', draft.slice(0, 70))
      ok(/没有带过来/.test(draft), '草稿如实说明源会话历史没带过来')
      const sentFork = (store.getState().messages ?? []).some((m) => String(m.text ?? '').includes('yan-fork-context'))
      ok(sentFork === false, '草稿**没有**被自动发送（不花额度、不替用户说话）')

      const treesNow = await window.yan.git.worktrees(store.getState().session?.cwd ?? '')
      const carryTree = (treesNow?.worktrees ?? []).find((w) => !w.main)
      const ctxDiag = await window.yan.git.forkContext({
        worktree: carryTree?.path ?? '',
        sourceCwd: link?.fromCwd ?? ''
      })
      ok(!!ctxDiag?.text, '主进程侧也能算出这段正文（不依赖界面状态）')
      ok(
        !!carryTree?.branch && String(ctxDiag?.branch) === String(carryTree.branch),
        '诊断：分支取自**目标工作树**（而不是源会话所在的仓库）',
        `${String(ctxDiag?.branch)} vs ${String(carryTree?.branch)}`
      )
      ok(typeof ctxDiag?.changedCount === 'number', '诊断：变更数是个数字（真的读过工作区）', String(ctxDiag?.changedCount))
      ok(ctxDiag?.hasPackage === false, '沙箱里没有交接包 → 正文里如实说没有', String(ctxDiag?.hasPackage))
      ok(ctxDiag?.attachments === 0, '沙箱源会话里没有图片附件 → 计数为 0', String(ctxDiag?.attachments))
      ok(!String(ctxDiag?.text ?? '').includes('附件'), '没有附件时正文里不出现附件段落')
      const withAttach = await window.yan.git.forkContext({
        worktree: carryTree?.path ?? '',
        sourceCwd: link?.fromCwd ?? '',
        explicitAttachmentCount: 2
      })
      ok(withAttach?.attachments === 2, '显式给了附件数就按它算（不读会话）', String(withAttach?.attachments))
      ok(String(withAttach?.text ?? '').includes('2 个图片附件'), '正文里写清有几个附件没带过来')
      ok(/没有带过来/.test(String(withAttach?.text ?? '')), '附件一律说“没有带过来”（不假装能带）')
    }

    const wtAll = await window.yan.git.worktrees(store.getState().session?.cwd ?? '')
    const mainTree = (wtAll?.worktrees ?? []).find((w) => w.main)
    const nonMainTree = (wtAll?.worktrees ?? []).find((w) => !w.main)
    if (mainTree && nonMainTree) {
      const beforeMain = await window.yan.trust.status(mainTree.path)
      ok(beforeMain.trusted === false, '主仓库初始未被信任（沙箱里没预置 trust.json）', JSON.stringify(beforeMain))
      const allowed = await window.yan.trust.allow(mainTree.path)
      ok(allowed?.ok === true, '显式信任主仓库成功', JSON.stringify(allowed ?? null))
      const afterMain = await window.yan.trust.status(mainTree.path)
      ok(afterMain.trusted === true, '主仓库现在是受信任的', JSON.stringify(afterMain))
      const wtBefore = await window.yan.trust.status(nonMainTree.path)
      ok(wtBefore.trusted === false, '工作树目录**没有**跟着被信任（不自动继承）', JSON.stringify(wtBefore))
      const trustBtn = await waitFor(() => testid('env-worktree-trust'), 8000)
      ok(!!trustBtn, '工作树行上有「信任这个目录」入口（不用去终端跑 pi）')
      if (trustBtn) {
        await click(trustBtn)
        const trustedTag = await waitFor(() => testid('env-worktree-trusted'), 8000)
        ok(!!trustedTag, '点一下之后那一行变成「已受信任」')
        const wtAfter = await window.yan.trust.status(nonMainTree.path)
        ok(wtAfter.trusted === true, '主进程侧也确认工作树已被信任', JSON.stringify(wtAfter))
      }
    } else {
      ok(false, '没拿到主 / 非主工作树清单（夹具仓库没建工作树？）')
    }

    const wtAll2 = await window.yan.git.worktrees(store.getState().session?.cwd ?? '')
    const targetTree = (wtAll2?.worktrees ?? []).find((w) => !w.main)
    const repoTree = (wtAll2?.worktrees ?? []).find((w) => w.main)
    if (targetTree && repoTree) {
      const probeRefs = [
        'a.txt',
        'no-such-file.ts',
        `${repoTree.path}/a.txt`,
        '../escape.txt'
      ]
      const rep = await window.yan.git.forkFileRefs({ worktree: targetTree.path, explicitRefs: probeRefs })
      ok(!!rep?.root, '算出了目标工作树的仓库根', String(rep?.root ?? '(空)'))
      ok(rep?.summary?.total === 4, '四条引用都过了（不静默丢）', String(rep?.summary?.total))
      const byRef = Object.fromEntries((rep?.refs ?? []).map((r) => [r.ref, r.state]))
      ok(byRef['no-such-file.ts'] === 'missing', '目标里没有的文件报 missing', String(byRef['no-such-file.ts']))
      ok(byRef['../escape.txt'] === 'outside', '`..` 报 outside（不迁移）', String(byRef['../escape.txt']))
      const absState = (rep?.refs ?? []).find((r) => String(r.ref).toLowerCase().endsWith('/a.txt') && r.ref.includes(':'))?.state
      ok(absState === 'outside', '源仓库的绝对路径仍是 outside（证明没做前缀替换）', String(absState))
      ok(
        typeof byRef['a.txt'] === 'string' && byRef['a.txt'] !== 'outside',
        '相对引用 `a.txt` 被当成仓库内路径解析（resolved 或 missing，但绝不是 outside）',
        String(byRef['a.txt'])
      )
      const live = window.yan.git.forkFileRefs({
        worktree: targetTree.path,
        sourceFile: store.getState().session?.sessionFile,
        sourceCwd: store.getState().session?.cwd
      })
      const liveRep = await live
      ok(Array.isArray(liveRep?.refs), '真实提取这条路能跑（refs 是数组）', String(liveRep?.refs?.length ?? '(空)'))
    } else {
      ok(false, '没拿到目标 / 主工作树（后面几条信任与引用断言都依赖它）')
    }

    await openEnvMenu()
    const links = await waitFor(() => testid('env-source-menu'), 8000)
    ok(!!links, '环境菜单里有「关联外部任务」区')
    if (links) {
      const urlBox = testid('src-url')
      const titleBox = testid('src-title')
      const addBtn = testid('src-add-web')
      ok(!!urlBox && !!titleBox && !!addBtn, '有地址 / 标题两个输入与「关联」按钮')

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
      const openBtn = $('[data-testid="src-open"]')
      ok(openBtn?.getAttribute('title') === 'https://example.com/task-1', '打开按钮带着原始地址', String(openBtn?.getAttribute('title')))

      const rm = await waitFor(() => testid('src-remove'), 4000)
      if (rm) {
        await click(rm)
        const gone = await waitFor(() => (testid('src-open') ? null : true), 5000)
        ok(!!gone, '移除后列表里不再有它')
      }
    }

    const menu = testid('env-source-menu')
    ok(!!menu, '环境菜单里有「来源」分区')
    if (menu) {
      ok(/原文件不受影响/.test(textOf(menu)), '写明「移除只解除引用，原文件不受影响」')

      const urlBox = testid('src-url')
      const titleBox = testid('src-title')
      const addBtn = testid('src-add-web')
      ok(!!urlBox && !!titleBox && !!addBtn, '有地址 / 标题两个输入与「关联」按钮')

      await typeInto(urlBox, 'javascript:alert(1)')
      await click(addBtn)
      ok((await waitFor(() => $('.env-error'), 4000)) !== null, '非 http/https 的地址被拒绝')

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

      const hasFilter = await waitFor(() => testid('src-filter-all'), 6000)
      ok(!!hasFilter, '有「全部」筛选')
      for (const f of ['image', 'file', 'web']) {
        ok(!!testid(`src-filter-${f}`), `有「${f}` + `」筛选`)
      }

      const rm = await waitFor(() => testid('src-remove'), 4000)
      if (rm) {
        await click(rm)
        const gone = await waitFor(() => (testid('src-item') ? null : true), 6000)
        ok(!!gone, '移除后列表里不再有它')
      }
    }

    ok(!testid('env-compare-web'), '本地路径的 remote 不显示「在网上比较」')

    const prState = await waitFor(() => testid('env-pr-state'), 8000)
    ok(!!prState, '环境菜单里有 PR 状态')
    if (prState) {
      const text = textOf(prState)
      ok(!/查询中/.test(text), '已经查完了（不是一直卡在查询中）', text.slice(0, 30))
      ok(/不支持/.test(text), '本地远端 → 如实说「这个远端不支持」（不猜、不编状态）', text.slice(0, 30))
    }

    if (testid('env-menu')) await click(testid('session-project'))

  } catch (error) {
    out.push('  ✗ 探针异常：' + (error && error.message ? error.message : String(error)))
  }

  const failed = out.filter((l) => l.startsWith('  ✗')).length
  out.push(`[gitwrite] ${failed} 条失败 / 共 ${out.length} 条`)
  return out.join('\n')
})()
