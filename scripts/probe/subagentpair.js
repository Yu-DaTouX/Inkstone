/**
 * 两个并发写入子代理的真实矩阵（L03）。
 *
 * ⚠️ 这是**真跑**：会起两个（有时更多）`pi --mode rpc` 子进程，并且要求
 *    模型真的调用 write/edit 把文件写进各自 worktree —— 所以成本标记是
 *    `cost: 1`。断言只针对**运行模型**，不针对模型说了什么。
 *
 * 这里覆盖的是一条完整链路，而不是单点：
 *   ① 并发槽位：两个同时在跑，第三个被明确拒绝（D1）
 *   ② 写入隔离：主工作树在合并前看不到任何子代理产物
 *   ③ 差异归属：每个任务的 diff 只含自己写的文件
 *   ④ 合并 / 放弃：主树结果可解释，放弃也留补丁
 *   ⑤ 冲突：两个 worktree 改同一行，先合并者赢，后者判冲突且不半截写入
 *   ⑥ 只读封堵：`controlled-cwd` + `--tools` 白名单让写入真的不成立（D4）
 *   ⑦ 后台存活：切查看对象不关闭运行中的子代理
 *   ⑧ 退出归档：留一个未审阅的任务给退出，断言在 Node 侧（app 退出后）
 *      由 test-live 的 `afterExit` 检查（`YAN_DIR/subagents` + 主树 + 临时目录）
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
  const st = () => store.getState()
  const runOf = (id) => st().subagents.find((r) => r.id === id) ?? null
  const mainCwd = () => st().settings?.cwd ?? ''

  const waitRun = async (id, done, timeoutMs) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const run = runOf(id)
      if (run && done.includes(run.status)) return run
      await sleep(400)
    }
    return runOf(id)
  }

  /**
   * 等差异读完。
   *
   * 状态变 done 不等于差异已经算完：`finalize` 是**异步**的（要跑几条
   * git 命令才拿到 numstat/patch）。实测踩到：并发结束的两个任务在同一
   * 瞬间变 done，紧接着读 diff 全是 null，看起来像“模型根本没写文件”。
   */
  const waitDiff = async (id, timeoutMs = 30_000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const run = runOf(id)
      if (run?.diff) return run
      if (run && ['error', 'cancelled'].includes(run.status)) return run
      await sleep(300)
    }
    return runOf(id)
  }

  /** 等一个任务真的结束并算完差异：状态到终态 + `diff` 已就绪 */
  const settle = async (id, timeoutMs = 75_000) => {
    await waitRun(id, ['done', 'error', 'cancelled'], timeoutMs)
    return waitDiff(id)
  }

  /** 主工作树根层文件名（走真实 IPC，不是猜测） */
  const rootEntries = async () => {
    const res = await window.yan.listDir('')
    return (res?.entries ?? []).map((e) => e.name)
  }
  const readText = async (rel) => {
    const res = await window.yan.readPreview(rel)
    return res?.ok ? (res.text ?? '') : ''
  }
  const writeTask = (mark, file, content) =>
    `${mark} 请用 write 工具在当前工作目录创建文件：path=${file}，content=${content}。` +
    '只做这一件事：调用 write 工具、把文件写出来，不要用 read、不要问问题，完成后只回复“完成”。'
  const editTask = (mark, value) =>
    `${mark} 请用 write 工具把当前工作目录下 README.md 的**整个文件内容**改成只有一行：LINE-${value}（覆盖写入）。` +
    '必须真的写文件，完成后只回复“完成”。'

  /** 诊断用：把一条 run 用过的工具列出来（模型不听话时才看得出原因） */
  const dumpTools = (run) =>
    JSON.stringify(
      (run?.transcript ?? []).flatMap((m) => (m.toolCalls ?? []).map((t) => [t.name, t.status, (t.output ?? '').slice(0, 60)]))
    )

  try {
    for (let i = 0; i < 60; i++) {
      if (st().settings && q('.composer-wrap')) break
      await sleep(250)
    }
    await sleep(800)
    out.push(`  主 cwd = ${mainCwd()}`)

    out.push('')
    out.push('=== 1. 并发槽位：两个一起启动，第三个被拒绝 ===')
    const [ra, rb] = await Promise.all([
      window.yan.subagents.start(writeTask('YAN-ALPHA', 'alpha.txt', 'alpha-from-subagent')),
      window.yan.subagents.start(writeTask('YAN-BETA', 'beta.txt', 'beta-from-subagent'))
    ])
    const idA = ra.run?.id
    const idB = rb.run?.id
    ok(ra.ok === true, `A 启动成功${ra.ok ? '' : '：' + (ra.error ?? '')}`)
    ok(rb.ok === true, `B 启动成功${rb.ok ? '' : '：' + (rb.error ?? '')}`)
    const third = await window.yan.subagents.start('YAN-EXTRA 请只回答两个字：收到')
    ok(
      third.ok === false && /最多/.test(third.error ?? ''),
      `第三个并发请求被明确拒绝（${third.error ?? '居然成功了'}）`
    )
    if (!idA || !idB) return out.join('\n')

    out.push('')
    out.push('=== 2. 隔离：两个 worktree 各不相同，也不等于主工作树 ===')
    let peak = 0
    for (let i = 0; i < 25; i++) {
      const live = st().subagents.filter((r) => r.status === 'running' || r.status === 'starting').length
      peak = Math.max(peak, live)
      if (peak >= 2) break
      await sleep(400)
    }
    ok(peak >= 2, `两个子代理真的同时运行过（并发峰值 ${peak}）`)
    const a0 = runOf(idA)
    const b0 = runOf(idB)
    ok(!!a0 && !!b0 && a0.cwd !== b0.cwd, '两个任务的 cwd 互不相同')
    ok(!!a0 && a0.cwd !== mainCwd() && /yan-subagent-/.test(a0.cwd ?? ''), `A 在隔离 worktree 里（${a0?.cwd}）`)
    ok(!!b0 && b0.cwd !== mainCwd() && /yan-subagent-/.test(b0.cwd ?? ''), `B 在隔离 worktree 里（${b0?.cwd}）`)
    ok(!!q('[data-testid="subagent-strip"]'), '主对话区渲染出子任务列表')
    ok(!!q(`[data-testid="subagent-${idA}"]`) && !!q(`[data-testid="subagent-${idB}"]`), '列表里两条都在')

    out.push('')
    out.push('=== 3. 等两个任务真的写完（真实模型） ===')
    const fa = await settle(idA)
    const fb = await settle(idB)
    ok(fa?.status === 'done', `A 正常跑完（实际 ${fa?.status}${fa?.error ? '：' + fa.error : ''}）`)
    ok(fb?.status === 'done', `B 正常跑完（实际 ${fb?.status}${fb?.error ? '：' + fb.error : ''}）`)
    out.push(`  A diff = ${JSON.stringify(fa?.diff ?? null)}`)
    out.push(`  B diff = ${JSON.stringify(fb?.diff ?? null)}`)
    out.push(`  A 用过的工具 = ${dumpTools(fa)}`)
    out.push(`  B 用过的工具 = ${dumpTools(fb)}`)
    if ((fa?.diff?.files ?? 0) === 0) out.push(`  A 回复：${(fa?.transcript ?? []).map((m) => m.text).join(' / ').slice(0, 200)}`)

    out.push('')
    out.push('=== 4. 差异归属 + 合并前主工作树必须干净 ===')
    const pathsA = fa?.diff?.paths ?? []
    const pathsB = fb?.diff?.paths ?? []
    ok(pathsA.some((p) => p.includes('alpha.txt')), 'A 的差异里有它自己写的 alpha.txt')
    ok(!pathsA.some((p) => p.includes('beta.txt')), 'A 的差异里没有 B 的文件')
    ok(pathsB.some((p) => p.includes('beta.txt')), 'B 的差异里有它自己写的 beta.txt')
    ok(!pathsB.some((p) => p.includes('alpha.txt')), 'B 的差异里没有 A 的文件')
    const names0 = await rootEntries()
    ok(!names0.includes('alpha.txt') && !names0.includes('beta.txt'), '合并前主工作树里没有这两个文件（隔离生效）')

    out.push('')
    out.push('=== 5. 合并 A / 放弃 B ===')
    await store.getState().mergeSubagent(idA)
    await sleep(1500)
    const fa2 = runOf(idA)
    ok(fa2?.review === 'merged', `A 标记为已合并（review=${fa2?.review}${fa2?.error ? '：' + fa2.error : ''}）`)
    ok((await rootEntries()).includes('alpha.txt'), '合并后主工作树出现 alpha.txt')
    ok((await readText('alpha.txt')).includes('alpha-from-subagent'), '主工作树里的内容就是子代理写的那一行')
    ok(!(await rootEntries()).includes('beta.txt'), '只合并 A，没有把 B 的文件带进来')

    await store.getState().discardSubagent(idB)
    await sleep(1500)
    const fb2 = runOf(idB)
    ok(fb2?.review === 'discarded', `B 标记为已放弃（review=${fb2?.review}）`)
    ok(!!fb2?.resultPath, '放弃后仍留了补丁路径（不是直接丢掉）')
    ok(!(await rootEntries()).includes('beta.txt'), '放弃后主工作树里没有 beta.txt')

    out.push('')
    out.push('=== 6. 冲突：两个 worktree 改 README.md 的同一行 ===')
    const [rd, rcc] = await Promise.all([
      window.yan.subagents.start(editTask('YAN-CONFLICT-D', 'D')),
      window.yan.subagents.start(editTask('YAN-CONFLICT-C', 'C'))
    ])
    const idD = rd.run?.id
    const idC = rcc.run?.id
    ok(rd.ok === true && rcc.ok === true, '两个改同一行的任务都启动了')
    if (idD && idC) {
      const fd = await settle(idD)
      const fc0 = await settle(idC)
      out.push(`  D 状态 = ${fd?.status}/${fd?.review}`)
      out.push(`  C 状态 = ${fc0?.status}/${fc0?.review}`)
      out.push(`  D 用过的工具 = ${dumpTools(fd)}`)
      out.push(`  C 用过的工具 = ${dumpTools(fc0)}`)
      out.push(`  D diff = ${JSON.stringify(fd?.diff ?? null)}`)
      out.push(`  C diff = ${JSON.stringify(fc0?.diff ?? null)}`)
      ok((fd?.diff?.files ?? 0) > 0 && (fc0?.diff?.files ?? 0) > 0, '两个任务都真的改了文件')

      await store.getState().mergeSubagent(idD)
      await sleep(1500)
      ok(runOf(idD)?.review === 'merged', 'D 先合并成功')
      const readmeD = await readText('README.md')
      out.push(`  合并 D 之后 README 里含 LINE-D = ${readmeD.includes('LINE-D')}`)
      ok(readmeD.includes('LINE-D'), '主工作树 README 已变成 D 的版本')

      await store.getState().mergeSubagent(idC)
      await sleep(1500)
      const fC = runOf(idC)
      ok(fC?.review === 'conflict', `C 被判为冲突（review=${fC?.review}${fC?.error ? '：' + fC.error : ''}）`)
      ok(/冲突|失效/.test(fC?.error ?? ''), '冲突原因被记下来，没静默失败')
      const readmeC = await readText('README.md')
      ok(readmeC.includes('LINE-D') && !readmeC.includes('LINE-C'), '冲突时主工作树保持 D 版本，没有被半截覆盖')
    }

    out.push('')
    out.push('=== 7. 只读子代理：模型想写也写不了（D4 端到端） ===')
    const readonlyTask = (mark) =>
      `${mark} 请调用 write 工具在当前工作目录创建文件：path=readonly-attempt.txt，content=read-only-should-fail。` +
      '必须先真的尝试调用一次 write 工具；如果你发现这个工具不可用，就直接说明它不可用，不要改用其他工具去建文件。'
    const runReadonly = async (mark) => {
      const res = await window.yan.subagents.start(readonlyTask(mark), undefined, 'controlled-cwd')
      if (!res.ok || !res.run) return { res, run: null, calls: [] }
      const run = await settle(res.run.id)
      const calls = (run?.transcript ?? []).flatMap((m) =>
        (m.toolCalls ?? []).filter((t) => ['write', 'edit', 'bash'].includes(t.name))
      )
      return { res, run, calls }
    }
    let ro = await runReadonly('YAN-READONLY')
    ok(ro.res.ok === true, `只读子代理启动成功${ro.res.ok ? '' : '：' + (ro.res.error ?? '')}`)
    if (ro.run) {
      out.push(`  第一次：终态 ${ro.run.status}，review=${ro.run.review}，写类工具调用 ${ro.calls.length} 次`)
      if (ro.calls.length === 0) {
        /* 模型行为不稳（有时只 read/ls 就下结论），再给一次机会 */
        out.push('  这次没尝试写，再跑一次')
        ro = await runReadonly('YAN-READONLY-RETRY')
        out.push(`  第二次：终态 ${ro.run?.status}，review=${ro.run?.review}，写类工具调用 ${ro.calls.length} 次`)
      }
    }
    if (ro.run) {
      const fro = ro.run
      ok(fro.isolation === 'controlled-cwd', '只读任务没有另开 worktree')
      ok(fro.cwd === mainCwd(), '只读任务直接在受控 cwd 里跑（靠工具白名单兜底）')
      out.push(
        `  用过的工具 = ${JSON.stringify([...new Set((fro.transcript ?? []).flatMap((m) => (m.toolCalls ?? []).map((t) => t.name)))])}`
      )
      out.push(`  写类工具调用 = ${JSON.stringify(ro.calls.map((t) => [t.name, t.status, (t.output ?? '').slice(0, 80)]))}`)
      if (ro.calls.length > 0) {
        ok(ro.calls.every((t) => t.status !== 'ok'), `模型尝试写 ${ro.calls.length} 次，没有一次真的成功`)
        ok(
          ro.calls.some((t) => /not found/i.test(t.output ?? '')),
          'pi 明确报告工具不可用（Tool write not found）'
        )
      } else {
        /*
         * 模型也可能“一看没有 write 工具就直接说不写”。这同样是白名单生效的
         * 证据，但要把它说的话打出来（不同模型行为不同，不能默默放过）。
         */
        const said = (fro.transcript ?? []).map((m) => m.text ?? '').join(' ').trim()
        out.push(`  模型没有调用写类工具，它说：${said.slice(0, 240)}`)
        ok(said.length > 0, '转录里有模型的回复文本')
        ok(/write|工具|不可用|无法|没有|权限|只读/i.test(said), '模型明确表示写不了（而不是忘了写）')
      }
      ok(!(await rootEntries()).includes('readonly-attempt.txt'), '只读子代理没能写进主工作目录')
    }

    out.push('')
    out.push('=== 8. 切查看对象不关闭后台子代理；留一个给退出归档 ===')
    const rl = await window.yan.subagents.start(
      'YAN-LONGRUN 请用 write 工具在当前工作目录创建文件：path=longrun.txt，content=longrun。' +
        '只做这一件事，完成后只回复“完成”。'
    )
    ok(rl.ok === true, `长任务启动成功${rl.ok ? '' : '：' + (rl.error ?? '')}`)
    const idL = rl.run?.id
    if (idL) {
      await sleep(1500)
      const beforeL = runOf(idL)
      const cwdBefore = beforeL?.cwd
      ok(!!beforeL, '长任务在列表里')
      /* 切到另一个会话/项目查看（不改运行实例本身） */
      const sessionBefore = st().session
      const parent = mainCwd().replace(/[\\/][^\\/]+$/, '')
      store.setState({ session: { ...(sessionBefore ?? {}), sessionId: 'probe-other-session', cwd: parent } })
      await sleep(2000)
      const afterL = runOf(idL)
      ok(!!afterL, '切换查看对象后，后台子代理仍在 store 里')
      ok(afterL?.cwd === cwdBefore, '后台子代理的 cwd 没有被查看对象切换改掉')
      ok(!!afterL?.parentSessionId, '归属仍记在启动它的父会话上')
      ok(!!q('[data-testid="subagent-strip"]'), '切完之后界面上仍能看到子任务列表')
      store.setState({ session: sessionBefore })
    }

    out.push('')
    out.push('=== 9. 交给退出 ===')
    out.push(`  退出前列表里有 ${st().subagents.length} 条记录（不清空 —— 退出归档的证据在 app 关闭后检查）`)
  } catch (error) {
    out.push('  探针出错: ' + (error?.message ?? String(error)))
  }

  return out.join('\n')
})()
