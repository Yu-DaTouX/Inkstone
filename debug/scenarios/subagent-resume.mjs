export const meta = { demo: true, description: '子代理续派入口：已结束可续派、worktree 审阅前可续派、不可续派说明原因' }

export default async function run({ cdp, waitFor, check, sleep, shot }) {
  const ev = (expression) => cdp.evaluate(expression)
  await waitFor('s.conn === "ready"')
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })
  await ev(`window.__yanStore.getState().patchSettings({lang:'zh-CN',theme:'dark'})`)
  const run = (id, over) => ({
    id, task: '整理 ledger 的汇总逻辑', cwd: 'C:/demo', isolation: 'shared-cwd', status: 'done', startedAt: Date.now() - 60000, endedAt: Date.now() - 30000,
    transcript: [{ id: 'm1', role: 'assistant', text: '已整理完成。' }], review: 'none', toolCalls: 2, parentSessionId: 'demo', ...over
  })
  const runs = [
    run('sub-00000a01', { resumable: { ok: true } }),
    run('sub-00000a02', { isolation: 'worktree', review: 'pending', diff: { files: 1, additions: 3, deletions: 1, paths: ['a.ts'], truncated: false }, resumable: { ok: true } }),
    run('sub-00000a03', { isolation: 'worktree', review: 'merged', resumable: { ok: false, reason: 'worktree 已合并、放弃或归档清理，原工作树不在了' } }),
    run('sub-00000a04', { isolation: 'worktree', status: 'cancelled', endReason: 'interrupted', review: 'pending', diff: { files: 2, additions: 5, deletions: 1, paths: ['a.ts', 'b.ts'], truncated: false }, resumable: { ok: true } })
  ]
  await ev(`window.__yanStore.setState({ subagents: ${JSON.stringify(runs)} })`)
  const open = async (id) => {
    await ev(`window.__yanRightPanel.getState().open({id:'subagent:${id}',kind:'subagent',runId:'${id}'})`)
    await sleep(500)
  }
  await open('sub-00000a01')
  check('已结束的普通子代理显示续派输入框', await ev(`!!document.querySelector('[data-testid="v3-subagent-composer"][data-mode="resume"]')`))
  check('续派发送按钮标注为「继续」', await ev(`document.querySelector('[data-testid="v3-subagent-composer-send"]')?.getAttribute('aria-label') === '继续'`))
  await shot('subagent-resume-shared')
  await open('sub-00000a02')
  check('审阅前的 worktree 子代理显示续派输入框', await ev(`!!document.querySelector('[data-testid="v3-subagent-composer"][data-mode="resume"]')`))
  await shot('subagent-resume-worktree')
  await open('sub-00000a03')
  const blockedInfo = await ev(`(() => { const c = document.querySelector('[data-testid="rp-surface-subagent:sub-00000a03"] [data-testid="v3-subagent-composer"]'); const line = c?.querySelector('[data-testid="v3-subagent-composer-ended"]'); return { mode: c?.dataset.mode, textarea: !!c?.querySelector('textarea'), title: line?.title, text: line?.innerText, height: c?.getBoundingClientRect().height } })()`)
  check('不可续派时收成一行，原因放悬停', blockedInfo.mode === 'blocked' && !blockedInfo.textarea && (blockedInfo.title ?? '').includes('不能继续：worktree 已合并'), blockedInfo)
  await shot('subagent-resume-blocked')
  await open('sub-00000a04')
  const interrupted = await ev(`(() => { const pane = document.querySelector('[data-testid="rp-surface-subagent:sub-00000a04"]'); const c = pane?.querySelector('[data-testid="v3-subagent-composer"]'); return { mode: c?.dataset.mode, label: c?.querySelector('textarea')?.getAttribute('aria-label'), status: pane?.querySelector('[data-testid="v3-subagent-pane-status"]')?.innerText, review: pane?.querySelector('[data-testid="v3-subagent-review-state"]')?.innerText } })()`)
  check('退出时中断的 worktree 子代理显示「已中断」', (interrupted.status ?? '').includes('已中断'), interrupted)
  check('已中断：审阅栏说明工作树保留、可续接或由主会话合并放弃', (interrupted.review ?? '').includes('工作树已保留'), interrupted)
  check('已中断：输入框可续接并说明按被打断的任务接着做', interrupted.mode === 'resume' && (interrupted.label ?? '').includes('中断'), interrupted)
  await shot('subagent-resume-interrupted')
}
