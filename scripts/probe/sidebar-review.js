;(async () => {
  const store = window.__yanStore
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const assert = (condition, label) => { if (!condition) throw new Error(label) }
  localStorage.setItem('yan.onboarded', '1')
  for (const button of document.querySelectorAll('.ob-card button')) {
    if (/开始使用|完成/.test(button.textContent)) button.click()
  }
  const cwd = store.getState().settings.cwd
  const stamp = Date.now()
  const sample = (id, title, parentSession) => ({ id, title, parentSession, path: `${cwd}/${id}.jsonl`, cwd, createdAt: stamp, updatedAt: stamp, lastActivityAt: stamp, messageCount: 2 })
  const root = sample('review-parent', '左右栏结构审阅')
  const child = sample('review-child', '浏览器尺寸修复', root.path)
  const grandchild = sample('review-grandchild', '窄窗口验证', child.path)
  const other = sample('review-other', '字体与文件树')
  const list = [root, child, grandchild, other]
  const group = { id: 'review-group', name: '界面改版', createdAt: stamp }
  const messages = [
    { id: 'review-u', role: 'user', text: '请结合设计方案，检查左右栏与整体界面。' },
    { id: 'review-a', role: 'assistant', text: '**左右栏结构已整理。**\n\n项目下显示主会话，展开后查看分支。长标题保持单行，完整内容可以悬停查看。\n\n- 左栏宽度可以拖动调整，收起后保留常用入口。\n- 右侧浏览器随窗口尺寸变化，工具分区保持可滚动。\n- 正文采用更紧凑的字距，代码保留等宽显示。\n\n```ts\nconst sidebar = { width: 260, collapsed: false }\n```\n\n这是一组独立的界面验证数据。' }
  ]
  store.setState({ sessions: list, messages, session: { ...store.getState().session, sessionId: root.id, sessionFile: root.path, cwd, isAgentRunning: false, isStreaming: false }, notices: [] })
  // Keep the renderer-only fixture independent of pi's disk session refresh.
  store.setState({ refreshSessions: async () => {} })
  store.getState().setRailPinned(true)
  await store.getState().patchSettings({ railWidth: 0, panelWidth: 264, rightPanelOpen: true, browserHeight: 900, projectGroups: [group], projects: [{ id: 'review-project', cwd, name: 'pi-desktop', groupId: group.id, archived: false, createdAt: stamp, updatedAt: stamp }] })
  await sleep(350)
  assert(document.querySelector('[data-testid="rail-project-group"]')?.textContent === group.name, 'Project group must render as a first-level heading')
  const row = (path) => [...document.querySelectorAll('.proj [data-session-path]')].find((el) => el.dataset.sessionPath === path)
  assert(row(root.path) && !row(child.path), 'Branches must start collapsed without duplicate project roots')
  row(root.path).querySelector('[data-testid="rail-branch-toggle"]').click()
  await sleep(100)
  assert(row(child.path) && !row(grandchild.path), 'Opening parent must show only first branch level')
  row(child.path).querySelector('[data-testid="rail-branch-toggle"]').click()
  await sleep(100)
  assert(row(grandchild.path), 'Nested branch must expand independently')
  const widths = list.map((s) => row(s.path).querySelector('.srow-row').getBoundingClientRect().width)
  assert(Math.max(...widths) - Math.min(...widths) < 1, 'Row hit backgrounds must have equal widths')
  const sizes = list.map((s) => getComputedStyle(row(s.path).querySelector('.srow-name')).fontSize)
  assert(new Set(sizes).size === 1, 'Deep branches must retain the base font size')
  assert(JSON.parse(localStorage.getItem('yan.sidebar.expanded-branches')).includes(child.path), 'Branch expansion must persist')
  store.getState().setRailPinned(false)
  await sleep(100)
  assert(Math.abs(document.querySelector('.rail-slot').getBoundingClientRect().width - 48) < 1, 'Collapsed rail must be 48 CSS px')
  assert(document.querySelectorAll('.rail-compact button').length === 4, 'Collapsed rail needs four usable entries')
  store.getState().setRailPinned(true)
  await sleep(100)
  const long = Array.from({ length: 240 }, (_, i) => ({ id: `long-${i}`, role: i % 2 ? 'assistant' : 'user', text: `验证消息 ${i}\n\n` + '长会话布局验证。'.repeat(25) }))
  store.setState({ messages: long })
  await sleep(500)
  assert(document.querySelectorAll('.stream .msg').length < 100, 'Long conversation must remain virtualized')
  const start = performance.now()
  store.getState().setRailPinned(false)
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const elapsed = performance.now() - start
  assert(getComputedStyle(document.querySelector('.workspace')).transitionDuration === '0s', 'Sidebar toggle must not animate repeated text reflow')
  store.setState({ messages })
  store.getState().setRailPinned(true)
  await window.yan.browser.open('http://127.0.0.1:38417')
  await sleep(700)
  const aside = document.querySelector('.rightpanel').getBoundingClientRect()
  const view = document.querySelector('.browser-viewport').getBoundingClientRect()
  assert(view.height > 50 && view.bottom <= aside.bottom - 70, 'Saved browser height must clamp to available window height')
  assert(view.width > 50 && view.right <= aside.right + 1, 'Browser viewport must stay inside right panel')
  await document.fonts.ready
  console.error(`SIDEBAR_REVIEW_READY ${JSON.stringify({ widths, sizes, toggleFrameMs: Math.round(elapsed), viewport: { width: view.width, height: view.height } })}`)
  await sleep(12000) // Allow the host to capture the complete native test window.
  return 'Sidebar review: hierarchy, persistence, collapsed rail, virtualization and viewport bounds passed.'
})()
