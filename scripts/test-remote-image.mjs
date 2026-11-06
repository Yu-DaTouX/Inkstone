import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createServer } from 'node:http'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-remote-image-'))
try {
  const outfile = join(dir, 'remote-image.mjs')
  await build({ entryPoints: ['src/main/remote-image.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { fetchRemoteImage, createPinnedFetch, REMOTE_IMAGE_MAX_BYTES } = await import(pathToFileURL(outfile).href)

  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const respond = (status, headers, body = Buffer.alloc(0)) => new Response(status >= 300 && status < 400 ? null : body, { status, headers })
  const gate = (decision, asked = []) => ({
    peek: () => decision,
    check: async (sessionId, url) => {
      asked.push([sessionId, url])
      return decision === 'ask' ? 'allow' : decision
    }
  })
  const publicHost = async () => false
  const deps = (decision, fetchImpl, extra = {}) => ({ gate: gate(decision, extra.asked), fetchImpl, isPrivate: extra.isPrivate ?? publicHost })
  let fetched = 0
  const okFetch = async () => {
    fetched++
    return respond(200, { 'content-type': 'image/png' }, png)
  }

  let r = await fetchRemoteImage(deps('ask', okFetch), 's1', 'https://img.example.com/a.png', false)
  assert.deepEqual(r, { ok: false, code: 'needs-consent' })
  assert.equal(fetched, 0, 'no network before consent')

  const asked = []
  r = await fetchRemoteImage(deps('ask', okFetch, { asked }), 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.ok, true)
  assert.equal(r.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
  assert.deepEqual(asked, [['s1', 'https://img.example.com/a.png']], 'prompt goes through the site gate')

  r = await fetchRemoteImage(deps('deny', okFetch), 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.code, 'denied')

  r = await fetchRemoteImage(deps('allow', okFetch), 's1', 'file:///C:/secret.png', true)
  assert.equal(r.code, 'bad-url')

  r = await fetchRemoteImage(deps('allow', okFetch), 's1', 'http://127.0.0.1/a.png', true)
  assert.equal(r.code, 'private-host')
  r = await fetchRemoteImage(deps('allow', okFetch, { isPrivate: async () => true }), 's1', 'https://rebind.example.com/a.png', true)
  assert.equal(r.code, 'private-host', 'DNS answers pointing inside are refused')

  const redirectInside = async (url) => url.includes('outside') ? respond(302, { location: 'http://192.168.1.2/x.png' }) : okFetch()
  r = await fetchRemoteImage(deps('allow', redirectInside), 's1', 'https://outside.example.com/a.png', true)
  assert.equal(r.code, 'private-host', 'redirects are re-checked')

  r = await fetchRemoteImage(deps('allow', async () => respond(200, { 'content-type': 'text/html' }, Buffer.from('<html>'))), 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.code, 'not-image')

  r = await fetchRemoteImage(deps('allow', async () => respond(200, { 'content-type': 'image/png', 'content-length': String(REMOTE_IMAGE_MAX_BYTES + 1) }, png)), 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.code, 'too-large')

  r = await fetchRemoteImage(deps('allow', async () => respond(404, { 'content-type': 'image/png' })), 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.code, 'http')

  r = await fetchRemoteImage({ gate: null, fetchImpl: okFetch, isPrivate: publicHost }, 's1', 'https://img.example.com/a.png', true)
  assert.equal(r.code, 'denied')

  const hits = []
  const local = createServer((req, res) => {
    hits.push(req.url)
    if (req.url === '/redirect') { res.writeHead(302, { location: '/a.png' }); res.end(); return }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
  })
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve))
  const port = local.address().port
  try {
    const rebinding = createPinnedFetch(async () => [{ address: '127.0.0.1', family: 4 }])
    await assert.rejects(rebinding(`http://rebind.example.test:${port}/a.png`), /内网/, 'DNS 重绑定：名字解析到本机时连接前被拒绝')
    const mixed = createPinnedFetch(async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])
    await assert.rejects(mixed(`http://mixed.example.test:${port}/a.png`), /内网/, '多条解析里混入内网地址整体拒绝')
    await assert.rejects(createPinnedFetch()(`http://127.0.0.1:${port}/a.png`), /内网/, 'IP 字面量内网地址被拒绝')
    await assert.rejects(createPinnedFetch()(`http://[::ffff:7f00:1]:${port}/a.png`), /内网/, 'IPv4 映射的 IPv6 字面量被拒绝')
    assert.equal(hits.length, 0, '被拒绝的请求从未到达服务')
    const allowed = createPinnedFetch(async () => [{ address: '127.0.0.1', family: 4 }], () => false)
    const response = await allowed(`http://pinned.example.test:${port}/a.png`, { headers: { accept: 'image/*' } })
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png, '固定地址连接后能读到响应体')
    const redirected = await allowed(`http://pinned.example.test:${port}/redirect`, { redirect: 'manual' })
    assert.equal(redirected.status, 302)
    assert.equal(redirected.headers.get('location'), '/a.png', '重定向原样交给上层逐跳复查')
    r = await fetchRemoteImage({ gate: gate('allow'), fetchImpl: createPinnedFetch(async () => [{ address: '127.0.0.1', family: 4 }]), isPrivate: publicHost }, 's1', `http://rebind.example.test:${port}/a.png`, true)
    assert.equal(r.ok, false, '名字通过预检但连接时解析成内网：整体失败')
    assert.equal(r.code, 'network')
  } finally {
    local.close()
  }

  console.log('remote-image: gate / private host / redirect / type / size checks passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
