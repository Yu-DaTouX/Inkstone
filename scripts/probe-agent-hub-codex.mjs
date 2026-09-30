import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const executable = process.argv[2]
if (!executable) throw new Error('Pass the installed native Codex executable path')
const root = await mkdtemp(join(tmpdir(), 'inkstone-codex-handshake-'))
const home = join(root, 'codex-home'); await mkdir(home)
await build({ entryPoints: ['src/main/agent-hub/codex-adapter.ts'], outfile: join(root, 'adapter.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { CodexAdapter } = await import(pathToFileURL(join(root, 'adapter.mjs')))
let failure
const adapter = new CodexAdapter(executable, { event() {}, request() { throw new Error('Handshake must not request permissions') }, exit(error) { failure = error } })
try {
  await adapter.start(root, {}, { ...process.env, CODEX_HOME: home })
  assert.equal(failure, undefined)
  assert.equal(typeof await adapter.thread(root, 'gpt-6-luna'), 'string')
  console.log('Installed Codex app-server handshake and workspace-write thread schema passed. No model request or user credentials used.')
} finally {
  assert.equal(await adapter.close(), true, 'Control process must exit')
}
