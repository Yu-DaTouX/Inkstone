import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '漏掉一次新增消息推送后的自愈：运行中在渲染端丢掉一条 msg-add，界面应在几秒内追平主进程并在主进程日志留下视图重同步记录，不调用真实模型' }

function mainLogLines(root) {
  const out = []
  for (const entry of readdirSync(root, { recursive: true })) {
    const name = String(entry)
    if (!/main-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue
    try { out.push(...readFileSync(join(root, name), 'utf8').split('\n')) } catch {}
  }
  return out
}

export default async function run({ cdp, box, runDir, waitFor, check, report, sleep, log, autoApprove, newSession, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  await autoApprove()
  await newSession(box.project)
  await ev(`(() => {
    const store = window.__yanStore;
    const original = store.getState().applyPush;
    window.__heal = { armed: false, dropped: null, seen: 0 };
    store.setState({ applyPush: (m) => {
      const heal = window.__heal;
      if (heal.armed && !heal.dropped && m.ch === 'msg-add' && m.payload?.role === 'assistant') {
        heal.seen++;
        if (heal.seen === 2) { heal.dropped = m.payload.id; return }
      }
      return original(m);
    } });
  })()`)
  await sleep(500)
  await ev(`window.__yanStore.getState().send('STORM-H STEPS12 \\u81ea\\u6108')`)
  await waitFor(running, 20000, 20)
  await ev(`window.__heal.armed = true`)
  await waitFor('!!window.__heal.dropped', 60000, 20)
  const dropped = await ev('window.__heal.dropped')
  log('dropped', dropped)
  const droppedAt = Date.now()
  let healedMs = null
  while (Date.now() - droppedAt < 2500) {
    const probe = await ev(`({ viewHas: window.__yanStore.getState().messages.some((m) => m.id === ${JSON.stringify(dropped)}), running: !!(window.__yanStore.getState().session?.isAgentRunning || window.__yanStore.getState().session?.isStreaming) })`)
    if (probe.viewHas && probe.running) { healedMs = Date.now() - droppedAt; break }
    await sleep(50)
  }
  report.healedMs = healedMs
  log('healed-while-running-ms', healedMs)
  check('运行中 2.5 秒内补回丢掉的消息', healedMs !== null, healedMs)

  await waitFor(`!(${running})`, 120000, 100)
  await sleep(4000)
  const end = await ev(`(async () => {
    const s = window.__yanStore.getState();
    const main = await window.yan.getMessages();
    const ids = new Set(s.messages.map((m) => m.id));
    return { viewCount: s.messages.length, mainCount: main.length, missing: main.filter((m) => !ids.has(m.id)).length, viewLast: s.messages.at(-1)?.id, mainLast: main.at(-1)?.id, hasDropped: ids.has(${JSON.stringify(dropped)}), finalVisible: document.body.innerText.includes('\\u7ed3\\u675f\\u3002') };
  })()`)
  report.end = end
  log('end', end)
  check('丢掉的消息已由重新同步补回', end.hasDropped, end)
  check('结束时界面与主进程一致', end.missing === 0 && end.viewLast === end.mainLast, end)
  check('最终答案显示在界面上', end.finalVisible, end)
  const lines = mainLogLines(runDir).filter((line) => line.includes('\u89c6\u56fe\u91cd\u540c\u6b65'))
  report.resyncLog = lines.slice(-5)
  log('resync-log', lines.slice(-5))
  check('主进程日志留下视图重同步记录', lines.length > 0, lines.length)
}
