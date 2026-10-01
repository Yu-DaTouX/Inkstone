import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { selectedPiRuntime } from './lib/pi-runtime-location.mjs'

// Real pi CLI, local sources only. Never reuse the user's settings or plugin directories.
const dir = mkdtempSync(join(tmpdir(), 'inkstone-package-scope-'))
const agent = join(dir, 'agent')
const cwd = join(dir, 'project')
const source = join(dir, 'managed', 'payload', 'package')
for (const path of [agent, join(cwd, '.pi'), source]) mkdirSync(path, { recursive: true })
process.env.YAN_PI_DIR = agent
process.env.YAN_DATA_DIR = join(dir, 'desktop')
const userSettings = join(agent, 'settings.json')
const projectSettings = join(cwd, '.pi', 'settings.json')
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2))
write(join(source, 'package.json'), { name: 'inkstone-scope-fixture', version: '1.0.0', pi: {} })
write(userSettings, { packages: [source], fixture: 'user' })
write(projectSettings, { packages: [source], fixture: 'project' })
write(join(agent, 'trust.json'), { [realpathSync(cwd)]: true })
const outfile = join(dir, 'packages.mjs')
await build({ entryPoints: ['src/main/packages.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
const { configurePackageContext, listPackages, runPackageAction } = await import(pathToFileURL(outfile).href)
configurePackageContext({
  bin: () => join(selectedPiRuntime(resolve('resources/pi-runtime')), 'dist', 'bundle', 'cli.js'),
  agentDir: () => agent,
  hasRunningTask: () => false
})
const userBefore = readFileSync(userSettings)
const projectBefore = readFileSync(projectSettings)
assert.deepEqual(listPackages(cwd).entries.map(e => e.scope), ['user', 'project'], 'both declarations remain manageable')
let result = await runPackageAction({ kind: 'remove', source, local: true, cwd })
assert.equal(result.ok, true, result.detail)
assert.deepEqual(result.listing.entries.map(e => e.scope), ['user'])
assert.equal(result.listing.entries[0].installed, true, 'a local source shared with user scope remains installed')
assert.deepEqual(readFileSync(userSettings), userBefore, 'project removal leaves user settings byte-identical')

// Different settings directories give the same local package different relative sources.
const projectSource = relative(join(cwd, '.pi'), source)
write(projectSettings, { packages: [projectSource], fixture: 'project' })
const projectRelativeBefore = readFileSync(projectSettings)
result = await runPackageAction({ kind: 'update', source: projectSource, local: true, cwd })
assert.equal(result.ok, true, result.detail)
assert.deepEqual(readFileSync(userSettings), userBefore)
assert.deepEqual(readFileSync(projectSettings), projectRelativeBefore)
result = await runPackageAction({ kind: 'remove', source, local: false, cwd })
assert.equal(result.ok, true, result.detail)
assert.deepEqual(result.listing.entries.map(e => e.scope), ['project'])
assert.deepEqual(readFileSync(projectSettings), projectRelativeBefore, 'user removal leaves project settings byte-identical')
result = await runPackageAction({ kind: 'remove', source: projectSource, local: false, cwd })
assert.equal(result.ok, false, 'the original wrong-scope request reproduces the screenshot failure')
assert.match(result.detail, /No matching package found/)
assert.deepEqual(readFileSync(projectSettings), projectRelativeBefore)
result = await runPackageAction({ kind: 'remove', source: projectSource, local: true, cwd })
assert.equal(result.ok, true, result.detail)
assert.deepEqual(result.listing.entries, [])
assert.notDeepEqual(projectBefore, readFileSync(projectSettings))
console.log('PASS package scopes: dual declarations, project/user removal isolation, relative project update/removal')
console.log(`Isolated evidence: ${dir}`)
