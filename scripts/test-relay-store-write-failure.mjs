import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-relay-store-'))
const outfile = join(root, 'relay.mjs')
await build({
  stdin: { contents: "export * from './src/main/relay-bridge/index'; export * from './src/main/relay-bridge/store'", resolveDir: process.cwd(), loader: 'ts' },
  outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'error'
})
const { RelayBridge, RelayBridgeStore } = await import(pathToFileURL(outfile).href)

try {
  const dir = join(root, 'data')
  const store = new RelayBridgeStore(dir)
  const file = join(dir, 'relay-bridge.json')
  await store.secret()
  const pair = store.startPairing('phone')
  const paired = await store.authenticate('client-key', '测试手机', pair.code)
  assert.equal(paired.ok, true)
  const id = paired.client.id

  rmSync(file)
  mkdirSync(file)
  await assert.rejects(store.revoke(id), '目标被占用时撤销报错，不假装成功')
  rmSync(file, { recursive: true })

  assert.equal(await store.isActive(id), false, '写盘失败后内存里仍是已撤销')
  const second = store.startPairing('phone')
  const again = await store.authenticate('other-key', '另一台', second.code)
  assert.equal(again.ok, true, '一次写盘失败后还能继续保存')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(saved.clients.find((client) => client.id === id)?.revokedAt, '之后的保存把撤销记录写进磁盘')
  console.log('✓ 写盘失败一次后不再永久失败，撤销记录最终落盘')

  const reopened = new RelayBridgeStore(dir)
  assert.equal(await reopened.isActive(id), false, '重启后设备仍是撤销状态')
  console.log('✓ 重启后撤销仍然有效')

  let closed = 0
  const bridge = {
    store: { revoke: async () => { throw new Error('EBUSY') } },
    sessions: [{ client: { id: 'x' }, close: () => { closed += 1 } }, { client: { id: 'y' }, close: () => { closed += 10 } }]
  }
  await assert.rejects(RelayBridge.prototype.revoke.call(bridge, 'x'), /EBUSY/)
  assert.equal(closed, 1, '写盘失败时也断开被撤销设备的在线连接，其他设备不受影响')
  console.log('✓ 写盘失败时仍断开被撤销设备')
} finally {
  rmSync(root, { recursive: true, force: true })
}
