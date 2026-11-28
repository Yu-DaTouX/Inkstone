import './lib/test-isolate.mjs'
import { webcrypto } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const load = async (contents, resolveDir) => {
  const result = await build({ stdin: { contents, resolveDir, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const VECTOR = {
  hostRaw: '049aa0c8cf2c7d1a3aadf3cc1a9ae6ddb166d942d6725546f18a94a312ba297d7e0603f5365ac752648d1e8702cbd60ac61171c171b9d9f9686941227ff77083a9',
  send: 'a116483d01ad14f80e59f94606067787dd3b8c40ff0550ca355d8e7089e3b9f4',
  recv: '9846ed06d53ca2e7514b99fc4e48d9dc0766682e8a26e0dca1e255d36e02a189',
  text: JSON.stringify({ t: 'auth', name: '手机 😀' }),
  frame: 'x.AAAAAAAAAADqNLmgrI9avQbNcbdn7gQlkoerXtXO8vgh8eQEEWFZBox7expX3QVhq1bVF6QcyJbM'
}

await runSuite(import.meta.url, async (ok) => {
  const D = await load(`export * from './src/main/relay-bridge/crypto'; export * from './src/shared/relay-crypto'`, process.cwd())
  const sides = [['电脑', D.nodeRelayPrimitives]]
  if (existsSync(join('mobile', 'node_modules', '@noble', 'curves'))) {
    const M = await load(`export { mobileRelayPrimitives } from './src/api/relay'`, join(process.cwd(), 'mobile'))
    sides.push(['手机', M.mobileRelayPrimitives])
  } else {
    console.log('- 手机端原语跳过：未安装 mobile 依赖')
  }

  const hex = (bytes) => Buffer.from(bytes).toString('hex')
  const secret = (n) => new Uint8Array(32).map((_, i) => (i * 13 + n) & 255 || 1)
  const s = { client: secret(1), clientEph: secret(2), host: secret(3), hostEph: secret(4) }

  for (const [name, P] of sides) {
    ok(hex(P.publicKey(s.host)) === VECTOR.hostRaw, `${name}：公钥向量一致`)
    const client = D.relayClientKeys(P, { clientSecret: s.client, ephSecret: s.clientEph, hostRaw: P.publicKey(s.host), hostEphRaw: P.publicKey(s.hostEph) })
    const server = D.relayServerKeys(P, { hostSecret: s.host, ephSecret: s.hostEph, clientRaw: P.publicKey(s.client), clientEphRaw: P.publicKey(s.clientEph) })
    ok(hex(client.send) === VECTOR.send && hex(client.recv) === VECTOR.recv, `${name}：客户端密钥向量一致`)
    ok(hex(server.send) === VECTOR.recv && hex(server.recv) === VECTOR.send, `${name}：电脑端密钥与客户端互为收发`)
    const codec = D.relayFrameCodec(P)
    ok(codec.seal(client.send, 0, VECTOR.text) === VECTOR.frame, `${name}：加密帧向量一致`)
    ok(codec.open(server.recv, VECTOR.frame, 0) === VECTOR.text, `${name}：能解开向量帧`)
    const rejects = (fn) => { try { fn(); return false } catch { return true } }
    ok(rejects(() => codec.open(server.recv, VECTOR.frame, 1)), `${name}：计数不对（重放）拒绝`)
    const bytes = P.fromB64u(VECTOR.frame.slice(2))
    bytes[bytes.length - 1] ^= 1
    ok(rejects(() => codec.open(server.recv, `x.${P.toB64u(bytes)}`, 0)), `${name}：篡改帧拒绝`)
    ok(rejects(() => D.relayClientKeys(P, { clientSecret: s.client, ephSecret: s.clientEph, hostRaw: new Uint8Array(33), hostEphRaw: P.publicKey(s.hostEph) })), `${name}：非 65 字节公钥拒绝`)
  }

  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey)
  const raw = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))
  const imported = await D.importKeyPair(jwk)
  ok(hex(imported.raw) === hex(raw), '旧版 webcrypto 存下的电脑密钥照常读入')
  const again = await D.importKeyPair(await D.exportKeyPair(imported))
  ok(hex(again.raw) === hex(raw), '导出再导入不变')

  const host = await D.generateKeyPair()
  const hostEph = await D.generateKeyPair()
  const phone = await D.generateKeyPair()
  const phoneEph = await D.generateKeyPair()
  const a = await D.clientSession({ clientStatic: phone, clientEph: phoneEph, serverStaticRaw: host.raw, serverEphRaw: hostEph.raw })
  const b = await D.serverSession({ serverStatic: host, serverEph: hostEph, clientStaticRaw: phone.raw, clientEphRaw: phoneEph.raw })
  const big = 'x'.repeat(2 * 1024 * 1024)
  ok((await b.open(await a.seal({ big }))).big === big, '随机密钥握手后 2 MiB 帧往返')
  let rejected = false
  await b.open('x.AAAA').catch(() => { rejected = true })
  ok(rejected, '坏帧以 Promise 拒绝而不是同步抛出')
})
