import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connectCdp, holdProbe, killTree, launchApp, storeHelpers } from './lib/app.mjs'
import { freePort, newRunDir, sleep } from './lib/env.mjs'
import { startFakeModel } from './lib/fake-model.mjs'
import { createSandbox, sandboxEnv } from './lib/sandbox.mjs'

const out = resolve(process.argv[2] ?? join(newRunDir('restart-queue-recovery')))
mkdirSync(out, { recursive: true })
delete process.env.ELECTRON_RUN_AS_NODE

const QUEUED_TEXT = '排队消息：宿主重启后应该回填到输入框。'
const checks = []
const log = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, ...(detail === undefined ? {} : { detail }) })
  console.log(ok ? 'PASS' : 'FAIL', name, detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400))
}
const stage = (name, detail) => {
  log.push({ at: new Date().toISOString(), name, detail })
  console.log('STAGE', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300))
}

const fake = await startFakeModel()
const runDir = join(out, 'run')
mkdirSync(runDir, { recursive: true })
const box = createSandbox(runDir, { fakePort: fake.port })

async function launch(label) {
  const cdpPort = await freePort()
  const app = launchApp({ ...sandboxEnv(box, { fake: true, cdpPort, probe: holdProbe }) })
  const cdp = await connectCdp(cdpPort, { shotDir: out })
  const helpers = storeHelpers(cdp)
  if (!(await helpers.until('s.conn === "ready"', 90000))) throw new Error(`${label}: conn 未 ready`)
  stage(`${label}-ready`)
  return { app, cdp, ...helpers }
}

const queueFile = (sessionId) => join(box.dataDir, 'queue-recovery', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}
const record = { startedAt: new Date().toISOString(), runDir, box: { project: box.project, piDir: box.piDir, dataDir: box.dataDir }, checks, log, data: {} }

let first
let second
try {
  first = await launch('first')
  const { cdp, state, until } = first
  await cdp.evaluate('window.yan.win.maximize?.()').catch(() => {})
  await cdp.evaluate(`window.__yanStore.getState().newSession({ cwd: ${JSON.stringify(box.project)} })`)
  await until('!!s.session?.sessionFile', 20000)
  const sessionId = await state('s.session?.sessionId ?? null')
  const sessionFile = await state('s.session?.sessionFile ?? null')
  record.data.sessionId = sessionId
  record.data.sessionFile = sessionFile
  check('第一实例建立会话', !!sessionId && !!sessionFile, { sessionId, sessionFile })

  const sent = await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify('CRASHBASH 重启前跑一条长命令')})`)
  const running = await until('!!(s.session?.isStreaming || s.session?.isAgentRunning)', 30000)
  check('长命令会话开始运行', sent === true && running, { sent, running })
  stage('long-command-running')

  const queued = await cdp.evaluate(`window.__yanStore.getState().send(${JSON.stringify(QUEUED_TEXT)}, undefined, 'followUp')`)
  const sawQueue = await until('s.queue.followUp.some((item) => item.text.includes("重启后应该回填"))', 20000)
  const queueState = await state('s.queue')
  record.data.queue = { queued, sawQueue, queueState }
  check('运行中投递的跟进消息进入队列', queued === true && sawQueue, queueState)

  const filePath = queueFile(sessionId)
  const persisted = await until(() => existsSync(filePath), 15000)
  const persistedBody = readJson(filePath)
  record.data.persistedQueue = { path: filePath, persisted, body: persistedBody }
  check('队列写进 queue-recovery 持久化文件', persisted && JSON.stringify(persistedBody ?? {}).includes('重启后应该回填'), persistedBody)

  const shotBefore = await cdp.shot('before-exit')
  record.data.shotBefore = shotBefore
  stage('kill-first-instance')
  killTree(first.app.child.pid)
  await sleep(4000)
  try {
    first.cdp.close()
  } catch {
  }
  first = null

  second = await launch('second')
  const { cdp: cdp2, state: state2, until: until2 } = second
  await cdp2.evaluate('window.yan.win.maximize?.()').catch(() => {})
  await sleep(2000)
  const landed = await state2(
    '({ sessionId: s.session?.sessionId ?? null, file: s.session?.sessionFile ?? null, running: !!(s.session?.isStreaming || s.session?.isAgentRunning), msgs: s.messages.length, runners: s.runners.map((r) => r.sessionId), notices: (s.notices ?? []).map((n) => n.text ?? "") })'
  )
  record.data.landed = landed
  check('重启后没有卡在运行中', landed.running === false, landed.running)
  check('上次会话在重启后回到运行实例列表', landed.runners.includes(sessionId), { expected: sessionId, runners: landed.runners })
  const listed = await state2(`s.sessions.some((entry) => entry.path === ${JSON.stringify(sessionFile)})`)
  record.data.listed = listed
  check('上次会话仍在会话列表里', listed === true, listed)
  if (landed.sessionId !== sessionId) stage('landed-on-other-session', { landed: landed.sessionId, expected: sessionId })

  const reclaimedFile = `${filePath}.reclaimed`
  const reclaimedOnDisk = await until2(() => existsSync(reclaimedFile) && !existsSync(filePath), 30000)
  const reclaimNotice = await state2('(s.notices ?? []).some((n) => /回填|reclaim/i.test(n.text ?? ""))')
  record.data.reclaimDisk = { reclaimedOnDisk, reclaimedFileExists: existsSync(reclaimedFile), queueFileExists: existsSync(filePath), reclaimNotice, notices: landed.notices }
  check('排队消息从磁盘回收并改名为 .reclaimed', reclaimedOnDisk === true, record.data.reclaimDisk)

  const opened = await cdp2.evaluate(`window.__yanStore.getState().switchSession(${JSON.stringify(sessionFile)})`)
  const back = await until2(`s.session?.sessionId === ${JSON.stringify(sessionId)} && s.messages.some((m) => (m.text ?? "").includes("CRASHBASH"))`, 90000)
  const openedState = await state2(
    '({ sessionId: s.session?.sessionId ?? null, running: !!(s.session?.isStreaming || s.session?.isAgentRunning), msgs: s.messages.length, texts: s.messages.map((m) => (m.text ?? "").slice(0, 30)), queueRestore: s.queueRestore ?? null })'
  )
  record.data.opened = { opened, back, ...openedState }
  check('从侧栏打开上次会话后历史回填（含重启用例消息）', back === true, openedState.texts)
  stage('session-opened', { msgs: openedState.msgs })

  const restoredText = await until2(`(s.queueRestore ?? "").includes("重启后应该回填")`, 30000)
  const composerText = await cdp2.evaluate(
    `(() => { const el = document.querySelector('[data-testid="composer-input"]'); return (el?.value ?? el?.textContent ?? '').trim() })()`
  )
  record.data.reclaimView = { restoredText, composerText, queueRestore: await state2('s.queueRestore ?? null'), attachments: await state2('s.attachments.length') }
  check('切到该会话后排队消息回填到输入框', restoredText === true || composerText.includes('重启后应该回填'), record.data.reclaimView)
  const shotAfter = await cdp2.shot('after-restart')
  record.data.shotAfter = shotAfter

  const recoverText = (record.data.reclaimView.queueRestore ?? '').trim() || QUEUED_TEXT
  const before = fake.requests.length
  const resent = await cdp2.evaluate(`window.__yanStore.getState().send(${JSON.stringify(recoverText)})`)
  const answered = await until2(
    '!s.session?.isStreaming && !s.session?.isAgentRunning && s.messages.some((m) => m.role === "assistant" && (m.text ?? "").includes("好的，收到"))',
    120000
  )
  record.data.resend = { resent, requests: fake.requests.length - before, answered }
  check('回填的排队消息能正常发出并得到答复', resent === true && fake.requests.length - before >= 1 && answered, record.data.resend)
} catch (error) {
  record.fatal = String(error?.stack ?? error)
  console.log('FATAL', record.fatal)
} finally {
  try {
    second?.cdp?.close()
  } catch {
  }
  try {
    first?.cdp?.close()
  } catch {
  }
  if (first) killTree(first.app.child.pid)
  if (second) killTree(second.app.child.pid)
  fake.server.close()
  record.mainLogTail = second?.app.log().slice(-6000) ?? first?.app.log().slice(-6000) ?? ''
  record.finishedAt = new Date().toISOString()
  writeFileSync(join(out, 'restart-queue-recovery.json'), JSON.stringify(record, null, 2))
  console.log(`报告 ${join(out, 'restart-queue-recovery.json')}`)
  const failed = checks.filter((item) => !item.ok)
  process.exit(record.fatal || failed.length ? 1 : 0)
}
