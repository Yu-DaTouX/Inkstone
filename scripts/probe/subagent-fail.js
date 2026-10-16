;(async () => {
  const out = []
  const ok = (c, s, extra = '') => {
    out.push((c ? '  ✓ ' : '  ✗ ') + s + (extra ? '  ' + extra : ''))
    return !!c
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (s) => document.querySelector(s)
  const store = window.__yanStore
  const click = (el) => el && el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  if (!store) return '  ⤺ 跳过：没有 window.__yanStore'

  const waitStatus = async (id, done, timeoutMs) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const run = store.getState().subagents.find((r) => r.id === id)
      if (run && done.includes(run.status)) return run
      await sleep(500)
    }
    return store.getState().subagents.find((r) => r.id === id) ?? null
  }

  try {
    localStorage.setItem('yan.onboarded', '1')
    for (let i = 0; i < 25; i++) {
      const c = q('.ob-card')
      if (!c) break
      const b = [...c.querySelectorAll('button')].find((x) => /开始使用|完成/.test(x.textContent))
      if (b) {
        click(b)
        await sleep(250)
      } else await sleep(120)
    }
    for (let i = 0; i < 60; i++) {
      if (store.getState().settings && q('.composer-wrap')) break
      await sleep(250)
    }
    await sleep(800)

    out.push('=== 1. 真实启动一个子代理（模型名是坏的）===')
    ok(!q('[data-testid="subagent-new"]'), '专用「调用子代理」入口已撤下（U4）')
    const taskText = 'YAN-SUBFAIL 只回答两个字：收到'
    await store.getState().startSubagent(taskText)

    let started = null
    for (let i = 0; i < 40; i++) {
      started = store.getState().subagents[store.getState().subagents.length - 1]
      if (started?.task === taskText) break
      await sleep(300)
    }
    ok(!!started?.id, `拿到 run id（${started?.id ?? '无'}）`)
    if (!started?.id) return out.join('\n')

    out.push('')
    out.push('=== 2. 终态必须如实反映模型失败 ===')
    const done = await waitStatus(started.id, ['done', 'error', 'cancelled'], 90000)
    out.push(`  status=${done?.status}`)
    out.push(`  error=${JSON.stringify(done?.error ?? null)}`)
    out.push(`  latestActivity=${JSON.stringify(done?.latestActivity ?? null)}`)
    out.push(`  isolation=${done?.isolation} review=${done?.review} worktreeDone=${done?.worktreeDone}`)
    out.push('  转录：')
    for (const m of done?.transcript ?? []) {
      out.push(
        `   · role=${m.role} error=${JSON.stringify(m.error ?? null)} text=${JSON.stringify((m.text ?? '').slice(0, 160))}`
      )
      for (const c of m.toolCalls ?? []) {
        out.push(`     tool=${c.name} status=${c.status} out=${JSON.stringify((c.output ?? '').slice(0, 120))}`)
      }
    }

    ok(done?.status === 'error', '终态是 error（模型失败没被 settled 当成「已完成」）', String(done?.status))
    ok(/模型返回错误/.test(done?.error ?? ''), 'error 里有可读原因', JSON.stringify(done?.error))
    ok(done?.latestActivity !== '已完成', '列表里的活动也不是「已完成」', JSON.stringify(done?.latestActivity))
    const assistants = (done?.transcript ?? []).filter((m) => m.role === 'assistant')
    ok(assistants.some((m) => m.error), '转录里那条 assistant 自己标了 error（pi 侧证据）')

    out.push('')
    out.push('=== 3. 隔离工作区照常收口 ===')
    let settledRun = done
    const t0 = Date.now()
    while (Date.now() - t0 < 20000) {
      settledRun = store.getState().subagents.find((r) => r.id === started.id) ?? settledRun
      if (settledRun?.diff !== undefined) break
      await sleep(400)
    }
    out.push(
      `  review=${settledRun?.review} diffFiles=${settledRun?.diff?.files} resultPath=${settledRun?.resultPath ? '有' : '无'}`
    )
    ok(settledRun?.review === 'none', '没有改动 → review=none（worktree 已收口）', String(settledRun?.review))
    ok(settledRun?.diff?.files === 0, '差异摘要为 0 个文件', String(settledRun?.diff?.files))
  } catch (error) {
    out.push('  ✗ 抛异常：' + (error?.message ?? String(error)))
  }
  return out.join('\n')
})()
