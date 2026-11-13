import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = mkdtempSync(join(tmpdir(), 'yan-project-trust-'))
const agentDir = join(root, 'agent')
mkdirSync(agentDir)
process.env.YAN_PI_DIR = agentDir

const outfile = join(root, 'project-trust.mjs')
await build({ entryPoints: ['src/main/project-trust.ts'], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error', external: ['electron'] })
const mod = await import(pathToFileURL(outfile).href)

const dir = agentDir
const project = join(root, 'project')
mkdirSync(project)
const settings = (value) => writeFileSync(join(dir, 'settings.json'), JSON.stringify(value === undefined ? {} : { defaultProjectTrust: value }))
const table = (value) => writeFileSync(join(dir, 'trust.json'), JSON.stringify(value))

try {
  table({})
  settings('always')
  assert.equal((await mod.trustStatus(project)).trusted, true)
  settings('ask')
  assert.equal((await mod.trustStatus(project)).trusted, false)
  settings('never')
  assert.equal((await mod.trustStatus(project)).trusted, false)
  settings(undefined)
  assert.equal((await mod.trustStatus(project)).trusted, false)

  settings('always')
  table({ [project]: false })
  const denied = await mod.trustStatus(project)
  assert.equal(denied.trusted, false)
  assert.equal(denied.entry, project)

  settings('never')
  table({ [root]: true })
  const inherited = await mod.trustStatus(project)
  assert.equal(inherited.trusted, true)
  assert.equal(inherited.entry, root)
  console.log('project trust default: ok')
} finally {
  rmSync(root, { recursive: true, force: true })
}
