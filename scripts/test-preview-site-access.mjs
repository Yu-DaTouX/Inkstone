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

async function run() {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-preview-site-'))
  try {
    const site = await compile('src/main/preview-site-access.ts', join(dir, 'site.mjs'))

    assert.equal(site.normalizeSiteOrigin('https://WWW.Example.com./path?q=1'), 'https://example.com')
    assert.equal(site.normalizeSiteOrigin('http://www.dev:8080/'), 'http://www.dev:8080')
    assert.equal(site.normalizeSiteOrigin('http://localhost:5173/app'), 'http://localhost:5173')
    assert.equal(site.normalizeSiteOrigin('https://example.com:443/'), 'https://example.com')
    assert.equal(site.normalizeSiteOrigin('http://[::ffff:127.0.0.1]:3000/'), 'http://127.0.0.1:3000')
    assert.equal(site.normalizeSiteOrigin('file:///C:/x.html'), null)
    assert.equal(site.normalizeSiteOrigin('javascript:alert(1)'), null)
    assert.equal(site.normalizeSiteOrigin('not a url'), null)

    for (const url of [
      'http://169.254.169.254/latest/meta-data',
      'http://2852039166/',
      'http://0xa9fea9fe/',
      'http://[::ffff:169.254.169.254]/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://100.100.100.200/',
      'http://0.0.0.0:8080/',
      'http://[::]/',
      'http://[fe80::1]/',
      'http://169.254.1.2/'
    ]) {
      const origin = site.normalizeSiteOrigin(url)
      assert.ok(origin, url)
      assert.equal(site.isForbiddenOrigin(origin), true, url)
    }
    assert.equal(site.isForbiddenOrigin('http://127.0.0.1:3000'), false)
    assert.equal(site.isForbiddenOrigin('https://example.com'), false)

    const access = new site.PreviewSiteAccess(undefined, 2)
    assert.deepEqual(access.decide('s1', 'https://example.com/a'), { decision: 'ask', origin: 'https://example.com' })
    assert.equal(access.record('s1', 'https://www.example.com/b', true), 'allow')
    assert.equal(access.decide('s1', 'https://example.com/c').decision, 'allow')
    assert.equal(access.decide('s2', 'https://example.com/c').decision, 'allow')
    assert.equal(access.record('s1', 'https://evil.test', false), 'deny')
    assert.equal(access.decide('s1', 'https://evil.test/x').decision, 'ask')
    assert.equal(access.record('s1', 'https://evil.test', true), 'allow')
    assert.equal(access.decide('s1', 'https://evil.test/x').decision, 'allow')
    assert.equal(access.record('s1', 'http://169.254.169.254/', true), 'forbidden')
    assert.equal(access.decide('s1', 'http://169.254.169.254/').decision, 'forbidden')
    assert.equal(access.decide('s1', 'ftp://x').decision, 'invalid')
    access.record('s1', 'https://third.test', true)
    assert.equal(access.decide('s1', 'https://example.com').decision, 'allow')
    assert.equal(access.decide('s1', 'https://third.test').decision, 'ask')

    const { createPreviewSiteGate } = await compile('src/main/preview-site-gate.ts', join(dir, 'gate.mjs'))
    const asked = []
    let answer = true
    let release = null
    const gate = createPreviewSiteGate({
      confirm: async (origin) => {
        asked.push(origin)
        if (release) await new Promise((resolve) => { release = resolve })
        return answer
      }
    })
    assert.equal(await gate.check('s1', 'https://www.example.com/a'), 'allow')
    assert.equal(await gate.check('s1', 'https://example.com/b'), 'allow')
    assert.deepEqual(asked, ['https://example.com'])
    assert.equal(await gate.check('s2', 'https://example.com/b'), 'allow')
    assert.equal(asked.length, 1)
    answer = false
    assert.equal(await gate.check('s1', 'https://bad.test/'), 'deny')
    answer = true
    assert.equal(await gate.check('s1', 'https://bad.test/'), 'allow')
    assert.equal(asked.length, 3)
    assert.equal(await gate.check('s1', 'http://169.254.169.254/'), 'forbidden')
    assert.equal(await gate.check('s1', 'file:///x'), 'invalid')
    assert.equal(asked.length, 3)
    release = () => {}
    const first = gate.check('s3', 'https://slow.test/')
    const second = gate.check('s3', 'https://slow.test/x')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(asked.filter((origin) => origin === 'https://slow.test').length, 1)
    release()
    assert.deepEqual(await Promise.all([first, second]), ['allow', 'allow'])
    release = null
    assert.equal(await gate.check('s1', 'https://bad.test/'), 'allow')
    const failing = createPreviewSiteGate({ confirm: async () => { throw new Error('x') } })
    assert.equal(await failing.check('s1', 'https://err.test/'), 'deny')
    answer = true

    console.log('test-preview-site-access: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
