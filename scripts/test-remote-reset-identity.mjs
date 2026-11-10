import assert from 'node:assert/strict'
import { build } from '../node_modules/esbuild/lib/main.js'

const result = await build({ entryPoints: ['src/main/ipc/remote-ipc.ts'], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { registerRemoteIpc } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)

let pass = 0
function ok(condition, label, detail) {
  assert.ok(condition, `${label}${detail === undefined ? '' : ` ← ${JSON.stringify(detail)}`}`)
  pass += 1
  console.log(`  ✓ ${label}`)
}

const handlers = {}
registerRemoteIpc({ handle: (channel, fn) => { handlers[channel] = fn } }, {
  access: () => access,
  ensureStarted: async () => {},
  saveSettings: async (remote) => ({ remoteAccess: remote })
})

let calls = 0
let failure
const access = {
  resetIdentity: async () => {
    calls += 1
    if (failure) throw new Error(failure)
    return { revokedDevices: 3, hostFingerprint: 'ABCD-EF01-2345-6789' }
  }
}

console.log('▌整体身份重置 IPC：本地入口透传结果')
{
  const reset = await handlers['yan:remote:resetIdentity']()
  ok(reset.ok === true && reset.revokedDevices === 3 && reset.hostFingerprint === 'ABCD-EF01-2345-6789', '返回撤销设备数与新指纹', reset)
  ok(calls === 1, '调用 RemoteAccess.resetIdentity 一次')
  failure = 'disk full'
  const failed = await handlers['yan:remote:resetIdentity']()
  ok(failed.ok === false && /disk full/.test(failed.error ?? ''), '写盘失败返回失败与原因', failed)
}

console.log(`整体身份重置 IPC：${pass} 项通过`)
