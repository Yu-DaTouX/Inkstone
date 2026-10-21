import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'review2-capabilities-'))
try {
  const entries = {
    packages: 'src/main/packages.ts',
    market: 'src/main/plugin-market.ts',
    extensions: 'src/main/extensions-inventory.ts',
    skills: 'src/main/user-skills.ts',
    mcpConfig: 'src/main/mcp/config.ts',
    discover: 'src/main/capabilities/discovery/discover.ts'
  }
  for (const [name, entryPoint] of Object.entries(entries)) {
    await build({ entryPoints: [entryPoint], outfile: join(temp, `${name}.mjs`), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  }
  const load = async (name) => import(pathToFileURL(join(temp, `${name}.mjs`)).href)
  const packages = await load('packages')
  assert.equal(packages.packageNameOf('git:github.com/a/repo#main'), 'repo')
  assert.equal(packages.packageNameOf('git:github.com/a/repo@v1'), 'repo')
  assert.equal(packages.listPackages('', join(temp, 'agent')).ok, true)
  const settings = join(temp, 'settings.json')
  await writeFile(settings, '{broken')
  const brokenListing = packages.listPackages('', temp)
  assert.equal(brokenListing.ok, false)
  assert.match(String(brokenListing.error), /无法读取或解析/)
  await writeFile(settings, JSON.stringify({ packages: ['npm:../../outside'] }))
  assert.equal(packages.listPackages('', temp).ok, false)
  packages.configurePackageContext({ bin: () => null, isProjectTrusted: () => false })
  assert.equal((await packages.runPackageAction({ kind: 'install', source: 'npm:valid', local: true, cwd: '' })).ok, false)
  await rm(settings)

  const market = await load('market')
  const source = join(temp, 'incomplete'), parent = join(temp, 'export')
  await mkdir(source); await mkdir(parent)
  await writeFile(join(source, market.HERMES_PLUGIN_FILES[0]), 'partial')
  await assert.rejects(market.exportHermesPlugin(source, parent))
  assert.deepEqual(await readdir(parent), [])

  const extensions = await load('extensions')
  const pi = join(temp, 'pi'), linkedTarget = join(temp, 'linked-extension')
  await mkdir(join(pi, 'extensions'), { recursive: true })
  await mkdir(linkedTarget)
  await symlink(linkedTarget, join(pi, 'extensions', 'linked'))
  assert.deepEqual(extensions.readUserExtensions(pi), ['linked'])
  assert.ok(extensions.extensionDiagnostics({ piDir: pi }).some((line) => line.includes('left-panel-tasks')))

  const mcp = await load('mcpConfig')
  const configPath = join(temp, 'mcp.json')
  await writeFile(configPath, JSON.stringify([{ id: 'fixture', transport: 'stdio', command: 'fixture', args: ['--port', 3030, true], env: { PORT: 3030, ENABLED: false } }]))
  const loaded = mcp.loadMcpServers({ YAN_MCP_SERVERS_FILE: configPath })
  assert.deepEqual(loaded.servers[0].args, ['--port', '3030', 'true'])
  assert.deepEqual(loaded.servers[0].env, { PORT: '3030', ENABLED: 'false' })

  const skills = await load('skills')
  const skillRoot = join(temp, 'skills-data')
  await mkdir(join(skillRoot, 'skills'), { recursive: true })
  await writeFile(join(skillRoot, 'skills', '.playbooks-migrated.json'), '{broken')
  await writeFile(join(skillRoot, 'playbooks.json'), JSON.stringify({ playbooks: [{ id: 'gone', name: 'gone', title: 'Gone', content: 'body' }] }))
  const migration = await skills.migrateLegacyPlaybooks(skillRoot)
  assert.equal(migration.exported.length, 0)
  assert.ok(migration.diagnostics.length)
  assert.deepEqual(await skills.userSkillPaths(join(temp, 'missing-skills-root')), [])
  const notDirectory = join(temp, 'not-directory')
  await mkdir(notDirectory)
  await writeFile(join(notDirectory, 'skills'), 'file')
  await assert.rejects(skills.userSkillPaths(notDirectory))

  const discovery = await load('discover')
  const oversized = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(900 * 1024))
      controller.enqueue(new Uint8Array(900 * 1024))
      controller.enqueue(new Uint8Array(900 * 1024))
      controller.close()
    }
  }), { status: 200 })
  const outcome = await discovery.discoverCapabilities({
    queryText: 'fixture', timeoutMs: 1000,
    fetchImpl: async () => oversized()
  })
  assert.equal(outcome.candidates.length, 0)
  assert.ok(outcome.sources.every((item) => !item.ok))
  console.log('review2 capabilities behavior regression: passed')
} finally {
  await rm(temp, { recursive: true, force: true })
}
