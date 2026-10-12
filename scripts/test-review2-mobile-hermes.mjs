import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-mobile-hermes-'))
try {
  const bundled = join(temp, 'relay.mjs')
  await build({ entryPoints: ['mobile/src/api/relay.ts'], outfile: bundled, bundle: true, format: 'esm', platform: 'node', packages: 'bundle', logLevel: 'silent' })
  const relay = await import(pathToFileURL(bundled).href)
  assert.equal(relay.bytesToUtf8(new Uint8Array([0xf8, 0xff])), '\ufffd\ufffd')
  const tunnel = new relay.RelayTunnel({ join: 'wss://example.invalid/v1/join/abcdefghij', hostKey: 'x', clientKey: 'x' })
  let rejected
  tunnel.pending.set('m1', { reject: error => { rejected = error }, resolve() {}, chunks: [], stream: false })
  tunnel.frame({ t: 'res', id: 'm1', status: 200, body: '!' })
  assert.match(rejected?.message ?? '', /base64/)
  assert.equal(tunnel.pending.size, 0)
  assert.equal(tunnel.ws, null, 'a malformed response frame must not tear down the tunnel')
  const OriginalWebSocket = globalThis.WebSocket
  let constructions = 0
  globalThis.WebSocket = class { constructor() { constructions++; throw new Error('fixture sync failure') } }
  const retryable = new relay.RelayTunnel({ join: 'wss://example.invalid/v1/join/abcdefghij', hostKey: relay.toB64u(new Uint8Array(65)), clientKey: relay.newClientKey() })
  await assert.rejects(retryable.connect())
  assert.equal(retryable.ready, null, 'synchronous connect failure must clear cached ready promise')
  await assert.rejects(retryable.connect())
  assert.equal(constructions, 2, 'a later connect must attempt a fresh socket')
  globalThis.WebSocket = OriginalWebSocket
} finally {
  await rm(temp, { recursive: true, force: true })
}

const python = String.raw`
import sys
sys.path.insert(0, 'integrations/hermes-inkstone')
from client import Client, ConfigurationError, normalize_url
from http.client import HTTPException

for url in ('http://example.com:37892', 'http://192.0.2.4:37892'):
    try: normalize_url(url)
    except ConfigurationError: pass
    else: raise AssertionError('non-loopback HTTP was accepted')
assert normalize_url('http://127.0.0.1:37892').startswith('http://')
assert normalize_url('https://example.com').startswith('https://')
client = Client('http://127.0.0.1:37892', 'token')
class Broken:
    def open(self, *args, **kwargs): raise HTTPException('peer closed')
client.opener = Broken()
result = client.request('POST', '/test', {})
assert result['code'] == 'connection_failed' and result['outcomeUnknown'] is True
`
const result = spawnSync('python', ['-c', python], { encoding: 'utf8' })
assert.equal(result.status, 0, result.stderr || result.stdout)
console.log('review2 mobile-hermes isolated behavior checks: 6 passed')
