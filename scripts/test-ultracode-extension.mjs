import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const userEntry = () => ({ type: 'message', message: { role: 'user', content: 'hi' } })
const marker = (mode) => ({ type: 'custom_message', customType: 'yan-ultracode', details: { mode } })

export async function runUltracodeExtensionTests(ok, mod) {
  const { needsReviewGate, GATE_LIMIT, chooseReminder, lastAnnouncement, hasKeyword, isPrimaryRunner, readEnabled, SPARSE_EVERY, ULTRACODE_STATE_FILE, default: extension } = mod

  ok(hasKeyword('/ultracode 审计全部接口'), '消息开头的 /ultracode 触发')
  ok(hasKeyword('  /ULTRACODE\n修一下'), '前导空白与大小写不影响')
  ok(!hasKeyword('ultracode: 审计全部接口'), '不带斜杠不触发')
  ok(!hasKeyword('请用 /ultracode 处理'), '不在开头不触发')
  ok(!hasKeyword('/ultracoder 修一下'), '更长的命令名不触发')
  ok(!hasKeyword(undefined), '没有文本不触发')

  ok(isPrimaryRunner({ YAN_RUNNER_ID: 'primary' }), 'primary 是主会话')
  ok(isPrimaryRunner({ YAN_RUNNER_ID: 's1', YAN_SESSION_ID: 's1' }), '运行 ID 等于会话 ID 时是主会话')
  ok(!isPrimaryRunner({ YAN_RUNNER_ID: 'sub-1', YAN_SESSION_ID: 's1' }), 'fork 子代理不加载深度模式')

  ok(lastAnnouncement([]).mode === 'off', '没有记录时视为关闭')
  const afterOn = lastAnnouncement([userEntry(), marker('on'), userEntry(), userEntry()])
  ok(afterOn.mode === 'on' && afterOn.turnsSince === 2, '统计开启后的用户轮数', JSON.stringify(afterOn))
  ok(lastAnnouncement([userEntry(), marker('on'), userEntry(), marker('keyword')]).mode === 'on', '单轮关键词记录不改变开关状态')
  ok(lastAnnouncement([marker('on'), { type: 'compaction' }, userEntry()]).mode === 'off', '压缩后视为需要重新发完整提醒')

  const pick = (enabled, keyword, last) => chooseReminder({ enabled, keyword, last })?.mode
  ok(pick(true, false, { mode: 'off', turnsSince: 0 }) === 'on', '刚开启发完整提醒')
  ok(pick(true, false, { mode: 'on', turnsSince: 1 }) === undefined, '开启后的普通轮次不重复提醒')
  ok(pick(true, false, { mode: 'sparse', turnsSince: SPARSE_EVERY }) === 'sparse', `每 ${SPARSE_EVERY} 轮补一次简短提醒`)
  ok(pick(false, false, { mode: 'on', turnsSince: 3 }) === 'off', '关闭时发一次退出提醒')
  ok(pick(false, false, { mode: 'off', turnsSince: 3 }) === undefined, '一直关闭时不提醒')
  ok(pick(false, true, { mode: 'off', turnsSince: 0 }) === 'keyword', '关闭时关键词只对这一轮生效')
  ok(pick(true, true, { mode: 'on', turnsSince: 1 }) === undefined, '已开启时关键词不额外提醒')
  const exitWithKeyword = chooseReminder({ enabled: false, keyword: true, last: { mode: 'on', turnsSince: 1 } })
  ok(exitWithKeyword?.mode === 'off' && /ultracode/.test(exitWithKeyword.text), '关闭当轮带关键词时同时说明本轮仍按深度处理')

  const user = (text) => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text }] } })
  const call = (name, args) => ({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }] } })
  const gateMark = { type: 'custom_message', customType: 'yan-ultracode-gate' }
  const notice = user('<subagent-notification id="a1" status="done">\n结果\n这是宿主自动发出的通知')
  const edit = call('edit', { path: 'a.ts' })
  const review = call('bash', { command: 'yan subagent start --read-only --task 复核' })
  ok(!needsReviewGate([user('看看')]).needed, '没改文件不拦')
  ok(needsReviewGate([user('改'), edit]).needed, '改了文件且没派复核时拦一次')
  ok(!needsReviewGate([user('改'), edit, review]).needed, '改完派了子 Agent 就放行')
  ok(needsReviewGate([user('改'), review, edit]).needed, '复核之后又改了文件要再拦')
  ok(!needsReviewGate([user('改'), call('codemode', { code: 'await tools.bash({command:"yan subagent start --request-file r.json"})' }), edit, call('codemode', { code: 'tools.bash({command:\'yan subagent start --task x\'})' })]).needed, 'codemode 里派子 Agent 也算')
  ok(needsReviewGate([user('改'), edit, notice, edit]).needed, '子 Agent 通知不算新的用户请求')
  ok(needsReviewGate([user('/ultracode 改'), edit, notice]).prompt.startsWith('/ultracode'), '取到真正的用户请求文本')
  ok(!needsReviewGate([user('改'), edit, ...Array(GATE_LIMIT).fill(gateMark)]).needed, `每条请求最多拦 ${GATE_LIMIT} 次`)
  ok(needsReviewGate([user('改'), edit, gateMark, gateMark, user('再改'), edit]).needed, '新请求重新计数')

  const dir = mkdtempSync(join(tmpdir(), 'yan-ultracode-'))
  const prevData = process.env.YAN_DATA_DIR
  const prevRunner = process.env.YAN_RUNNER_ID
  const prevSession = process.env.YAN_SESSION_ID
  try {
    const file = join(dir, ULTRACODE_STATE_FILE)
    writeFileSync(file, JSON.stringify({ s1: true }), 'utf8')
    ok(readEnabled(file, 's1') && !readEnabled(file, 's2') && !readEnabled(file, undefined), '按会话读取开关')
    ok(!readEnabled(join(dir, 'missing.json'), 's1'), '状态文件不存在时视为关闭')

    process.env.YAN_DATA_DIR = dir
    process.env.YAN_RUNNER_ID = 'primary'
    delete process.env.YAN_SESSION_ID
    const handlers = {}
    const sent = []
    extension({ on: (name, fn) => (handlers[name] = fn), sendMessage: (message, options) => sent.push({ message, options }) })
    ok(typeof handlers.before_agent_start === 'function', '扩展注册了 before_agent_start')
    const ctx = (sessionId, branch) => ({ sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } })
    const first = handlers.before_agent_start({ messageType: 'user', prompt: '改一下' }, ctx('s1', []))
    ok(first?.message?.customType === 'yan-ultracode' && first.message.display === false && first.message.details?.mode === 'on', '开启的会话注入隐藏的完整提醒', JSON.stringify(first))
    ok(handlers.before_agent_start({ messageType: 'user', prompt: '改一下' }, ctx('s2', [])) === undefined, '未开启的会话不注入')
    ok(handlers.before_agent_start({ messageType: 'custom', message: {} }, ctx('s1', [])) === undefined, '自定义消息触发的轮次不注入')
    handlers.agent_before_settle({ outcome: 'completed' }, ctx('s1', [user('改'), edit]))
    ok(sent.length === 1 && sent[0].message.customType === 'yan-ultracode-gate' && sent[0].message.display === false && sent[0].options?.deliverAs === 'followUp', '开启时收尾前追加隐藏的复核提醒', JSON.stringify(sent))
    handlers.agent_before_settle({ outcome: 'completed' }, ctx('s2', [user('改'), edit]))
    ok(sent.length === 1, '未开启的会话不拦')
    handlers.agent_before_settle({ outcome: 'completed' }, ctx('s2', [user('/ultracode 改'), edit]))
    ok(sent.length === 2, '单次 /ultracode 的请求也拦')
    handlers.agent_before_settle({ outcome: 'aborted' }, ctx('s1', [user('改'), edit]))
    ok(sent.length === 2, '中止或出错时不拦')

    process.env.YAN_RUNNER_ID = 'sub-1'
    process.env.YAN_SESSION_ID = 's1'
    const forkHandlers = {}
    extension({ on: (name, fn) => (forkHandlers[name] = fn) })
    ok(!forkHandlers.before_agent_start, 'fork 子代理里扩展不注册')
  } finally {
    if (prevData === undefined) delete process.env.YAN_DATA_DIR
    else process.env.YAN_DATA_DIR = prevData
    if (prevRunner === undefined) delete process.env.YAN_RUNNER_ID
    else process.env.YAN_RUNNER_ID = prevRunner
    if (prevSession === undefined) delete process.env.YAN_SESSION_ID
    else process.env.YAN_SESSION_ID = prevSession
    rmSync(dir, { recursive: true, force: true })
  }
}
