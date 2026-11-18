export const meta = { description: '终端自动展示复用用户已开的 local 标签，连续事件不重复，隐藏后重新展示并保持会话归属；合成宿主事件，不调用真实模型' }

const PANEL = `(() => ({
  tabs: [...document.querySelectorAll('[data-testid="terminal-tabs"] [data-testid^="terminal-tab-"]')].map((node) => node.getAttribute('data-testid')),
  active: document.querySelector('.term-pane-host[data-active="1"]')?.getAttribute('data-testid'),
  hosts: document.querySelectorAll('.term-pane-host').length,
  ready: document.querySelector('[data-testid="terminal-pane"]')?.getAttribute('data-phase') === 'ready'
}))()`

export default async function run({ cdp, box, newSession, waitFor, check, shot, sleep, report }) {
  const ev = (code) => cdp.evaluate(code)
  const emit = async (owner, id, count = 1) => ev(`(() => {
    const s = window.__yanStore.getState()
    for (let i = 0; i < ${count}; i++) {
      s.applyPush({ ch: 'terminal', payload: { kind: 'agent', id: ${JSON.stringify(id)}, owner: ${JSON.stringify(owner)}, agentPhase: 'start', agentAction: 'write' } })
      s.applyPush({ ch: 'terminal', payload: { kind: 'agent', id: ${JSON.stringify(id)}, owner: ${JSON.stringify(owner)}, agentPhase: 'end', agentAction: 'write' } })
    }
    return true
  })()`)

  await newSession(box.project)
  await ev('window.__yanRightPanel.getState().open({ id: "terminal", kind: "terminal" })')
  await waitFor('document.querySelector("[data-testid=terminal-pane]")?.getAttribute("data-phase") === "ready"', 30000)
  const before = await ev(PANEL)
  const terminals = await ev('window.yan.terminal.list()')
  const terminal = terminals.find((item) => item.alive)
  check('用户手动打开的终端使用 local 标签且只有一个后台进程', before.tabs.length === 1 && before.tabs[0].includes('local-') && terminals.length === 1, { before, terminals: terminals.map(({ id, owner }) => ({ id, owner })) })
  if (!terminal) throw new Error('用户终端未启动')

  await emit(terminal.owner, terminal.id, 5)
  await sleep(500)
  const repeated = await ev(PANEL)
  report.repeated = repeated
  check('连续五次自动展示复用原标签，不新增 xterm', repeated.tabs.length === 1 && repeated.hosts === 1 && repeated.active === before.active && repeated.ready, repeated)
  check('自动展示没有新建或结束后台终端', (await ev('window.yan.terminal.list()')).filter((item) => item.alive).length === 1)
  await shot('manual-terminal-reused')

  await ev('window.__yanRightPanel.getState().setOpen(false)')
  await sleep(200)
  await emit(terminal.owner, terminal.id)
  await waitFor('document.querySelector("[data-testid=terminal-pane]")?.getAttribute("data-visible") === "1"', 15000)
  const reopened = await ev(PANEL)
  check('隐藏后自动展示仍选中原标签', reopened.tabs.length === 1 && reopened.active === before.active, reopened)

  await ev('document.querySelector("[data-testid=terminal-new]").click()')
  await waitFor('document.querySelectorAll(".term-pane-host").length === 2 && document.querySelector("[data-testid=terminal-pane]")?.getAttribute("data-phase") === "ready"', 30000)
  const second = await ev(PANEL)
  check('用户另开一个终端后确实有两个不同标签', second.tabs.length === 2 && second.active !== before.active, second)
  await emit(terminal.owner, terminal.id, 3)
  await sleep(300)
  const switched = await ev(PANEL)
  check('自动展示能从第二个标签切回目标，不重复挂载', switched.tabs.length === 2 && switched.hosts === 2 && switched.active === before.active, switched)
  await shot('target-terminal-selected')

  await ev('window.__yanRightPanel.getState().setWidth(360); document.querySelector("[data-testid=terminal-new]").click()')
  await waitFor('document.querySelectorAll(".term-pane-host").length === 3 && document.querySelector("[data-testid=terminal-pane]")?.getAttribute("data-phase") === "ready"', 30000)
  const list = 'document.querySelector("[data-testid=terminal-tabs]")'
  const tabs = `${list}.querySelectorAll('[role="tab"]')`
  await waitFor(`${list}.scrollWidth > ${list}.clientWidth`, 5000)
  await ev(`${list}.querySelector('[aria-selected="true"]').focus()`)
  for (const [key, code, index] of [['Home', 36, 0], ['End', 35, 2]]) {
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code })
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code })
    const tab = `${tabs}[${index}]`
    await waitFor(`${tab} === document.activeElement && ${tab}.getAttribute('aria-selected') === 'true'`, 5000)
    const geometry = await ev(`(() => {
      const list = ${list}.getBoundingClientRect()
      const tab = ${tab}.closest('.ui-ptab').getBoundingClientRect()
      return { left: tab.left - list.left, right: list.right - tab.right }
    })()`)
    check(`窄栏 ${key} 切换后当前标签完整可见`, geometry.left >= -1 && geometry.right >= -1, geometry)
  }

  await ev('window.__yanRightPanel.getState().setOpen(false)')
  await sleep(200)
  await emit('another-session-owner', terminal.id)
  await sleep(300)
  check('其他会话的自动展示不打开当前面板', await ev('(() => { const p = window.__yanRightPanel.getState(); return !p.byKey[p.key]?.open })()'))
}
