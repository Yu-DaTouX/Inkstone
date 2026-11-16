import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

await runSuite(import.meta.url, async (ok, compile) => {
  const root = mkdtempSync(join(tmpdir(), 'inkstone-forward-compat-'))
  const saved = { YAN_DATA_DIR: process.env.YAN_DATA_DIR }
  try {
    const yan = join(root, 'yan')
    mkdirSync(yan, { recursive: true })
    process.env.YAN_DATA_DIR = yan
    const layout = await compile('src/main/session-layout.ts')
    const { ApprovalLogStore, QuestionLogStore, setPersistedNoticeSink } = await compile(null, { stdin: { contents: "export { ApprovalLogStore } from './src/main/approval-log.ts'; export { QuestionLogStore } from './src/main/question-log.ts'; export { setPersistedNoticeSink } from './src/main/persisted-notice.ts'", resolveDir: process.cwd() } })
    const notices = []
    setPersistedNoticeSink((message) => notices.push(message))
    const read = (file) => JSON.parse(readFileSync(file, 'utf8'))

    const layoutFile = join(yan, 'session-layout.json')
    const future = { version: 1, syncCursor: 'abc', entries: [{ sessionId: 'sess-1', cwd: 'C:/p', scope: 'global', createdAt: 1, updatedAt: 1, moveHistory: [{ at: 5, fromScope: 'global', toScope: 'global', reason: 'drag' }], labelColor: 'teal', pinnedOrder: 3 }] }
    writeFileSync(layoutFile, JSON.stringify(future))
    await layout.setSessionFlags({ sessionId: 'sess-1', cwd: 'C:/p' }, { pinned: true })
    await layout.rememberSession({ sessionId: 'sess-2', cwd: 'C:/q' })
    let doc = read(layoutFile)
    const first = doc.entries.find((item) => item.sessionId === 'sess-1')
    ok(doc.syncCursor === 'abc', '会话布局：未知的顶层字段写回时保留')
    ok(first.labelColor === 'teal' && first.pinnedOrder === 3 && first.pinned === true, '会话布局：未知的条目字段保留，已知字段照常更新')
    ok(first.moveHistory[0].reason === 'drag', '会话布局：未知的迁移记录字段保留')
    ok(doc.entries.length === 2, '会话布局：新增条目照常写入')

    writeFileSync(layoutFile, JSON.stringify({ version: 2, entries: [{ sessionId: 'sess-1', cwd: 'C:/p', newShape: true }] }))
    const raw = readFileSync(layoutFile, 'utf8')
    const layoutFresh = await compile('src/main/session-layout.ts')
    await ok(await layoutFresh.rememberSession({ sessionId: 'sess-3', cwd: 'C:/r' }).then(() => false, () => true), '会话布局：新版本文档拒绝覆盖')
    ok(readFileSync(layoutFile, 'utf8') === raw && !readdirSync(yan).some((name) => name.includes('.corrupt')), '会话布局：新版本文件逐字节不变，也没有被当作损坏')

    const approvalFile = join(root, 'approval-log.json')
    const receipt = { id: 'r1', toolCallId: 't1', kind: 'danger', tool: 'bash', title: 'rm', choice: 'once', at: 1700000000000, source: 'plugin-x' }
    writeFileSync(approvalFile, JSON.stringify({ version: 1, cursor: 9, sessions: { 'sess-1': [receipt] } }))
    const approvals = new ApprovalLogStore(() => approvalFile)
    const review = { toolCallId: 't2', tool: 'bash', title: 'ls', allowed: true }
    ok(approvals.recordReview('sess-1', review, 1700000001000) !== null, '审批记录：同版本文档正常追加')
    doc = read(approvalFile)
    ok(doc.cursor === 9 && doc.sessions['sess-1'][0].source === 'plugin-x' && doc.sessions['sess-1'].length === 2, '审批记录：未知的顶层与条目字段保留')

    const approvalRaw = JSON.stringify({ version: 2, sessions: { 'sess-1': [{ id: 'z', anything: true }] } })
    writeFileSync(approvalFile, approvalRaw)
    const approvalsNew = new ApprovalLogStore(() => approvalFile)
    ok(approvalsNew.list('sess-1').length === 0, '审批记录：读不懂的新版本文档按无记录显示')
    ok(approvalsNew.recordReview('sess-1', review, 1700000002000) === null, '审批记录：新版本文档不写入新记录')
    ok(notices.length === 1 && /审批记录/.test(notices[0]), '审批记录：停止写入时向界面发出一次提示', JSON.stringify(notices))
    approvalsNew.recordReview('sess-1', review, 1700000002500)
    ok(notices.length === 1, '同一进程内不重复提示')
    ok(readFileSync(approvalFile, 'utf8') === approvalRaw && !readdirSync(root).some((name) => name.includes('approval-log.json.')), '审批记录：新版本文件逐字节不变，无损坏副本')
    ok(approvalsNew.forget('sess-1') === false && readFileSync(approvalFile, 'utf8') === approvalRaw, '审批记录：新版本文档也不被清理改动')
    for (const odd of [0, 1.5, -1]) {
      writeFileSync(approvalFile, JSON.stringify({ version: odd, sessions: {} }))
      const oddStore = new ApprovalLogStore(() => approvalFile)
      ok(oddStore.recordReview('sess-1', review, 1700000002800) !== null && JSON.parse(readFileSync(approvalFile, 'utf8')).version === 1, `审批记录：version=${odd} 不是「新版本」，按损坏处理（留副本）后继续保存`)
    }
    writeFileSync(approvalFile, '{ not json')
    const approvalsBroken = new ApprovalLogStore(() => approvalFile)
    ok(approvalsBroken.recordReview('sess-1', review, 1700000003000) !== null && readdirSync(root).some((name) => name.startsWith('approval-log.json.corrupt-')), '审批记录：真正损坏的文件仍先留副本再重建')

    const questionFile = join(root, 'question-log.json')
    writeFileSync(questionFile, JSON.stringify({ version: 1, extra: ['x'], sessions: { 'sess-1': [{ id: 'q1', question: 'a?', options: [], answer: 'b', at: 1700000000000, askedBy: 'plugin' }] } }))
    const questions = new QuestionLogStore(() => questionFile)
    ok(questions.append('sess-1', { question: 'c?', options: [], answer: null, cancelled: false, at: 1700000001000 })?.length === 2, '提问记录：同版本文档正常追加')
    doc = read(questionFile)
    ok(Array.isArray(doc.extra) && doc.sessions['sess-1'][0].askedBy === 'plugin', '提问记录：未知的顶层与条目字段保留')

    const questionRaw = JSON.stringify({ version: 3, sessions: {} })
    writeFileSync(questionFile, questionRaw)
    const questionsNew = new QuestionLogStore(() => questionFile)
    ok(questionsNew.append('sess-1', { question: 'd?', options: [], answer: null, cancelled: false, at: 1700000002000 }) === null, '提问记录：新版本文档不写入新记录')
    ok(notices.length === 2 && /提问记录/.test(notices[1]), '提问记录：停止写入时向界面发出提示')
    ok(readFileSync(questionFile, 'utf8') === questionRaw && !readdirSync(root).some((name) => name.startsWith('question-log.json.')), '提问记录：新版本文件逐字节不变，无损坏副本')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})
