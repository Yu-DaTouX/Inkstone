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

    const access = new site.PreviewSiteAccess(2)
    assert.deepEqual(access.decide('s1', 'https://example.com/a'), { decision: 'ask', origin: 'https://example.com' })
    assert.equal(access.record('s1', 'https://www.example.com/b', true), 'allow')
    assert.equal(access.decide('s1', 'https://example.com/c').decision, 'allow')
    assert.equal(access.decide('s2', 'https://example.com/c').decision, 'ask')
    assert.equal(access.record('s1', 'https://evil.test', false), 'deny')
    assert.equal(access.record('s1', 'https://evil.test', true), 'deny')
    assert.equal(access.decide('s1', 'https://evil.test/x').decision, 'deny')
    assert.equal(access.record('s1', 'http://169.254.169.254/', true), 'forbidden')
    assert.equal(access.decide('s1', 'http://169.254.169.254/').decision, 'forbidden')
    assert.equal(access.decide('s1', 'ftp://x').decision, 'invalid')
    access.record('s1', 'https://third.test', true)
    assert.equal(access.decide('s1', 'https://example.com').decision, 'ask')
    access.forgetSession('s1')
    assert.equal(access.decide('s1', 'https://evil.test').decision, 'ask')

    console.log('test-preview-site-access: 全部通过')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
