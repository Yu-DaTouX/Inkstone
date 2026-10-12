import { build } from '../node_modules/esbuild/lib/main.js'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const root = await mkdtemp(join(tmpdir(), 'review-auth-'))
const piDir = join(root, 'pi')
const yanDir = join(root, 'yan')
process.env.YAN_PI_DIR = piDir
process.env.YAN_DATA_DIR = yanDir
await build({ entryPoints: ['src/main/credentials.ts'], outfile: join(root, 'credentials.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
await build({ entryPoints: ['src/main/custom-providers.ts'], outfile: join(root, 'custom-providers.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
await build({ entryPoints: ['src/main/codex-token.ts'], outfile: join(root, 'codex-token.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' })
const credentials = await import(pathToFileURL(join(root, 'credentials.mjs')).href)
const providers = await import(pathToFileURL(join(root, 'custom-providers.mjs')).href)
const token = await import(pathToFileURL(join(root, 'codex-token.mjs')).href)
const electronStub = join(root, 'electron-stub.mjs')
await writeFile(electronStub, 'export const shell = { openExternal: async () => {} }')
await build({ entryPoints: ['src/main/codex-accounts.ts'], outfile: join(root, 'codex-accounts.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', alias: { electron: electronStub } })
const accounts = await import(pathToFileURL(join(root, 'codex-accounts.mjs')).href)

await credentials.mergeAuthEntry('provider-a', { type: 'api_key', key: 'synthetic-a' })
const authPath = join(piDir, 'auth.json')
const goodAuth = await readFile(authPath, 'utf8')
await writeFile(authPath, '{ truncated')
assert.equal((await credentials.mergeAuthEntry('provider-b', { type: 'api_key', key: 'synthetic-b' })).ok, false)
assert.equal(await readFile(authPath, 'utf8'), '{ truncated')
await writeFile(authPath, goodAuth)

const storePath = join(yanDir, 'codex-accounts.json')
await (await import('node:fs/promises')).mkdir(yanDir, { recursive: true })
await writeFile(storePath, '{ broken')
await credentials.mergeAuthEntry('openai-codex', { type: 'oauth', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: Date.now() + 1000, accountId: 'stored-account-id' })
await assert.rejects(accounts.captureActiveCodexAccount(), /账号凭证文件格式无效/)
assert.equal(await readFile(storePath, 'utf8'), '{ broken')

const claims = token.extractAccountId('not-a-jwt')
assert.equal(claims, null)
const oldFetchForToken = globalThis.fetch
globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'header.e30.signature', refresh_token: 'rotated-refresh', expires_in: 3600 }), { status: 200 })
try {
  const refreshed = await token.refreshCodexCredential('old-refresh', 'stored-account-id')
  assert.equal(refreshed.refresh, 'rotated-refresh')
  assert.equal(refreshed.accountId, 'stored-account-id')
} finally {
  globalThis.fetch = oldFetchForToken
}

const oldFetch = globalThis.fetch
let receivedAuthorization = ''
globalThis.fetch = async (_url, init) => {
  receivedAuthorization = new Headers(init.headers).get('authorization') ?? ''
  return new Response(JSON.stringify({ data: [{ id: 'model-x' }] }), { status: 200 })
}
try {
  const saved = await providers.saveCustomProvider({ id: 'yan-test', name: 'Test', api: 'openai-completions', baseUrl: 'https://one.example/v1', apiKey: 'synthetic-secret', models: [{ id: 'model-x' }] })
  assert.equal(saved.ok, true)
  const changed = await providers.discoverCustomProviderModels({ id: 'yan-test', api: 'openai-completions', baseUrl: 'https://two.example/v1' })
  assert.equal(changed.ok, false)
  assert.equal(receivedAuthorization, '')
  const same = await providers.discoverCustomProviderModels({ id: 'yan-test', api: 'openai-completions', baseUrl: 'https://one.example/v1' })
  assert.equal(same.ok, true)
  assert.equal(receivedAuthorization, 'Bearer synthetic-secret')
} finally {
  globalThis.fetch = oldFetch
}

assert.equal((await readdir(root)).length >= 5, true)
console.log('review-auth isolated regressions passed')
