import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { runSuite } from './lib/test-suite.mjs'

const electronStub = {
  name: 'electron-stub',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
      loader: 'js',
      contents: [
        'export const shell = { openPath: async () => "" }',
        'export const app = { getPath: () => process.env.YAN_DATA_DIR, getLocale: () => "zh-CN", isPackaged: false, getVersion: () => "0.0.0" }',
        'export const dialog = { showMessageBox: async () => ({ response: 1 }) }',
        'export const ipcMain = { handle: () => undefined }',
        'export const BrowserWindow = class {}',
        'export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (value) => Buffer.from(String(value)), decryptString: (value) => Buffer.from(value).toString() }',
        'export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }',
        'export const session = { defaultSession: {}, fromPartition: () => ({ setPermissionRequestHandler: () => undefined, setPermissionCheckHandler: () => undefined }) }'
      ].join('\n')
    }))
  }
}

await runSuite(import.meta.url, async (ok) => {
  const root = await mkdtemp(join(tmpdir(), 'yan-notice-steer-'))
  try {
    const entry = join(root, 'entry.ts')
    const outfile = join(root, 'agent.mjs')
    const source = fileURLToPath(new URL('../src/main/agent.ts', import.meta.url)).replace(/\\/g, '/')
    await writeFile(entry, `export { AgentController } from '${source}'`)
    await build({ entryPoints: [entry], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'], plugins: [electronStub] })
    const { AgentController } = await import(pathToFileURL(outfile).href)

    const make = ({ running = true, fromUser = true, beforeCommit } = {}) => {
      const agent = Object.create(AgentController.prototype)
      const submitted = []
      agent.agentRunning = running
      agent.runFromUser = fromUser
      agent.rpc = { running: true }
      agent.state = { sessionId: 's1' }
      agent.capabilityOpts = { runnerGeneration: 1 }
      agent.queue = {
        run: async (fn) => { await beforeCommit?.(agent); return fn() },
        payload: (item) => ({ message: item.text }),
        submit: async (command, text) => { submitted.push({ command, text }); return { success: true } }
      }
      return { agent, submitted }
    }

    const live = make()
    const delivered = await live.agent.steerIntoUserRun('<subagent-notification id="sub-1" status="interrupted">\nx\n</subagent-notification>')
    ok(delivered.ok && live.submitted.length === 1 && live.submitted[0].command === 'steer', '用户发起的一轮正在运行：用 steer 命令插话（pi 的 steer 只排队，不开新一轮）', JSON.stringify(live.submitted))

    const ended = make({ beforeCommit: (agent) => { agent.agentRunning = false } })
    const raced = await ended.agent.steerIntoUserRun('notice')
    ok(!raced.ok && raced.idle === true && ended.submitted.length === 0, '排队等待期间这一轮结束：提交前再查一次，空闲就失败、不提交', JSON.stringify(raced))

    const auto = make({ fromUser: false })
    const skipped = await auto.agent.steerIntoUserRun('notice')
    ok(!skipped.ok && skipped.idle === true && auto.submitted.length === 0, '宿主自发的一轮（额度续跑、通知触发）不附')
    ok(!make({ running: false }).agent.userRunActive() && make().agent.userRunActive() && !make({ fromUser: false }).agent.userRunActive(), 'userRunActive 只在用户发起且正在运行时为真')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, { isolate: true })
