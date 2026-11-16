#!/usr/bin/env node
import './lib/test-isolate.mjs'
import { readFileSync } from 'node:fs'
import { runSuite } from './lib/test-suite.mjs'

const storage = new Map()
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) }
globalThis.document = { documentElement: { lang: 'zh-CN' }, addEventListener() {}, querySelector: () => null, hasFocus: () => true }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { href: 'http://localhost/' }, yan: {} }

const DEFINE = { define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' } }
const running = { id: 'c1', status: 'running', reason: 'manual', startedAt: 1 }
const done = { ...running, status: 'completed', endedAt: 2 }

await runSuite(import.meta.url, async (ok, compile) => {
  const keys = await compile('src/renderer/src/features/composer/composer-keys.ts')
  ok(keys.holdsSendDuringCompaction({ isCompacting: true }), '会话标记为压缩中时暂存')
  ok(keys.holdsSendDuringCompaction({ isCompacting: false, compaction: running }), '压缩已开始、状态还没刷新到 isCompacting 时也暂存')
  ok(!keys.holdsSendDuringCompaction({ isCompacting: false, lastCompaction: done }), '压缩结束后不再暂存')
  ok(!keys.holdsSendDuringCompaction(null), '没有会话时不暂存')

  const scope = await compile('src/renderer/src/features/session/turn-scope.ts', DEFINE)
  const lines = await compile('src/renderer/src/features/session/turn-lines.ts', DEFINE)
  const sub = scope.subagentTurnScope('sub-1', 'C:/wt/sub-1')
  ok(sub.session === null, '子代理作用域不带主会话状态，压缩标记取不到主会话的压缩')
  ok(lines.compactionLineModel(sub.session?.compaction, sub.session?.lastCompaction) === null, '子代理面板不显示压缩行')
  ok(sub.messages.length === 0 && scope.subagentTurnScope('sub-2', 'C:/x').messages === sub.messages, '消息列表是固定的空数组，子代理增量不会让作用域变化')
  ok(sub.cwd === 'C:/wt/sub-1', '改动路径按子代理自己的目录算')
  ok(lines.branchOriginOf([{ id: 'main', path: 'C:/s/main.jsonl', branchOrigin: '来自主会话' }], sub.view) === null, '不显示主会话的分支来源')

  const pane = readFileSync('src/renderer/src/features/session/SubagentTranscriptPane.tsx', 'utf8')
  const open = pane.indexOf('<TurnScopeContext.Provider value={turnScope}>')
  const close = pane.indexOf('</TurnScopeContext.Provider>')
  const view = pane.indexOf('<TurnView ')
  ok(open > 0 && open < view && view < close && pane.includes('subagentTurnScope(run.id, run.cwd)'), '子代理面板的轮次包在自己的作用域里')
  const adapter = readFileSync('src/renderer/src/t3/adapters/composer-submit.ts', 'utf8')
  ok(/const held = holdsSendDuringCompaction\(useStore\.getState\(\)\.session\)\s*\n\s*if \(held\) useStore\.getState\(\)\.holdSend\(/.test(adapter), 'v3 输入框发送前现读会话状态，压缩中走暂存')

  const { useStore, pendingSendsForView } = await compile('src/renderer/src/state/store.ts', DEFINE)
  const get = useStore.getState
  const session = { sessionId: 'A', sessionFile: 'C:/fixture/A.jsonl', cwd: 'C:/fixture', isAgentRunning: false, isCompacting: true, compaction: running }
  useStore.setState({ session, peekedPath: null, peekedSessionId: null, runners: [{ id: 'run-A', runId: 'run-A', sessionId: 'A', sessionFile: 'C:/fixture/A.jsonl', generation: 1, isActive: true }], activeRunnerId: 'run-A' })
  const sent = []
  useStore.setState({ send: async (text, images, mode) => { sent.push([text, mode]); return true } })
  get().holdSend('压缩时打的字')
  get().holdSend('第二条')
  ok(pendingSendsForView(get()).length === 2, '压缩期间的两条消息进入待发队列')
  get().applyPush({ ch: 'state', payload: { ...session, compaction: undefined, lastCompaction: done } })
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(JSON.stringify(sent) === JSON.stringify([['压缩时打的字', 'followUp'], ['第二条', 'followUp']]), '压缩结束的那次推送就按顺序排队发出，即使 isCompacting 还没刷新', JSON.stringify(sent))
  ok(pendingSendsForView(get()).length === 0, '发出后待发队列清空')
})
