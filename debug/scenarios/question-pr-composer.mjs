export const meta = { demo: true, description: '提问展开去重，PR 的三个 agent 操作实际填入新版输入框并保留草稿' }

export default async function run({ cdp, check, waitFor, sleep, shot, fake }) {
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ lang: 'zh-CN', theme: 'dark', uiScale: 1, rightPanelOpen: true })`)
  await cdp.evaluate(`window.__yanRightPanel.getState().open({ id: 'pullRequests', kind: 'pullRequests' })`)
  await waitFor(`!!document.querySelector('[data-testid="gh-pr-row-108"]')`)
  await cdp.evaluate(`document.querySelector('[data-testid="gh-pr-row-108"]').click()`)
  await waitFor(`!!document.querySelector('[data-testid="gh-pr-agent"]')`)
  await cdp.evaluate(`window.__yanStore.getState().insertIntoComposer('保留这段已有草稿')`)
  await waitFor(`document.querySelector('[data-testid="composer-input"]').innerText.includes('保留这段已有草稿')`)
  for (const [action, expected] of [['explain', '潜在风险'], ['fix', '失败'], ['respond', '评审']]) {
    await cdp.evaluate(`document.querySelector('[data-testid="gh-pr-agent"]').click()`)
    await waitFor(`!!document.querySelector('[data-testid="gh-pr-agent-${action}"]')`)
    await cdp.evaluate(`document.querySelector('[data-testid="gh-pr-agent-${action}"]').click()`)
    await waitFor(`s.composerInsert === null`)
    await sleep(150)
    const text = await cdp.evaluate(`document.querySelector('[data-testid="composer-input"]').innerText`)
    check(`PR ${action} 提示词真正填入编辑器`, text.includes('108') && text.includes(expected), text.slice(-150))
    check(`PR ${action} 保留原草稿`, text.startsWith('保留这段已有草稿'))
  }
  check('相同 PR 三次操作各追加一次', await cdp.evaluate(`document.querySelector('[data-testid="composer-input"]').innerText.split('https://github.com/').length - 1 === 3`))
  await shot('pr-agent-composer-dark')
  const question = '你的 mine/main 比上游多 5 个提交（3.47～3.50），但最早那个是链接测试提交，加了一个 link-test.txt。PR 里要不要去掉它？'
  await cdp.evaluate(`window.__yanStore.setState({ messages: [
    { id: 'question-fix-user', role: 'user', text: '检查提问显示', timestamp: Date.now() - 2000 },
    { id: 'question-fix-assistant', role: 'assistant', text: '', timestamp: Date.now() - 1000, toolCalls: [
      { id: 'question-fix-call', name: 'question', args: { question: ${JSON.stringify(question)}, options: ['去掉：新建分支只带四个提交发 PR', '保留：直接用 mine/main 发 PR'] }, details: { answer: '去掉：新建分支只带四个提交发 PR' }, output: 'Answer: 去掉：新建分支只带四个提交发 PR', status: 'ok', startedAt: Date.now() - 1000, endedAt: Date.now() }
    ] }
  ], historyLoading: false, switchLoading: false })`)
  await waitFor(`!!document.querySelector('.v3-qrow')`)
  await cdp.evaluate(`document.querySelector('.v3-qrow .ui-collapsible__trigger').click()`)
  await waitFor(`!!document.querySelector('.v3-qrow[data-open] .v3-qrow-question')`)
  check('展开后长问题只显示一次', await cdp.evaluate(`document.querySelector('.v3-qrow').innerText.split(${JSON.stringify(question)}).length - 1 === 1`))
  check('展开标题为提问，正文保留完整问题与选项', await cdp.evaluate(`document.querySelector('.v3-qrow-q').innerText === '提问' && document.querySelectorAll('.v3-qrow-option').length === 2`))
  await sleep(350)
  await shot('question-title-dark')
  await cdp.evaluate(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await sleep(200)
  check('浅色提问正文仍只出现一次', await cdp.evaluate(`document.querySelector('.v3-qrow').innerText.split(${JSON.stringify(question)}).length - 1 === 1`))
  await shot('question-title-light')
  await cdp.evaluate(`document.querySelector('.v3-qrow .ui-collapsible__trigger').click()`)
  await sleep(300)
  check('收起后标题恢复问题摘要', await cdp.evaluate(`document.querySelector('.v3-qrow-q').innerText === ${JSON.stringify(question)}`))
  check('没有发送模型请求', fake.requests.length === 0)
}
