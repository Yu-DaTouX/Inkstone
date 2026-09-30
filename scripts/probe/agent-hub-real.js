;(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const project = window.__hubFixture
  if (!project?.cwd) throw new Error('Missing isolated fixture project')
  await window.yan.patchSettings({ projects: [project] })
  const request = { agent: 'codex', mode: 'managed', projectId: project.id, model: 'gpt-6-luna', reasoningEffort: 'low', timeoutMinutes: 3, requestId: 'hub-real-luna-low-smoke', prompt: '这是用户批准的最小测试。只在当前测试工作区创建 hub-smoke.txt，文件内容严格为 inkstone-agent-hub-smoke 加一个换行。不要浏览网页，不要联网，不要安装依赖，不要提交或修改其他文件。完成后报告创建的文件名和内容。' }
  const created = await window.yan.hub.command({ action: 'create', request })
  const duplicate = await window.yan.hub.command({ action: 'create', request })
  if (created.taskId !== duplicate.taskId) throw new Error('Duplicate dispatch created another task')
  const history = []
  for (let i = 0; i < 180; i++) {
    const snapshot = await window.yan.hub.snapshot()
    const task = snapshot.tasks.find((item) => item.id === created.taskId)
    if (history.at(-1) !== task.status) history.push(task.status)
    for (const approval of snapshot.approvals.filter((item) => item.taskId === task.id && item.status === 'pending')) {
      // 文件写入已在测试范围内获授权；其他额外执行请求留作失败证据。
      if (approval.kind === 'file') await window.yan.hub.command({ action: 'answer', approvalId: approval.id, answer: 'accept' })
      else return { ok: false, reason: 'Unexpected approval request', task, approval, history }
    }
    if (['needs_review', 'failed', 'uncertain', 'cancelled'].includes(task.status)) return { ok: task.status === 'needs_review' && !!task.artifact, task, history, approvals: snapshot.approvals }
    await wait(1000)
  }
  await window.yan.hub.command({ action: 'cancel', taskId: created.taskId })
  return { ok: false, reason: 'Real task exceeded bounded probe time', history }
})()
