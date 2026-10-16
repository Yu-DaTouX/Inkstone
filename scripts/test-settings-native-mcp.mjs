import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { runAppearanceTests } from './test-appearance.mjs'

await build({ entryPoints: ['src/renderer/src/state/push-consumers.ts', 'src/renderer/src/lib/native-mcp-status.ts'], outdir: 'out/test/settings-native-mcp', bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { consumeQuestionPush } = await import(pathToFileURL('out/test/settings-native-mcp/state/push-consumers.js'))
const { isNativeMcpStatus } = await import(pathToFileURL('out/test/settings-native-mcp/lib/native-mcp-status.js'))
let count = 0
const check = (value, name) => { assert.ok(value, name); count++; console.log(`PASS ${name}`) }
for (const text of ['No MCP servers configured. Add them to mcp.json.', 'weather: connected, 3 tools (codemode)', 'weather: needs sign-in, run /mcp login weather (direct)', 'config error: invalid server', 'overridden: weather', 'weather: disconnected, reconnects on next call (codemode)']) {
  check(isNativeMcpStatus(text), `识别原生状态：${text}`)
}
check(!isNativeMcpStatus('An unrelated extension loaded'), '不吞其它扩展通知')
function deliver({ pending = true, sessionId = 's1', text = 'weather: connected, 3 tools (codemode)', startupPhase = true } = {}) {
  let state = { nativeMcpStatus: { sessionId: 's1', pending, text: '' }, notices: [], logs: [], startupPhase, settings: null }
  const ctx = { get: () => state, set: patch => { state = { ...state, ...patch } }, alertAttention() {}, pushNotice: (list, type, text, id) => [...list, { type, text, id }] }
  consumeQuestionPush({ ch: 'notify', runtime: { sessionId }, payload: { message: text, notifyType: 'info', id: 'n1' } }, state, ctx)
  return state
}
const response = deliver()
check(response.nativeMcpStatus.text.startsWith('weather:') && !response.nativeMcpStatus.pending, '启动期也将主动查询响应送到设置页')
check(response.notices.length === 0 && response.logs.length === 0, '主动查询不重复弹通知或降级日志')
check(deliver({ sessionId: 's2' }).nativeMcpStatus.pending, '其它会话不能覆盖查询结果')
check(deliver({ text: 'Unrelated notification' }).nativeMcpStatus.pending, '其它通知不能结束查询')
check(deliver({ pending: false, startupPhase: false }).notices.length === 1, '没有待查询时保留原通知行为')
check(deliver().nativeMcpStatus.text === deliver().nativeMcpStatus.text, '重复查询同一状态仍能显示，不受通知去重影响')
await runAppearanceTests(check)
console.log(`${count} checks passed`)
