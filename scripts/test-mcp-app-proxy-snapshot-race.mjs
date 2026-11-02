import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'inkstone-mcp-snapshot-race-'))
const electronStub = {
  name: 'electron-stub',
  setup(api) {
    api.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    api.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: 'export const app = { getPath: () => "" }; export const safeStorage = {}; export const shell = {}; export default {}', loader: 'js' }))
  }
}
try {
  process.env.YAN_DATA_DIR = join(root, 'yan')
  const outfile = join(root, 'proxy.cjs')
  await build({ entryPoints: ['src/main/mcp/app-proxy-service.ts'], outfile, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent', plugins: [electronStub] })
  const { McpAppProxyService } = createRequire(import.meta.url)(outfile)

  let release
  const gate = new Promise((resolve) => { release = resolve })
  const servers = [
    { id: 'srv-a', title: 'A', projectScope: 'proj-a', ownedBy: 'inkstone', appHost: true },
    { id: 'srv-b', title: 'B', projectScope: 'proj-b', ownedBy: 'inkstone', appHost: true }
  ]
  const tool = (name) => ({ name, visibility: ['model', 'app'], modelVisible: true, appVisible: true, resourceUri: null })
  const host = {
    listManagedServers: (projectId) => servers.filter((server) => server.projectScope === projectId),
    listToolsWithMeta: async (serverId) => {
      await gate
      return [tool(`${serverId}-tool`)]
    },
    callToolWithMeta: async () => { throw new Error('unused') },
    statusOf: () => ({ status: 'connected' })
  }
  const dir = join(root, 'yan', 'mcp-app')
  const service = new McpAppProxyService({ host, dir, env: {} })
  const refreshing = [
    service.refresh({ callerProjectId: 'proj-a' }),
    service.refresh({ callerProjectId: 'proj-b' })
  ]
  release()
  const results = await Promise.all(refreshing)
  assert.ok(results.every((result) => result.written), '两次刷新都写入了快照')
  const snapshot = JSON.parse(await readFile(service.snapshotPath(), 'utf8'))
  const serverIds = snapshot.tools.map((item) => item.serverId).sort()
  assert.deepEqual(serverIds, ['srv-a', 'srv-b'], `两个项目同时刷新后快照保留双方的工具：${JSON.stringify(serverIds)}`)
  assert.deepEqual(snapshot.servers.map((item) => item.id).sort(), ['srv-a', 'srv-b'], '快照保留双方的服务状态')
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), [], '不残留临时文件')
  console.log('mcp app proxy snapshot race: 4 项通过')
} finally {
  await rm(root, { recursive: true, force: true })
}
