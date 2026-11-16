import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const meta = { description: '后台会话流式输出时在两个会话间来回切换，统计视图重同步次数与原因，确认重同步不会对同一会话反复触发；不调用真实模型' }

function resyncLines(box) {
  const dir = join(box.dataDir, 'logs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => name.startsWith('main-')).flatMap((name) =>
    readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => line.includes('视图重同步')))
}

export default async function run({ cdp, box, check, report, waitFor, sleep, log, newSession, running }) {
  const ev = (expr) => cdp.evaluate(expr)
  await waitFor('s.conn === "ready"')
  await ev(`window.__yanStore.getState().patchSettings({ permissionMode: 'all' })`)

  await newSession()
  await ev(`window.__yanStore.getState().send('STORM-a STEPS40')`)
  await waitFor(running, 20000, 50)
  const fileA = await ev('window.__yanStore.getState().session?.sessionFile ?? null')
  await sleep(1500)

  await newSession()
  await ev(`window.__yanStore.getState().send('STORM-b STEPS30')`)
  await waitFor(running, 20000, 50)
  const fileB = await ev('window.__yanStore.getState().session?.sessionFile ?? null')
  check('两个会话都在跑', !!fileA && !!fileB && fileA !== fileB, { fileA, fileB })

  const views = []
  for (let round = 0; round < 8; round++) {
    const target = round % 2 === 0 ? fileA : fileB
    await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(target)})`)
    await sleep(2500 + (round % 3) * 700)
    views.push(await ev(`(() => { const s = window.__yanStore.getState(); return { file: s.session?.sessionFile, peek: s.peekedSessionId, active: s.activeRunnerId, msgs: s.messages.length } })()`))
  }
  await ev(`window.__yanStore.getState().switchSession(${JSON.stringify(fileA)})`)
  const end = Date.now() + 180000
  while (Date.now() < end) {
    const busy = await ev(`window.__yanStore.getState().runners.some((r) => r.running)`)
    if (!busy) break
    await sleep(1000)
  }
  await sleep(4000)
  const lines = resyncLines(box)
  report.views = views
  report.resyncs = lines
  log('resyncs', lines.length)
  for (const line of lines) log(line)
  const perSession = new Map()
  for (const line of lines) {
    const key = (line.match(/session=(\S+)/) ?? [])[1] ?? ''
    perSession.set(key, (perSession.get(key) ?? 0) + 1)
  }
  const worst = Math.max(0, ...perSession.values())
  check('同一会话的视图重同步不超过 3 次', worst <= 3, Object.fromEntries(perSession))
}
