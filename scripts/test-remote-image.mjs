import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'inkstone-remote-image-'))
try {
  const outfile = join(dir, 'remote-image.mjs')
  await build({ entryPoints: ['src/main/remote-image.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { fetchRemoteImage, REMOTE_IMAGE_MAX_BYTES } = await import(pathToFileURL(outfile).href)

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

  console.log('remote-image: gate / private host / redirect / type / size checks passed')
} finally {
  await rm(dir, { recursive: true, force: true })
}
