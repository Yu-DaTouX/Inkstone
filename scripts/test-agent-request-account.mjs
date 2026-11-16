import './lib/test-isolate.mjs'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = await mkdtemp(join(tmpdir(), 'yan-agent-request-account-'))
process.env.YAN_DATA_DIR = join(root, 'data')
process.env.YAN_PI_DIR = join(root, 'pi')
process.env.YAN_ATTACHMENTS_DIR = join(root, 'attachments')

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}

const outfile = join(process.cwd(), 'out', 'test', 'agent-request-account.mjs')
await mkdir(dirname(outfile), { recursive: true })
await build({
  stdin: { contents: "export { AgentController } from './src/main/agent'", resolveDir: process.cwd(), loader: 'ts' },
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
  plugins: [{
    name: 'electron-boundary',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub-electron' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub-electron' }, () => ({
        contents: `
          export class BrowserWindow { constructor() { throw new Error('requires Electron') } }
          export const session = { fromPartition() { throw new Error('requires Electron') } }
          export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
          export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
          export const safeStorage = { isEncryptionAvailable: () => false }
        `,
        loader: 'js'
      }))
    }
  }],
  logLevel: 'silent'
})
const { AgentController } = await import(pathToFileURL(outfile).href)

const REFRESH_FAILED = 'OAuth refresh failed for anthropic: invalid_grant'

function controller(active, provider = 'anthropic') {
  const ctl = new AgentController({ push: () => {}, cwd: process.cwd(), activeAccountKey: async (p) => active.key === undefined ? undefined : `${p}:${active.key}` })
  ctl.state = { sessionId: 'session-account', sessionFile: join(root, 'sessions', 'account.jsonl'), cwd: process.cwd(), model: { provider, id: 'm' } }
  return ctl
}

console.log('\n--- 请求开始时记下账号，出错时用它 ---')
{
  const active = { key: 'X' }
  const ctl = controller(active)
  ctl.handleEvent({ type: 'turn_start' })
  active.key = 'Y'
  check(await ctl.failedAccountOf(REFRESH_FAILED) === 'anthropic:X', '会话另一处已换到 Y 后，出错账号仍是发请求时的 X')
  ctl.handleEvent({ type: 'turn_start' })
  check(await ctl.failedAccountOf(REFRESH_FAILED) === 'anthropic:Y', '下一次请求开始时重新记录当时的活动账号')
}

console.log('\n--- 记不到就不标记 ---')
{
  const active = { key: 'X' }
  const ctl = controller(active)
  check(ctl.failedAccountOf(REFRESH_FAILED) === undefined, '没有请求开始记录时不取当前账号顶替')
  active.key = undefined
  ctl.handleEvent({ type: 'turn_start' })
  check(await ctl.failedAccountOf(REFRESH_FAILED) === undefined, '请求开始时匹配不到账号则没有出错账号')
}

console.log('\n--- 反例 ---')
{
  const active = { key: 'X' }
  const ctl = controller(active)
  ctl.handleEvent({ type: 'turn_start' })
  check(ctl.failedAccountOf('503 Service Unavailable') === undefined, '不是刷新失败的错误不取出错账号')
  ctl.state.model = { provider: 'openai-codex', id: 'm' }
  check(ctl.failedAccountOf('OAuth refresh failed for openai-codex: invalid_grant') === undefined, '服务商与请求开始时不同则不使用旧记录')
  const failing = new AgentController({ push: () => {}, cwd: process.cwd(), activeAccountKey: async () => { throw new Error('store broken') } })
  failing.state = { sessionId: 's', model: { provider: 'anthropic', id: 'm' } }
  failing.handleEvent({ type: 'turn_start' })
  check(await failing.failedAccountOf(REFRESH_FAILED) === undefined, '读取账号失败时按没有出错账号处理')
  const bare = new AgentController({ push: () => {}, cwd: process.cwd() })
  bare.state = { sessionId: 's', model: { provider: 'anthropic', id: 'm' } }
  bare.handleEvent({ type: 'turn_start' })
  check(bare.failedAccountOf(REFRESH_FAILED) === undefined, '宿主没有提供账号查询时不报错也不标记')
}

console.log(`\n${checks} 项通过`)
