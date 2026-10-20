import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

async function compile(entry, outfile) {
  await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

function memoryStore(initial = []) {
  let saved = [...initial]
  return {
    get saved() {
      return saved
    },
    store: {
      load: async () => [...saved],
      save: (list) => {
        saved = [...list]
      }
    }
  }
}

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-browser-sites-'))
  try {
    const site = await compile('src/main/preview-site-access.ts', join(dir, 'site.mjs'))

    assert.deepEqual(site.allowedSiteList(['https://example.com', 'https://example.com/', 'ftp://x', 'https://169.254.169.254/']), [
      'https://example.com'
    ])
    assert.deepEqual(site.allowedSiteList(['https://example.com', 'https://example.com']), ['https://example.com'])
    assert.deepEqual(site.allowedSiteList(['http://localhost:5173']), ['http://localhost:5173'])
    assert.deepEqual(site.allowedSiteList(undefined), [])
    const many = Array.from({ length: site.MAX_ALLOWED_SITES + 20 }, (_, index) => `https://s${index}.test`)
    assert.equal(site.allowedSiteList(many).length, site.MAX_ALLOWED_SITES)
    assert.equal(site.siteLabel('https://example.com:8443'), 'example.com:8443')
    assert.equal(site.siteAllowsUrl(['https://example.com'], 'https://www.example.com/x'), true)
    assert.equal(site.siteAllowsUrl(['https://example.com'], 'http://example.com/x'), false)

    assert.deepEqual(site.addAllowedSite([], 'example.com'), { result: 'ok', list: ['https://example.com'], origin: 'https://example.com' })
    assert.equal(site.addAllowedSite([], 'http://localhost:3000/dev').origin, 'http://localhost:3000')
    assert.equal(site.addAllowedSite([], '').result, 'invalid')
    assert.equal(site.addAllowedSite([], 'not a site').result, 'invalid')
    assert.equal(site.addAllowedSite([], 'javascript:alert(1)').result, 'invalid')
    assert.equal(site.addAllowedSite([], 'file:///C:/x.html').result, 'invalid')
    assert.equal(site.addAllowedSite([], 'metadata.google.internal').result, 'blocked')
    assert.equal(site.addAllowedSite([], 'https://example.com/path').result, 'ok')
    assert.equal(site.addAllowedSite(['https://example.com'], 'https://www.example.com/').result, 'exists')
    const full = Array.from({ length: site.MAX_ALLOWED_SITES }, (_, index) => `https://s${index}.test`)
    assert.equal(site.addAllowedSite(full, 'https://extra.test').result, 'unavailable')

    const removed = site.removeAllowedSite(['https://example.com', 'https://other.test'], 'https://example.com/')
    assert.deepEqual(removed, { removed: true, list: ['https://other.test'], origin: 'https://example.com' })
    assert.equal(site.removeAllowedSite(['https://example.com'], 'https://absent.test').removed, false)

    const memory = memoryStore(['https://saved.test'])
    const access = new site.PreviewSiteAccess(memory.store, 3)
    assert.deepEqual(access.sites(), [])
    assert.equal(access.decide('s1', 'https://saved.test/a').decision, 'ask')
    await access.ready()
    assert.deepEqual(access.sites(), ['https://saved.test'])
    assert.equal(access.decide('s1', 'https://saved.test/a').decision, 'allow')

    assert.equal(access.record('s1', 'https://fresh.test/', true), 'allow')
    assert.deepEqual(memory.saved, ['https://saved.test', 'https://fresh.test'])
    assert.equal(access.decide('s2', 'https://fresh.test/x').decision, 'allow')

    assert.equal(access.record('s2', 'https://declined.test/', false), 'deny')
    assert.equal(access.decide('s2', 'https://declined.test/x').decision, 'deny')
    assert.equal(access.decide('s3', 'https://declined.test/x').decision, 'ask')
    assert.equal(access.record('s2', 'https://declined.test/', true), 'deny')
    assert.equal(access.decide('s2', 'https://declined.test/x').decision, 'deny')
    assert.equal(memory.saved.includes('https://declined.test'), false)
    access.forgetSession('s2')
    assert.equal(access.decide('s2', 'https://declined.test/x').decision, 'ask')

    assert.equal(access.add('fourth.test').result, 'ok')
    assert.equal(access.add('fourth.test').result, 'exists')
    assert.equal(access.add('metadata.google.internal').result, 'blocked')
    assert.equal(access.add('fifth.test').result, 'unavailable')
    assert.deepEqual(access.sites(), ['https://saved.test', 'https://fresh.test', 'https://fourth.test'])
    assert.equal(memory.saved.length, 3)
    assert.deepEqual(access.remove('https://fresh.test'), {
      removed: true,
      list: ['https://saved.test', 'https://fourth.test']
    })
    assert.deepEqual(memory.saved, ['https://saved.test', 'https://fourth.test'])
    assert.deepEqual(access.clear(), [])
    assert.deepEqual(memory.saved, [])

    const failing = new site.PreviewSiteAccess({ load: async () => { throw new Error('x') }, save: () => undefined })
    await failing.ready()
    assert.deepEqual(failing.sites(), [])
    assert.equal(failing.record('s1', 'https://example.com', true), 'allow')

    const { createPreviewSiteGate } = await compile('src/main/preview-site-gate.ts', join(dir, 'gate.mjs'))
    const asks = []
    let answer = true
    const memory2 = memoryStore()
    const gate = createPreviewSiteGate({
      confirm: async (origin, url) => {
        asks.push([origin, url])
        return answer
      },
      store: memory2.store
    })
    assert.equal(gate.peek('chat', 'https://peek.test/'), 'ask')
    assert.equal(await gate.check('chat', 'https://peek.test/page'), 'allow')
    assert.deepEqual(asks, [['https://peek.test', 'https://peek.test/page']])
    assert.equal(gate.peek('chat', 'https://peek.test/other'), 'allow')
    assert.deepEqual(gate.sites(), ['https://peek.test'])
    assert.deepEqual(memory2.saved, ['https://peek.test'])
    assert.equal(await gate.check('other', 'https://peek.test/other'), 'allow')
    assert.equal(asks.length, 1)

    answer = false
    assert.equal(await gate.check('chat', 'https://denied.test/'), 'deny')
    assert.equal(gate.peek('chat', 'https://denied.test/'), 'deny')
    assert.equal(gate.peek('other', 'https://denied.test/'), 'ask')
    assert.equal(await gate.check('chat', 'http://169.254.169.254/'), 'forbidden')
    assert.equal(await gate.check('chat', 'file:///x'), 'invalid')
    assert.equal(asks.length, 2)

    const add = gate.addSite('added.test')
    assert.equal(add.result, 'ok')
    assert.deepEqual(gate.sites(), ['https://peek.test', 'https://added.test'])
    assert.equal(gate.removeSite('https://added.test').removed, true)
    assert.deepEqual(gate.sites(), ['https://peek.test'])
    assert.deepEqual(gate.clearSites(), [])
    assert.deepEqual(memory2.saved, [])

    let release = null
    const slowAsks = []
    const slow = createPreviewSiteGate({
      confirm: async (origin) => {
        slowAsks.push(origin)
        if (release) await new Promise((resolve) => { release = resolve })
        return true
      }
    })
    release = () => {}
    const first = slow.check('s1', 'https://slow.test/')
    const second = slow.check('s1', 'https://slow.test/x')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(slowAsks.filter((origin) => origin === 'https://slow.test').length, 1)
    release()
    assert.deepEqual(await Promise.all([first, second]), ['allow', 'allow'])

    const broken = createPreviewSiteGate({ confirm: async () => { throw new Error('x') } })
    assert.equal(await broken.check('s1', 'https://err.test/'), 'deny')

    console.log('test-browser-allowed-sites: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
