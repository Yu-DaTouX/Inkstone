import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
await build({ stdin: { contents: "export * from './src/main/mcp/service-settings.ts';export {mcpServersForProject,parseMcpServersDocument} from './src/main/mcp/config.ts';export {McpAppHost} from './src/main/mcp/app-host.ts';export {McpAppProxyService} from './src/main/mcp/app-proxy-service.ts'", resolveDir: process.cwd() }, outfile: '.tmp/mcp-unification/services.mjs', bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
const { listMcpServiceSettings: list, changeMcpServiceSettings: change, mcpServersForProject, parseMcpServersDocument, McpAppHost, McpAppProxyService } = await import(pathToFileURL(resolve('.tmp/mcp-unification/services.mjs')).href)
const dir = await mkdtemp(join(tmpdir(), 'inkstone-mcp-settings-'))
const agentDir = join(dir, 'agent')
const projectDir = join(dir, 'project')
await mkdir(agentDir, { recursive: true })
await mkdir(join(projectDir, '.pi'), { recursive: true })
const globalPath = join(agentDir, 'mcp.json')
const projectPath = join(projectDir, '.pi', 'mcp.json')
const hostFile = join(dir, 'host.json')
const host = { agentDir, hostFile, context: 'runner-A', project: { id: 'A', name: 'Minecraft', cwd: projectDir }, projects: [{ id: 'A', cwd: projectDir }], projectTrusted: true, busy: false, nativeConfigChanged: null }
await writeFile(globalPath, JSON.stringify({ keepRoot: 1, mcpServers: { codegraph: { command: 'node', args: ['fixture'], env: { PRIVATE: 'preserved' }, extra: 'untouched' }, moved: { command: 'node' }, shadow: { command: 'global' } } }))
await writeFile(projectPath, JSON.stringify({ keepProject: 1, mcpServers: { codegraph: { exposure: 'deferred' }, local: { command: 'local-fixture' }, shadow: { command: 'project' } } }))
await writeFile(hostFile, JSON.stringify({ custom: 1, servers: [{ id: 'minecraft', title: 'Minecraft mod 开发', transport: 'stdio', command: 'node', env: { KEEP: 'value' }, extra: 12 }, { id: 'old-codegraph', transport: 'stdio', command: 'node', enabled: false, migratedToNative: { at: 'now', targetPath: globalPath, nativeName: 'codegraph' } }] }))
let checks = 0
const ok = (value, label) => { assert.ok(value, label); checks++ }
const invoke = async (input, customHost = host) => {
  const snapshot = await list(customHost)
  return change(customHost, { context: snapshot.context, revision: snapshot.revision, scope: 'project', ...input })
}
let snapshot = await list(host)
ok(snapshot.global.find((s) => s.name === 'codegraph').enabled, 'global definition kept independently')
ok(snapshot.projectServices.find((s) => s.name === 'codegraph').inherited, 'project view shows inherited global')
ok(snapshot.projectServices.filter((s) => s.name === 'shadow').length === 1 && snapshot.projectServices.find((s) => s.name === 'shadow').scope === 'project', 'project definition overrides matching global without duplicate row')
ok(!snapshot.global.some((s) => s.name === 'old-codegraph'), 'migrated host shadow removed from unified list')
ok((await invoke({ key: 'native:global:codegraph', action: 'disable' })).ok, 'project disable saves only local override')
let globalDoc = JSON.parse(await readFile(globalPath, 'utf8'))
let projectDoc = JSON.parse(await readFile(projectPath, 'utf8'))
ok(globalDoc.mcpServers.codegraph.enabled === undefined && projectDoc.mcpServers.codegraph.enabled === false, 'global state untouched by project switch')
ok(projectDoc.mcpServers.codegraph.exposure === 'deferred', 'project tool exposure preserved')
snapshot = await list(host)
ok(!snapshot.projectServices.find((s) => s.name === 'codegraph').enabled && snapshot.global.find((s) => s.name === 'codegraph').enabled, 'effective project and global states differ explicitly')
ok((await invoke({ key: 'native:global:codegraph', action: 'inherit' })).ok, 'restore inherited switch')
projectDoc = JSON.parse(await readFile(projectPath, 'utf8'))
ok(projectDoc.mcpServers.codegraph.exposure === 'deferred' && projectDoc.mcpServers.codegraph.enabled === undefined, 'restore switch preserves unrelated exposure')
ok((await invoke({ key: 'host:minecraft', action: 'disable' })).ok, 'legacy host has project override')
let legacy = JSON.parse(await readFile(hostFile, 'utf8'))
ok(legacy.custom === 1 && legacy.servers[0].extra === 12 && legacy.servers[0].env.KEEP === 'value' && legacy.servers[0].enabled === undefined, 'legacy document and credentials preserved')
ok(legacy.servers[0].projectEnabled.A === false, 'legacy override is stored for registered project')
const loaded = parseMcpServersDocument(JSON.stringify(legacy), hostFile)
ok(mcpServersForProject(loaded.servers, 'A')[0].enabled === false && mcpServersForProject(loaded.servers, 'B')[0].enabled !== false, 'runtime filtering applies project override without affecting others')
ok((await invoke({ key: 'host:minecraft', action: 'inherit' })).ok, 'legacy inheritance restored')
ok(!(await invoke({ key: 'host:minecraft', action: 'disable' }, { ...host, busy: true })).ok, 'running legacy service not disconnected')
ok(!(await invoke({ key: 'host:minecraft', action: 'disable' }, { ...host, busy: false, isBusy: () => true })).ok, 'fresh runtime state blocks legacy switch even after idle snapshot')
ok(!!parseMcpServersDocument(JSON.stringify([{id:'invalid',transport:'stdio',command:'node',projectEnabled:{A:'false'}}]), hostFile).error, 'malformed project switch config rejected')
ok((await invoke({ scope: 'global', key: 'native:global:codegraph', action: 'disable' })).ok, 'global switch targets global file')
ok(!(await invoke({ action: 'add', name: 'new', config: { command: 'node' } }, { ...host, projectTrusted: false })).ok, 'untrusted project writes rejected')
ok((await invoke({ action: 'add', name: 'added', config: { url: 'https://example.invalid/mcp' } })).ok, 'new network service respects selected project scope')
ok((await list(host)).projectServices.some((s) => s.name === 'added' && s.scope === 'project'), 'added service appears only in project list')
ok(!(await invoke({ action: 'add', name: '__proto__', config: { command: 'node' } })).ok, 'reserved object keys rejected')
ok(!(await invoke({ action: 'add', name: 'bad', config: { url: 'file:///private' } })).ok, 'invalid protocol rejected')
ok(!(await invoke({ action: 'add', name: 'codegraph', config: { command: 'node' } })).ok, 'duplicate names never overwrite credentials')
const stale = await list(host)
await writeFile(hostFile, (await readFile(hostFile, 'utf8')) + '\n')
ok(!(await change(host, { context: stale.context, revision: stale.revision, scope: 'global', action: 'disable', key: 'native:global:codegraph' })).ok, 'external file changes invalidate stale operation')
ok(!(await change(host, { context: 'other', revision: '', scope: 'global', action: 'disable', key: 'native:global:codegraph' })).ok, 'changed conversation identity rejected')
const previousGlobal = await readFile(globalPath, 'utf8')
const previousProject = await readFile(projectPath, 'utf8')
let writes = 0
ok(!(await invoke({ action: 'move', scope: 'project', key: 'native:global:moved' }, { ...host, assertContext: () => { if (++writes === 2) throw new Error('context switched during move') } })).ok, 'scope change aborts when context switches')
ok(await readFile(globalPath, 'utf8') === previousGlobal && await readFile(projectPath, 'utf8') === previousProject, 'failed scope transaction rolls back byte-for-byte')
ok((await invoke({ action: 'move', scope: 'project', key: 'native:global:moved' })).ok, 'global to project scope move succeeds')
ok(!(await list(host)).global.some((s) => s.name === 'moved') && (await list(host)).projectServices.some((s) => s.name === 'moved' && s.scope === 'project'), 'scope move leaves single project definition')
ok((await invoke({ action: 'move', scope: 'global', key: 'native:project:moved' })).ok, 'project to global scope move succeeds')
ok((await invoke({ scope: 'project', action: 'remove', key: 'native:project:added' })).ok, 'project removal scoped to project')
ok(JSON.parse(await readFile(globalPath, 'utf8')).keepRoot === 1 && JSON.parse(await readFile(projectPath, 'utf8')).keepProject === 1, 'root metadata preserved across writes')
const managedPath = join(dir, 'managed.json')
const managed = { id: 'shared', transport: 'stdio', command: 'fixture', ownedBy: 'inkstone', appHost: { at: 'fixture', natives: [] }, projectEnabled: { A: false } }
await writeFile(managedPath, JSON.stringify([managed]))
let managers = 0, closed = 0
const sharedHost = new McpAppHost({ env: { YAN_MCP_SERVERS_FILE: managedPath }, ownership: { agentDir, projects: [], readNativeConfig: async () => null, holdersFor: async () => [] }, createManager: () => {
  managers++
  return { listToolsRaw: async () => [{ name: 'ping', inputSchema: { type: 'object' } }], close: async () => { closed++ } }
} })
try {
  ok((await sharedHost.listToolsWithMeta('shared', { projectId: 'B' })).length === 1, 'enabled project obtains actual host tool inventory')
  await assert.rejects(() => sharedHost.listToolsWithMeta('shared', { projectId: 'A' }))
  ok(closed === 0, 'disabled project rejected without disconnecting another project’s shared host')
  await sharedHost.listToolsWithMeta('shared', { projectId: 'B' })
  ok(managers === 1, 'other project reuses existing shared connection')
  await writeFile(managedPath, JSON.stringify([{ ...managed, enabled: false, projectEnabled: { A: false, B: true } }]))
  ok((await sharedHost.reconcile('shared')).eligible && closed === 0, 'global off retains shared host while a project explicitly enables it')
  ok((await sharedHost.listToolsWithMeta('shared', { projectId: 'B' })).length === 1 && managers === 1, 'project can enable a globally disabled hosted service')
  await writeFile(managedPath, JSON.stringify([{ ...managed, enabled: false }]))
  ok((await sharedHost.reconcile('shared')).closed && closed === 1, 'host disconnects once disabled in every scope')
} finally { await sharedHost.close() }
const emptyProxy = new McpAppProxyService({ dir: join(dir, 'empty-proxy'), host: { listManagedServers: () => [] } })
ok(!(await emptyProxy.refresh()).written, 'ordinary empty refresh keeps prior snapshot behavior')
ok((await emptyProxy.refresh({ allowEmpty: true })).written, 'explicit current-session apply can publish empty tool inventory')
ok(emptyProxy.readSnapshot().tools.length === 0, 'disabling final hosted service removes all proxy tool schemas on reload')
console.log(`MCP settings: ${checks} checks passed; fixture ${dir}`)
