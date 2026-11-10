import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

const result = await build({ entryPoints: ['src/main/ui-requests.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { UiRequests } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const pushed = []
const written = []
let writeResult = true
let delayedFailure = false
const ui = new UiRequests({
  push: (msg) => pushed.push(msg),
  respondToPi: (res) => {
    written.push(res)
    if (delayedFailure) return new Promise((resolve) => setImmediate(() => resolve(false)))
    return writeResult
  }
})

console.log('▌UI 答复送达链：写入失败保留、成功才移除')
ui.handleUi({ id: 'ext-1', method: 'select', message: '选一个' })
ok(ui.pendingUiRequests().some((item) => item.id === 'ext-1'), '问题进入待答复列表')
writeResult = false
const rejected = await ui.respondUi({ id: 'ext-1', value: 'A' })
ok(rejected.ok === false && rejected.code === 'pi_down', 'RPC 写入不可用时报失败', rejected)
ok(ui.pendingUiRequests().some((item) => item.id === 'ext-1'), '写入失败时问题与答案仍可重试')
ok(!pushed.some((msg) => msg.ch === 'ui-resolved'), '写入失败不广播已解决')

delayedFailure = true
const asyncLost = await ui.respondUi({ id: 'ext-1', value: 'B' })
ok(asyncLost.ok === false && asyncLost.code === 'pi_down', 'write 返回后异步失败也报失败', asyncLost)
ok(ui.pendingUiRequests().some((item) => item.id === 'ext-1'), '异步失败保留问题与答案')
ok(!pushed.some((msg) => msg.ch === 'ui-resolved' && msg.payload.id === 'ext-1'), '异步失败不广播已解决')
delayedFailure = false
writeResult = true
const before = written.length
const delivered = await ui.respondUi({ id: 'ext-1', value: 'A' })
ok(delivered.ok === true && written.length === before + 1, '写入成功才报成功', delivered)
ok(!ui.pendingUiRequests().some((item) => item.id === 'ext-1'), '成功后才移除待答复')
ok(pushed.some((msg) => msg.ch === 'ui-resolved' && msg.payload.id === 'ext-1'), '成功广播已解决')

const unknown = await ui.respondUi({ id: 'yan-question-missing', value: 'x' })
ok(unknown.ok === false && unknown.code === 'not_pending', '未知提问不谎报送达', unknown)

ui.handleUi({ id: 'ext-remote', method: 'select', message: '远程问题' })
delayedFailure = true
const remoteLost = await ui.answerUiRemotely('ext-remote', { value: 'A' })
ok(remoteLost.ok === false && remoteLost.code === 'pi_down', '远程答复异步写失败返回失败码', remoteLost)
ok(ui.pendingUiRequests().some((item) => item.id === 'ext-remote'), '远程答复失败时问题仍在待答复')
ok(!pushed.some((msg) => msg.ch === 'ui-resolved' && msg.payload.id === 'ext-remote'), '远程答复失败不广播已解决')
delayedFailure = false
const remoteOk = await ui.answerUiRemotely('ext-remote', { value: 'A' })
ok(remoteOk.ok === true, '远程答复送达后返回成功')
ok(!ui.pendingUiRequests().some((item) => item.id === 'ext-remote'), '远程答复送达后移除待答复')

const answer = []
globalThis.setTimeout = ((fn, ms) => (answer.push({ fn, ms }), 0))
const pending = ui.requestHostUi({ method: 'input', message: '输入', timeout: 1000 })
const hostId = ui.pendingUiRequests().at(-1).id
const hostDelivered = await ui.respondUi({ id: hostId, value: 'ok' })
ok(hostDelivered.ok === true, '宿主机内提问在本进程内送达')
ok((await pending).value === 'ok', '宿主机内提问拿到答复')

console.log(`UI 答复送达：${pass} 项通过`)
