import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const meta = {
  description: 'C7：会话列表刷新与路径别名实测（运行中 currentListed 条件、别名、listSessions 遍历耗时随会话数）'
}

const SYNTH_DIR = 'c7-synthetic'

function writeSynthSessions(sessionsDir, from, to, startAt) {
  const dir = join(sessionsDir, SYNTH_DIR)
  mkdirSync(dir, { recursive: true })
  const files = []
  for (let i = from; i < to; i++) {
    const id = `c7-${String(i).padStart(5, '0')}`
    const at = new Date(startAt + i * 1000).toISOString()
    const path = join(dir, `${id}.jsonl`)
    writeFileSync(path, [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: sessionsDir }),
      JSON.stringify({ type: 'message', id: `${id}-m1`, parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: `合成会话 ${i}` }] } }),
      ''
    ].join('\n'))
    files.push(path)
  }
  return files
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
}

export default async function run({ cdp, fake, box, check, report, log, state, until, waitFor, newSession, turn, autoApprove, sleep }) {
  const listTiming = async (times = 5) => {
    const values = []
    for (let i = 0; i < times; i++) {
      values.push(await cdp.evaluate(`(async () => { const t0 = performance.now(); const list = await window.yan.listSessions(); return { ms: performance.now() - t0, n: Array.isArray(list) ? list.length : -1 } })()`))
    }
    return { median: Math.round(median(values.map((item) => item.ms))), samples: values.map((item) => Math.round(item.ms)), listed: values[values.length - 1]?.n }
  }
  const fileState = () => state(`(() => { const norm = (v) => v.replace(/[\\\\/]+/g, '/').toLowerCase(); const file = s.session?.sessionFile ?? null; return { file, running: !!(s.session?.isStreaming || s.session?.isAgentRunning), n: s.sessions.length, exact: !file || s.sessions.some((e) => e.path === file), loose: !file || s.sessions.some((e) => norm(e.path) === norm(file)) } })()`)
  const norm = (value) => value.replace(/[\\/]+/g, '/').toLowerCase()
  const startSampler = () => cdp.evaluate(`(() => {
    const st = window.__yanStore
    const norm = (value) => value.replace(/[\\\\/]+/g, '/').toLowerCase()
    window.__c7 = { samples: [], changes: 0, lastList: null }
    window.__c7.off = st.subscribe((s) => {
      const list = s.sessions
      if (window.__c7.lastList && list !== window.__c7.lastList) window.__c7.changes += 1
      window.__c7.lastList = list
    })
    window.__c7.timer = setInterval(() => {
      const s = st.getState()
      const file = s.session?.sessionFile ?? null
      window.__c7.samples.push({
        t: Date.now(),
        running: !!(s.session?.isStreaming || s.session?.isAgentRunning),
        listed: !file || s.sessions.some((e) => norm(e.path) === norm(file)),
        strict: !file || s.sessions.some((e) => e.path === file)
      })
    }, 100)
  })()`)
  const stopSampler = () => cdp.evaluate(`(() => { clearInterval(window.__c7.timer); window.__c7.off && window.__c7.off(); return { samples: window.__c7.samples, changes: window.__c7.changes } })()`)
  const summarize = (trace) => {
    const samples = trace.samples ?? []
    const runningSamples = samples.filter((item) => item.running)
    const stale = runningSamples.filter((item) => !item.listed)
    let longest = 0
    let cur = 0
    let lastT = 0
    for (const item of samples) {
      if (!item.listed) {
        cur = cur === 0 ? 1 : cur + (item.t - lastT)
        longest = Math.max(longest, cur)
      } else cur = 0
      lastT = item.t
    }
    return {
      samples: samples.length,
      windowMs: samples.length ? samples[samples.length - 1].t - samples[0].t : 0,
      runningSamples: runningSamples.length,
      staleSamples: stale.length,
      longestStaleMs: longest,
      sessionChanges: trace.changes ?? 0
    }
  }

  report.data = {}
  await autoApprove()
  await newSession(box.project)
  await turn('会话列表探针：先建立会话文件。', { timeout: 60000 })
  await sleep(1200)
  const base = await fileState()
  report.data.base = base
  check('会话文件建好并出现在列表里（精确字符串相等）', !!base.file && base.exact, base)

  report.data.timing = { baseline: await listTiming() }
  const sessionsDir = box.sessionsDir
  const startAt = Date.now() - 3_600_000
  let written = 0
  let files = []
  for (const n of [200, 1000, 3000]) {
    files = writeSynthSessions(sessionsDir, written, n, startAt)
    written = n
    await sleep(400)
    report.data.timing[`${n}`] = await listTiming(n === 3000 ? 5 : 3)
    log(`会话数 ${n}: ${JSON.stringify(report.data.timing[`${n}`])}`)
  }
  report.data.synthetic = { dir: join(sessionsDir, SYNTH_DIR), files: files.length, onDisk: readdirSync(join(sessionsDir, SYNTH_DIR)).length }
  check('合成会话按文件数被遍历（列表仍按 200 条上限返回）', report.data.timing['3000']?.listed === 200, report.data.timing['3000']?.listed)

  let live = 0
  const touch = setInterval(() => {
    try {
      live += 1
      const id = `c7-live-${Date.now()}-${live}`
      const at = new Date().toISOString()
      writeFileSync(join(sessionsDir, SYNTH_DIR, `${id}.jsonl`), [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: sessionsDir }),
        JSON.stringify({ type: 'message', id: `${id}-m`, parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: '新增会话' }] } }),
        ''
      ].join('\n'))
    } catch {
    }
  }, 1200)
  await startSampler()
  const sent = await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('CRASHBASH 会话列表刷新采样')})`)
  const sawRunning = await until('!!(s.session?.isStreaming || s.session?.isAgentRunning)', 30000)
  const requestsBefore = fake.requests.length
  await sleep(25000)
  const stillRunning = await state('!!(s.session?.isStreaming || s.session?.isAgentRunning)')
  report.data.runningProbe = { sent, sawRunning, stillRunning, requests: fake.requests.length - requestsBefore }
  await cdp.evaluate('window.__yanStore.getState().abort && window.__yanStore.getState().abort()')
  await until('!s.session?.isStreaming && !s.session?.isAgentRunning', 30000)
  clearInterval(touch)
  await sleep(1200)
  report.data.refreshNormal = summarize(await stopSampler())
  log(`正常运行刷新采样 ${JSON.stringify(report.data.refreshNormal)}`)
  check('正常路径下长命令会话确实在运行', sawRunning && stillRunning, report.data.runningProbe)
  check('正常路径运行期间当前会话始终在列表里（不会启动 2.5s 刷新）', report.data.refreshNormal.staleSamples === 0, report.data.refreshNormal)

  const canonical = await state('s.session?.sessionFile ?? null')
  const variant = canonical.replace(/^([a-zA-Z]):/, (m, letter) => `${letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase()}:`).replace(/\\/g, '/')
  const switched = await cdp.evaluate(`window.yan.switchSession(${JSON.stringify(variant)})`)
  await sleep(1500)
  const afterSwitch = await fileState()
  report.data.alias = { variant, switched, after: afterSwitch, loose: !!afterSwitch.file && afterSwitch.file.includes('/') || norm(afterSwitch.file ?? '') === norm(canonical) }
  check('大小写/分隔符变体路径仍能打开同一会话', switched?.ok === true, switched)
  check('变体路径打开后被认作列表里的同一会话（规范化比较，不再陷入「不在列表」）', afterSwitch.loose === true, afterSwitch)

  let aliasLive = 0
  const aliasTouch = setInterval(() => {
    try {
      aliasLive += 1
      const id = `c7-alias-${Date.now()}-${aliasLive}`
      const at = new Date().toISOString()
      writeFileSync(join(sessionsDir, SYNTH_DIR, `${id}.jsonl`), [
        JSON.stringify({ type: 'session', version: 3, id, timestamp: at, cwd: sessionsDir }),
        JSON.stringify({ type: 'message', id: `${id}-m`, parentId: null, timestamp: at, message: { role: 'user', content: [{ type: 'text', text: '新增会话' }] } }),
        ''
      ].join('\n'))
    } catch {
    }
  }, 1200)
  await startSampler()
  const sentAlias = await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('CRASHBASH 别名状态下采样')})`)
  const aliasRunning = await until('!!(s.session?.isStreaming || s.session?.isAgentRunning)', 20000)
  report.data.aliasProbe = { sentAlias, aliasRunning }
  await sleep(12000)
  clearInterval(aliasTouch)
  report.data.refreshAlias = summarize(await stopSampler())
  log(`别名状态刷新采样 ${JSON.stringify(report.data.refreshAlias)}`)
  await cdp.evaluate('window.__yanStore.getState().abort && window.__yanStore.getState().abort()')
  await until('!s.session?.isStreaming && !s.session?.isAgentRunning', 30000)

  const sessionId = await state('s.session?.sessionId')
  const moved = await cdp.evaluate(`window.yan.moveSession(${JSON.stringify(sessionId)}, null, ${JSON.stringify(box.projects[1] ?? box.project)})`)
  await sleep(1500)
  const afterMove = await fileState()
  report.data.move = { moved, after: afterMove }
  check('移动会话的正式 RPC 成功', moved?.ok === true, moved)
  check('移动后当前会话仍在列表里（规范化比较）', afterMove.loose === true, afterMove)
  check('别名状态运行期间同样不陷入 2.5s 轮询刷新', (report.data.refreshAlias?.sessionChanges ?? 0) <= (report.data.refreshNormal?.sessionChanges ?? 0) + 1, { normal: report.data.refreshNormal?.sessionChanges, alias: report.data.refreshAlias?.sessionChanges })
}
