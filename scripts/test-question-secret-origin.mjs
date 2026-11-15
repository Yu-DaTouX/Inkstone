import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSuite } from './lib/test-suite.mjs'

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(process.cwd(), 'resources', 'yan-cli', 'yan.mjs'), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout }))
  })
}

await runSuite(import.meta.url, async (ok, compile) => {
  const { CapabilityServer, CAPABILITY_API_VERSION } = await compile('src/main/capability-server.ts')
  const { questionToolCallId } = await compile('src/main/ui-requests.ts', { external: ['electron'] })
  const work = await mkdtemp(join(tmpdir(), 'yan-secret-origin-'))
  const secret = 'hunter2-plain-value'
  const received = []
  const server = new CapabilityServer({
    opsDir: join(work, 'ops'),
    toolBacked: { 'tasks.apply': 'This session has the todos tool' },
    handlers: {
      async run(command, params) {
        received.push(params)
        return { summary: { ran: command }, ...(command === 'question.ask' ? { secrets: { YAN_SECRET_VALUE: secret } } : {}) }
      }
    }
  })
  const endpoint = await server.start({ sessionId: 's', projectId: 'p' })
  const rpc = async (command, params, headers = {}) => (await fetch(endpoint.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ apiVersion: CAPABILITY_API_VERSION, sessionId: 's', projectId: 'p', command, params })
  })).json()
  try {
    ok(typeof endpoint.toolToken === 'string' && endpoint.toolToken.length >= 16 && endpoint.toolToken !== endpoint.token, '工具通道有独立于 CLI token 的凭据')

    received.length = 0
    const forged = await rpc('question.ask', { question: 'pw?', fields: [{ name: 'pw', label: 'pw', kind: 'secret' }], toolCall: { id: 'x', cwd: '', subagent: false } })
    ok(received[0] && !('toolCall' in received[0]), 'CLI 伪造的 toolCall 不会传给命令处理', JSON.stringify(received[0]))
    ok(!JSON.stringify(forged).includes(secret) && forged.secrets === undefined, 'CLI 通道的响应不带密文', JSON.stringify(forged))

    const wrong = await rpc('question.ask', { question: 'pw?', toolCall: { id: 'x' } }, { 'x-yan-tool-token': 'guess' })
    ok(wrong.secrets === undefined && !('toolCall' in received.at(-1)), '猜错工具凭据同样按 CLI 处理')

    received.length = 0
    const viaTool = await rpc('question.ask', { question: 'pw?', toolCall: { id: 'tc-1', cwd: '', subagent: false } }, { 'x-yan-tool-token': endpoint.toolToken })
    ok(received[0]?.toolCall?.id === 'tc-1', '工具通道的 toolCall 照常传给命令处理')
    ok(viaTool.secrets?.YAN_SECRET_VALUE === secret, '工具通道仍能拿到密文交给扩展')

    const forgedTasks = await rpc('tasks.apply', { items: [], toolCall: { id: 'x' } })
    ok(forgedTasks.ok === false && forgedTasks.code === 'command_use_tool', '伪造 toolCall 绕不过「改用工具」的闸门')
    const toolTasks = await rpc('tasks.apply', { items: [], toolCall: { id: 'tc-2' } }, { 'x-yan-tool-token': endpoint.toolToken })
    ok(toolTasks.ok === true, '工具通道的 tasks.apply 照常放行')
  } finally {
    server.stop()
  }

  ok(questionToolCallId({ toolCall: { id: 'call_n' } }) === 'call_n', 'toolCallId 取自工具通道的 toolCall.id')
  ok(questionToolCallId({ toolCallId: 'forged' }) === undefined, '顶层 toolCallId 不再当作工具来源')

  process.env.YAN_TOOL_TOKEN = 'tool-token-early'
  const tokenExtension = await import(new URL('../resources/pi-extensions/host-tool-token.js', import.meta.url))
  ok(process.env.YAN_TOOL_TOKEN === undefined, '取令牌的扩展加载后就从进程环境移走工具凭据，bash 子进程拿不到')
  process.env.YAN_TOOL_TOKEN = 'tool-token-fixture'
  tokenExtension.default({ on() {} })
  ok(process.env.YAN_TOOL_TOKEN === undefined, '扩展工厂（含重载）再次移走工具凭据')
  const hostTools = await import(new URL('../resources/pi-extensions/host-tool-call.js', import.meta.url))
  const seen = []
  const env = { YAN_RUNNER_ID: 'primary', YAN_CLI_URL: 'http://127.0.0.1:1/', YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's1', YAN_PROJECT_ID: 'p1' }
  await hostTools.callHostTool({ command: 'question.ask', params: {}, toolCallId: 'c', env, fetchImpl: async (_url, init) => { seen.push(init); return { json: async () => ({ ok: true, summary: {} }) } } })
  ok(seen[0]?.headers?.['x-yan-tool-token'] === 'tool-token-fixture', '宿主工具调用带上移走前保存的工具凭据')

  const indexSource = await readFile('src/main/index.ts', 'utf8')
  const agentSource = await readFile('src/main/agent.ts', 'utf8')
  ok(/hostToolTokenExtension: 'host-tool-token\.js'/.test(indexSource), '取令牌扩展登记在薄层清单里')
  ok(/'--no-extensions',\s*\.\.\.\(this\.hostToolTokenExtension \? \['--extension', this\.hostToolTokenExtension\] : \[\]\),/.test(agentSource), '取令牌扩展排在所有扩展最前面，不依赖 question / capability-guide 加载成功')
  ok(/YAN_TOOL_TOKEN: this\.yanCliEnv\.toolToken/.test(agentSource) && /this\.yanCliEnv\.toolToken && this\.hostToolTokenExtension &&/.test(agentSource), '没有取令牌扩展时不下发工具凭据')

  process.env.YAN_DATA_DIR = join(work, 'data')
  process.env.YAN_PI_DIR = join(work, 'pi')
  process.env.YAN_ATTACHMENTS_DIR = join(work, 'attachments')
  const { AgentController } = await compile('src/main/agent.ts', {
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [{
      name: 'electron-stub',
      setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
        builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
          loader: 'js',
          contents: `export class BrowserWindow {}
            export const session = { fromPartition() {} }
            export const app = { getLocale: () => 'zh-CN', getPath: () => process.env.YAN_DATA_DIR, getVersion: () => '0.0.0', isPackaged: false }
            export const nativeImage = { createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) }
            export const safeStorage = { isEncryptionAvailable: () => false }`
        }))
      }
    }]
  })
  const ctl = new AgentController({ push: () => {}, cwd: work })
  ctl.rpc = { running: true, launchOptions: { cwd: work, piBin: 'pi', args: ['--extension', 'x.js'], env: { YAN_CLI_TOKEN: 'cli', YAN_TOOL_TOKEN: 'tool-secret', YAN_SESSION_ID: 's' } } }
  ctl.state = { sessionId: 's', sessionFile: join(work, 's.jsonl'), model: { provider: 'p', id: 'm', contextWindow: 1000 }, thinkingLevel: 'high' }
  const fork = ctl.forkSource()
  ok(typeof fork === 'object' && fork.env.YAN_CLI_TOKEN === 'cli' && fork.env.YAN_SESSION_ID === 's', 'fork 子代理沿用来源会话的启动环境', JSON.stringify(fork))
  ok(typeof fork === 'object' && !('YAN_TOOL_TOKEN' in fork.env), 'fork 子代理的启动环境不带父会话的工具凭据', JSON.stringify(fork))

  const trap = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      const text = JSON.stringify({ ok: true, summary: { kind: 'question' }, secrets: { YAN_SECRET_VALUE: secret } })
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    })
  })
  await new Promise((resolve) => trap.listen(0, '127.0.0.1', resolve))
  try {
    const request = join(work, 'q.json')
    await writeFile(request, JSON.stringify({ question: 'pw?' }))
    const cliEnv = { ...process.env, YAN_CLI_URL: `http://127.0.0.1:${trap.address().port}/rpc`, YAN_CLI_TOKEN: 't', YAN_SESSION_ID: 's', YAN_PROJECT_ID: 'p' }
    delete cliEnv.YAN_TOOL_BACKED
    const out = await runCli(['question', 'ask', '--request-file', request], cliEnv)
    ok(out.status === 0 && !out.stdout.includes(secret), 'yan CLI 打印前剔除 secrets', out.stdout)
  } finally {
    trap.close()
    await rm(work, { recursive: true, force: true })
  }
})
