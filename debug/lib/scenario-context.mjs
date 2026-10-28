import { storeHelpers } from './app.mjs'
import { sleep } from './env.mjs'

export function scenarioContext({ cdp, fake, box, runDir, report }) {
  const { state, until } = storeHelpers(cdp)
  const log = (...parts) => {
    const line = parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')
    report.log.push(line)
    console.log(line)
  }
  const check = (name, ok, detail) => {
    report.checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
    console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail))
    return !!ok
  }
  const running = '!!(s.session?.isStreaming || s.session?.isAgentRunning)'
  const waitFor = async (expr, timeout = 30000, step = 50) => {
    if (await until(expr, timeout, step)) return
    const snap = await state('({ cwd: s.session?.cwd, file: s.session?.sessionFile, conn: s.conn, switchLoading: s.switchLoading, peek: s.peekedPath, msgs: s.messages.length })').catch((error) => String(error))
    throw new Error(`等待超时：${expr} 当前=${JSON.stringify(snap)}`)
  }
  const newSession = async (cwd = box.project) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(cwd)} })`)
      if (await until(`s.session?.cwd === ${JSON.stringify(cwd)}`, 4000)) return attempt
    }
    throw new Error('新建会话没有落到目标目录')
  }
  const turn = async (text, opts = {}) => {
    const before = fake?.requests.length ?? 0
    const sent = await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify(text)}${opts.images ? `, ${JSON.stringify(opts.images)}` : ''})`)
    if (sent === false) throw new Error(`发送失败：${text}`)
    const end = Date.now() + 15000
    while (Date.now() < end && !(await state(running)) && (fake?.requests.length ?? 0) === before) await sleep(20)
    if (opts.during) await opts.during()
    await waitFor(`!(${running})`, opts.timeout ?? 120000)
    await sleep(opts.settleMs ?? 600)
    return { requests: (fake?.requests.length ?? 0) - before }
  }
  const autoApprove = () => cdp.evaluate(`(() => { const st = window.__yanStore; if (window.__autoApprove) return; const seen = new Set(); window.__autoApprove = st.subscribe((s) => { try { const list = Array.isArray(s.approvals) ? s.approvals : Object.values(s.approvals ?? {}); for (const a of list) { if (a && a.id && !seen.has(a.id)) { seen.add(a.id); setTimeout(() => void st.getState().answerApproval(a.id, 'session'), 0) } } } catch {} }) })()`)
  const shot = (name) => cdp.shot(name, runDir)
  return { cdp, fake, box, runDir, report, state, until, waitFor, log, check, newSession, turn, autoApprove, shot, sleep, running }
}
