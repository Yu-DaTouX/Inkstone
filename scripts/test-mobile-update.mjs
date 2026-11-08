import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-mobile-update-'))
const outfile = join(root, 'update.mjs')
await build({
  entryPoints: ['mobile/src/appUpdate.ts'], outfile, bundle: true, platform: 'neutral', format: 'esm', logLevel: 'silent',
  plugins: [{ name: 'rn-stub', setup(b) { b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rn', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const Platform = { OS: "android" }; export const NativeModules = {}; export class NativeEventEmitter {}', loader: 'js' })) } }]
})
const U = await import(pathToFileURL(outfile).href)

const asset = (name, url = `https://github.com/Yu-DaTouX/Inkstone/releases/download/v0.15.0/${name}`) => ({ name, browser_download_url: url, size: 80_000_000 })

assert.ok(U.compareVersions('0.3.10', '0.3.9') > 0)
assert.equal(U.compareVersions('0.4.0', '0.4.0'), 0)
assert.ok(U.compareVersions('1.0.0', '0.99.99') > 0)

const release = { body: '更新说明', assets: [asset('Inkstone-0.15.0-Setup.exe'), asset('Inkstone-mobile-0.3.2.apk'), asset('latest.yml')] }
assert.deepEqual(U.pickUpdate(release, '0.3.1'), { version: '0.3.2', url: release.assets[1].browser_download_url, size: 80_000_000, notes: '更新说明' })
assert.equal(U.pickUpdate(release, '0.3.2'), null, '同版本不提示')
assert.equal(U.pickUpdate(release, '0.4.0'), null, '本机更新时不提示降级')
assert.equal(U.pickUpdate({ ...release, draft: true }, '0.3.1'), null, '草稿不算')
assert.equal(U.pickUpdate({ ...release, prerelease: true }, '0.3.1'), null, '预发布不算')
assert.equal(U.pickUpdate({ assets: [asset('Inkstone-mobile-0.3.2.apk', 'https://evil.example/x.apk')] }, '0.3.1'), null, '只接受 GitHub 的下载地址')
assert.equal(U.pickUpdate({ assets: [asset('Inkstone-mobile-0.3.2-debug-signed.apk')] }, '0.3.1'), null, '调试签名包不当作更新')
assert.equal(U.pickUpdate({ assets: [asset('Inkstone-mobile-0.3.2.apk'), asset('Inkstone-mobile-0.3.5.apk')] }, '0.3.1').version, '0.3.5', '多个包取最新')
assert.equal(U.pickUpdate(null, '0.3.1'), null)
console.log('test-mobile-update ok')
