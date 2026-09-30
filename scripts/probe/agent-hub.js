;(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const snapshot = await window.yan.hub.snapshot()
  if (snapshot.tasks.length) throw new Error('Probe must use empty isolated Hub storage')
  if (!snapshot.adapters.some((a) => a.agent === 'codex' && a.available)) throw new Error('Host did not detect installed Codex')
  const store = window.__yanStore
  if (store) store.setState((state) => ({ settings: { ...state.settings, rightPanelOpen: true, rightPanelView: 'tools' } }))
  for (let i = 0; i < 40; i++) {
    const entry = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('多 Agent 工作台'))
    if (entry) { entry.click(); break }
    await wait(100)
  }
  await wait(1500)
  const panel = document.querySelector('[data-testid="agent-hub"]')
  if (!panel) throw new Error('Agent Hub entry did not open the workbench')
  if (snapshot.adapters.some((a) => !a.available)) throw new Error('Installed CLI unavailable: ' + JSON.stringify(snapshot.adapters.filter((a) => !a.available)))
  await wait(4000)
  return { ok: true, adapters: snapshot.adapters.map(({ agent, available, version, modes }) => ({ agent, available, version, modes })), title: panel.textContent.slice(0, 800), tasks: snapshot.tasks.length }
})()
