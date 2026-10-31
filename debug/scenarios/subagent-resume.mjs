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
    run('sub-00000a03', { isolation: 'worktree', review: 'merged', resumable: { ok: false, reason: 'worktree 已合并、放弃或归档清理，原工作树不在了' } })
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
  check('不可续派时说明原因而不是隐藏', await ev(`document.querySelector('[data-testid="v3-subagent-resume-blocked"]')?.textContent.includes('不能继续')`))
  await shot('subagent-resume-blocked')
}
