export const meta = { description: '连续派写入型子代理：第一个在当前目录，后面的自动进 worktree；同时截图 Key 故障转移开关' }

export default async function run({ cdp, box, waitFor, check, report, sleep, shot, autoApprove, newSession }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.project)
  await ev(`window.__yanStore.getState().send('SUBAGENTS3')`)
  await waitFor(`Object.values(s.subagents ?? {}).length >= 3 || (s.subagents?.length ?? 0) >= 3`, 60000, 100)
  const modes = await ev(`(() => { const all = window.__yanStore.getState().subagents; return (Array.isArray(all) ? all : Object.values(all)).map((run) => run.isolation).sort() })()`)
  report.modes = modes
  check('一个在当前目录，两个自动进 worktree', JSON.stringify(modes) === JSON.stringify(['shared-cwd', 'worktree', 'worktree']), modes)
  await ev(`window.__yanStore.getState().patchSettings({ theme: 'light' })`)
  await ev(`window.__yanStore.getState().openSettings('models')`)
  await sleep(800)
  await ev(`document.querySelector('[data-testid="ms-key-failover"]')?.scrollIntoView({ block: 'center' })`)
  await sleep(300)
  check('模型页直接能看到 Key 故障转移开关', await ev(`!!document.querySelector('[data-testid="ms-key-failover"]')`))
  await shot('settings-key-failover')
}
