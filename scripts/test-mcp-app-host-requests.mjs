import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = await mkdtemp(join(tmpdir(), 'inkstone-app-host-requests-'))
const outfile = resolve('.tmp/mcp-apps/host-requests-test.mjs')
await build({
  stdin: { contents: "export * from './src/main/mcp/app-host-requests'; export * from './src/main/mcp/app-network-policy'; export * from './src/main/mcp/app-protocol'; export * as electron from 'electron';", loader: 'ts', resolveDir: process.cwd() },
  outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
  plugins: [{ name: 'isolated-electron', setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const opened = []
      export let nextSave = { canceled: true }
      export let onSave = null
      export function setSave(value, callback = null) { nextSave = value; onSave = callback }
      export const dialog = { async showSaveDialog() { onSave?.(); return nextSave } }
      export const shell = { async openExternal(url) { opened.push(url) } }
      export const protocol = { registerSchemesAsPrivileged() {}, handle() {} }
    ` }))
  } }]
})
const module = await import(pathToFileURL(outfile).href)
const { createMcpAppHostRequests, isMcpAppPrivateAddress, createMcpAppResourceLoader, electron } = module
const facts = { runnerId: 'runner', sessionId: 'session' }
const signal = new AbortController().signal
let checks = 0
function equal(actual, expected) { assert.deepEqual(actual, expected); checks++ }
async function rejects(callback) { await assert.rejects(callback); checks++ }
try {
  const requests = createMcpAppHostRequests(async () => {}, async () => false)
  await requests.openLink('https://example.com/docs?q=1', facts, signal)
  equal(electron.opened, ['https://example.com/docs?q=1'])
  for (const url of ['javascript:alert(1)', 'file:///tmp/file', 'http://example.com', 'https://user:secret@example.com', 'https://127.0.0.1', 'https://169.254.169.254', 'https://example.com/\u202efile']) await rejects(() => requests.openLink(url, facts, signal))
  const privateRequests = createMcpAppHostRequests(async () => {}, async () => true)
  await rejects(() => privateRequests.openLink('https://private.example.com', facts, signal))
  const failedDns = createMcpAppHostRequests(async () => {}, async () => { throw new Error('DNS unavailable') })
  await rejects(() => failedDns.openLink('https://unknown.example.com', facts, signal))
  equal(electron.opened.length, 1)
  for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.0.1', '224.0.0.1', '0.0.0.0']) equal(isMcpAppPrivateAddress(address, 4), true)
  for (const address of ['::1', '::ffff:127.0.0.1', 'fe80::1', 'fd00::1', '2001:db8::1', '2002:7f00:1::']) equal(isMcpAppPrivateAddress(address, 6), true)
  equal(isMcpAppPrivateAddress('8.8.8.8', 4), false)
  equal(isMcpAppPrivateAddress('2606:4700:4700::1111', 6), false)
  const target = join(root, 'export.txt')
  const embedded = [{ type: 'resource', resource: { uri: 'file:///untrusted-name.txt', text: 'hello' } }]
  electron.setSave({ canceled: false, filePath: target })
  await requests.downloadFile(embedded, facts, signal)
  equal(await readFile(target, 'utf8'), 'hello')
  await rejects(() => requests.downloadFile([{ type: 'resource_link', uri: 'https://example.com/file', name: 'file' }], facts, signal))
  await rejects(() => requests.downloadFile([...embedded, ...embedded], facts, signal))
  await rejects(() => requests.downloadFile([{ type: 'resource', resource: { uri: 'file:///large', text: 'x'.repeat(1024 * 1024 + 1) } }], facts, signal))
  electron.setSave({ canceled: true })
  await rejects(() => requests.downloadFile(embedded, facts, signal))
  const revoked = new AbortController()
  electron.setSave({ canceled: false, filePath: target }, () => revoked.abort())
  await rejects(() => requests.downloadFile([{ type: 'resource', resource: { uri: 'file:///new', text: 'must not write' } }], facts, revoked.signal))
  equal(await readFile(target, 'utf8'), 'hello')
  await rejects(() => requests.openLink('https://example.com', facts, revoked.signal))
  const loader = createMcpAppResourceLoader({ async readResource() { return { text: '<html></html>', mimeType: 'text/html;profile=mcp-app', bytes: 13, uiCsp: { resourceDomains: ['https://cdn.example.com', 'https://private.example.com'], connectDomains: ['https://api.example.com'], frameDomains: ['https://frame.example.com'], baseUriDomains: ['https://base.example.com'] } } } }, { resolvePrivateHost: async (host) => host.startsWith('private.') })
  const loaded = await loader({ serverId: 'server', resourceUri: 'ui://server/app' })
  equal(loaded.approvedCsp, { resourceDomains: ['https://cdn.example.com'], connectDomains: ['https://api.example.com'], frameDomains: [], baseUriDomains: [] })
  equal(loaded.csp.includes('private.example.com'), false)
  equal(loaded.csp.includes("frame-src 'none'"), true)
  equal(loaded.csp.includes("base-uri 'none'"), true)
  equal(loaded.csp.includes('https://cdn.example.com'), true)
  console.log(`MCP Apps 宿主链接/下载/资源 CSP：${checks} 项通过（Electron 副作用为隔离 fixture）`)
} finally {
  await rm(root, { recursive: true, force: true })
}
