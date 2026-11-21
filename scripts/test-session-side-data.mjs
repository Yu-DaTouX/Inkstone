import './lib/test-isolate.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

const A = 'sess-aaaa-0001'
const B = 'sess-bbbb-0002'
const fileA = `2026-11-01T00-00-00-000Z_${A}.jsonl`
const fileB = `2026-11-02T00-00-00-000Z_${B}.jsonl`
const header = (id) => `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-11-01T00:00:00.000Z', cwd: process.cwd() })}\n`

await runSuite(import.meta.url, async (ok, compile) => {
  const root = mkdtempSync(join(tmpdir(), 'inkstone-side-data-'))
  const saved = { YAN_PI_DIR: process.env.YAN_PI_DIR, YAN_DATA_DIR: process.env.YAN_DATA_DIR, YAN_SESSIONS_DIR: process.env.YAN_SESSIONS_DIR }
  try {
    const pi = join(root, 'pi')
    const yan = join(root, 'yan')
    process.env.YAN_PI_DIR = pi
    process.env.YAN_DATA_DIR = yan
    process.env.YAN_SESSIONS_DIR = join(pi, 'sessions')
    const sessions = join(pi, 'sessions', 'proj')
    mkdirSync(sessions, { recursive: true })
    mkdirSync(yan, { recursive: true })

    const entry = "export * from './src/main/session-side-data.ts'; export { configureSources, sourcesDir, saveImage } from './src/main/sources.ts'; export { ApprovalLogStore } from './src/main/approval-log.ts'; export { QuestionLogStore } from './src/main/question-log.ts'; export { SessionCodeStore } from './src/main/runs/session-codes.ts'"
    const m = await compile(null, { stdin: { contents: entry, resolveDir: process.cwd() } })
    m.configureSources({ dir: yan })

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString('base64')
    for (const id of [A, B]) m.saveImage({ sessionId: id, name: 'a.png', mimeType: 'image/png', base64: png })
    const timing = join(yan, 'turn-timing')
    const plans = join(yan, 'task-plans')
    const acpPrefs = join(yan, 'antigravity-sessions')
    mkdirSync(timing, { recursive: true })
    mkdirSync(plans, { recursive: true })
    mkdirSync(acpPrefs, { recursive: true })
    for (const file of [fileA, fileB]) writeFileSync(join(timing, `${file.replace(/\.jsonl$/, '')}.jsonl`), '{"turn":1}\n')
    for (const id of [A, B]) writeFileSync(join(plans, `${id}.jsonl`), '{"op":"set"}\n')
    writeFileSync(join(acpPrefs, `${B}.json`), JSON.stringify({ model: { id: 'pro', name: 'Gemini Pro' } }))
    const approvalFile = join(root, 'approval-log.json')
    const questionFile = join(root, 'question-log.json')
    const receipt = (id) => ({ id: `r-${id}`, toolCallId: `t-${id}`, kind: 'danger', tool: 'bash', title: 'rm', choice: 'once', at: 1700000000000, futureField: 'keep-me' })
    writeFileSync(approvalFile, JSON.stringify({ version: 1, note: 'top-level', sessions: { [A]: [receipt(A)], [B]: [receipt(B)] } }))
    writeFileSync(questionFile, JSON.stringify({ version: 1, sessions: { [A]: [{ id: 'q1', question: 'x?', options: [], answer: 'y', at: 1700000000000 }], [B]: [{ id: 'q2', question: 'z?', options: [], answer: null, at: 1700000000000 }] } }))
    const approvals = new m.ApprovalLogStore(() => approvalFile)
    const questions = new m.QuestionLogStore(() => questionFile)
    const codes = new m.SessionCodeStore({ root: yan })
    ok(await codes.assign(A, 'session') === 'S1' && await codes.assign(B, 'session') === 'S2', '会话编号按顺序分配')

    const trashed = []
    const deps = {
      yanDir: yan,
      trash: async (path) => { trashed.push(path); rmSync(path, { recursive: true, force: true }) },
      approvalLog: approvals,
      questionLog: questions,
      forgetSessionCode: (id) => codes.forget(id)
    }
    const result = await m.purgeSessionSideData(deps, { sessionId: B, fileName: fileB })
    ok(result.errors.length === 0 && result.removed.slice().sort().join() === 'antigravity-sessions,approval-log,question-log,session-codes,sources,task-plans,turn-timing', '一次清掉该会话的全部旁路数据', JSON.stringify(result))
    ok(trashed.length === 4 && trashed.every((path) => path.includes(yan)), '文件和目录交给回收站函数，不直接删除', trashed.join())
    ok(!existsSync(join(timing, `${fileB.replace(/\.jsonl$/, '')}.jsonl`)) && !existsSync(join(plans, `${B}.jsonl`)) && !existsSync(join(acpPrefs, `${B}.json`)) && !existsSync(m.sourcesDir(B)), 'turn-timing、task-plans、antigravity-sessions、sources 已移走')
    ok(existsSync(join(timing, `${fileA.replace(/\.jsonl$/, '')}.jsonl`)) && existsSync(join(plans, `${A}.jsonl`)) && existsSync(m.sourcesDir(A)), '其他会话的旁路数据不动')
    const approvalDoc = JSON.parse(readFileSync(approvalFile, 'utf8'))
    const questionDoc = JSON.parse(readFileSync(questionFile, 'utf8'))
    ok(!approvalDoc.sessions[B] && approvalDoc.sessions[A]?.[0]?.futureField === 'keep-me' && approvalDoc.note === 'top-level', '审批记录只去掉该会话，其他会话与未知字段保留', JSON.stringify(approvalDoc))
    ok(!questionDoc.sessions[B] && questionDoc.sessions[A]?.length === 1, '提问记录只去掉该会话')
    ok(codes.codeFor(B) === undefined && codes.codeFor(A) === 'S1', '会话编号条目已清理，其他会话不变')
    ok(await codes.assign('sess-cccc-0003', 'session') === 'S3', '清理后新会话不会复用已用过的编号')
    const reloaded = new m.SessionCodeStore({ root: yan })
    await reloaded.load()
    ok(await reloaded.assign('sess-dddd-0004', 'session') === 'S4', '编号下限写入文件，重启后仍不复用')

    const again = await m.purgeSessionSideData(deps, { sessionId: B, fileName: fileB })
    ok(again.removed.length === 0 && again.errors.length === 0, '重复清理是空操作')

    const failing = await m.purgeSessionSideData({ ...deps, trash: async () => { throw new Error('回收站不可用') } }, { sessionId: A, fileName: fileA })
    ok(failing.errors.length === 3 && failing.removed.includes('approval-log') && existsSync(m.sourcesDir(A)), '回收站失败时保留文件并报告，其余步骤继续', JSON.stringify(failing))
    const unsafe = await m.purgeSessionSideData(deps, { sessionId: '../x', fileName: undefined })
    ok(unsafe.removed.length === 0, '不合法的会话 id 不动任何数据', JSON.stringify(unsafe))

    const sessionsApi = async () => compile('src/main/sessions.ts')
    const first = await sessionsApi()
    const pathA = join(sessions, fileA)
    const pathB = join(sessions, fileB)
    writeFileSync(pathA, header(A))
    writeFileSync(pathB, header(B))
    const trashedSides = []
    first.onSessionPurged(async (id, name) => { trashedSides.push([id, name]) })
    await first.deleteSession(pathA)
    ok(!existsSync(pathA) && existsSync(join(yan, 'turn-timing', `${fileA.replace(/\.jsonl$/, '')}.jsonl`)) && existsSync(m.sourcesDir(A)), '删除会话进回收站时旁路数据原样保留，仍可撤销')
    ok(existsSync(join(plans, `${A}.jsonl`)), '任务计划也保留')
    const trashDir = join(yan, 'trash', 'sessions')
    const [name] = readdirSync(trashDir).filter((item) => item.endsWith(fileA))
    const old = `${Date.now() - 8 * 24 * 3600 * 1000}-aaaaaaaa-0-${fileA}`
    renameSync(join(trashDir, name), join(trashDir, old))
    const second = await sessionsApi()
    const purged = []
    second.onSessionPurged(async (id, fileName) => { purged.push([id, fileName]) })
    await second.deleteSession(pathB)
    ok(purged.length === 0, '用户删除操作里只入队，不同步做旁路清理')
    await second.runSessionPurgeQueue()
    ok(purged.length === 1 && purged[0][0] === A && purged[0][1] === fileA, '回收站超过 7 天真正清除后，由后台队列触发旁路清理，并带上原文件名', JSON.stringify(purged))
    await second.runSessionPurgeQueue()
    ok(purged.length === 1, '处理过的队列条目不再重复触发')
    ok(!existsSync(join(trashDir, old)) && readdirSync(trashDir).some((item) => item.endsWith(fileB)), '新删除的会话仍在回收站')

    const idLive = 'sess-live-0009'
    const liveFile = join(sessions, `2026-11-03T00-00-00-000Z_${idLive}.jsonl`)
    writeFileSync(liveFile, header(idLive))
    const third = await sessionsApi()
    const skipped = []
    third.onSessionPurged(async (id) => { skipped.push(id) })
    writeFileSync(join(yan, 'trash', 'session-purge-queue.json'), JSON.stringify([{ sessionId: idLive, fileName: 'x.jsonl' }, { sessionId: 'sess-gone-0010', fileName: 'y.jsonl' }]))
    await third.runSessionPurgeQueue()
    ok(skipped.join() === 'sess-gone-0010', '有存活会话仍在使用同一个 id 时不清理它的旁路数据，条目直接丢弃', skipped.join())
    ok(JSON.parse(readFileSync(join(yan, 'trash', 'session-purge-queue.json'), 'utf8')).length === 0, '处理完的队列清空')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
