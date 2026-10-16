/**
 * pi 原生 RPC 参数的定向检查（仅 `src/main/agent.ts` 的接线层）。
 *
 * 被测对象：AgentController 的「薄透传」方法在加入可选参数后，
 * 仍然保持既有无参调用的兼容，并且：
 *   · `compact(customInstructions?)` → 只在有内容时带 `customInstructions`
 *   · `exportHtml(outputPath?)`      → 只在有值时带 `outputPath`
 *   · `runBash(command, options?)`   → `excludeFromContext` 透传
 *   · `newSession(parentSession?)`   → `parentSession` 透传，取消/超时归成 `{ok:false}`
 *   · `sessionEntries(since?)`       → `since` 游标 + `leafId`，失败返回 `{ok:false,error}`
 *   · `sessionTree()`                → `get_tree` + `leafId`，失败返回 `{ok:false,error}`
 *   · 取消 / 超时 / pi 未就绪 / 正在运行 四种状态下都不抛
 *
 * 为什么这样测：这些方法本质是「把参数原样交给 pi 命令，再把响应翻译成结果对象」，
 * 真正的 pi 端行为由 RPC 文档与运行中的 pi 决定。这里用假 RPC 钉住**请求形状**
 * 与**结果翻译**，不需要模型、网络或 Electron。真实 pi/模型路径另由主会话验收。
 *
 * 用法：node scripts/test-pi-native-rpc-options.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

let checks = 0
const check = (condition, message, extra) => {
  assert.ok(condition, extra === undefined ? message : `${message}（${extra}）`)
  checks += 1
  console.log(`✓ ${message}`)
}
const deepEqual = (actual, expected, message) => {
  assert.deepEqual(actual, expected, `${message}：${JSON.stringify(actual)}`)
  checks += 1
  console.log(`✓ ${message}`)
}

const temp = await mkdtemp(join(tmpdir(), 'inkstone-pi-rpc-options-'))
/* paths.ts 在导入时就把 YAN_DIR / PI_AGENT_DIR 定死，必须先设环境变量。 */
process.env.YAN_DATA_DIR = join(temp, 'data')
process.env.YAN_PI_DIR = join(temp, 'pi')
await mkdir(join(temp, 'cwd'), { recursive: true })
await writeFile(join(temp, 'cwd', 'seed.txt'), 'seed\n')

const outfile = join(process.cwd(), 'out', 'test', 'agent-native-rpc-options.mjs')
try {
  await build({
    stdin: {
      contents: `export { AgentController } from './src/main/agent'`,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*'],
    plugins: [
      {
        name: 'rpc-options-electron-boundary',
        setup(builder) {
          builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'rpc-electron' }))
          builder.onLoad({ filter: /.*/, namespace: 'rpc-electron' }, () => ({
            contents: `
              export class BrowserWindow { constructor() { throw new Error('Native browser requires an Electron integration test') } }
              export const session = { fromPartition() { throw new Error('Native session requires an Electron integration test') } }
              /*
               * agent.ts → settings.ts 只用到 app.getLocale() 与
               * app.getPath('documents')。路径固定落在隔离目录
               * （YAN_TEST_APP_DIR → YAN_DATA_DIR → 系统临时目录），
               * 绝不返回用户真实 AppData / Documents；不导入真实 Electron。
               */
              export const app = {
                getLocale: () => 'zh-CN',
                getPath: (name) => {
                  const root = process.env.YAN_TEST_APP_DIR || process.env.YAN_DATA_DIR || (process.env.TEMP || process.env.TMPDIR || '/tmp') + '/inkstone-pi-rpc-options-app'
                  return root + '/' + (name || 'documents')
                }
              }
            `,
            loader: 'js'
          }))
        }
      }
    ],
    logLevel: 'silent'
  })

  const { AgentController } = await import(pathToFileURL(outfile).href)

  /**
   * 假 RPC：记录每次 command 的 (type, payload, opts)，按 `fail` / `reject`
   * 注入逻辑失败与超时，其余给最小可用的成功响应。
   */
  const fakeRpc = (script = {}) => {
    const calls = []
    const fail = script.fail ?? {}
    const reject = script.reject ?? {}
    const data = script.data ?? {}
    return {
      calls,
      command(type, payload = {}, opts = {}) {
        calls.push({ type, payload, opts })
        if (reject[type]) {
          return Promise.reject(typeof reject[type] === 'string' ? new Error(reject[type]) : reject[type])
        }
        if (fail[type]) return Promise.resolve({ success: false, error: fail[type] })
        switch (type) {
          case 'get_state':
            return Promise.resolve({ success: true, data: data.get_state ?? { sessionId: 's-1', thinkingLevel: 'off' } })
          case 'get_messages':
            return Promise.resolve({ success: true, data: { messages: [] } })
          case 'get_session_stats':
            return Promise.resolve({ success: true, data: {} })
          case 'get_entries':
            return Promise.resolve({ success: true, data: data.get_entries ?? { entries: [{ id: 'e1', type: 'message' }], leafId: 'e1' } })
          case 'get_tree':
            return Promise.resolve({ success: true, data: data.get_tree ?? { tree: [{ entry: { id: 'e1' }, children: [] }], leafId: 'e1' } })
          case 'export_html':
            return Promise.resolve({ success: true, data: { path: data.export_html ?? '/tmp/session.html' } })
          case 'new_session':
            return Promise.resolve({ success: true, data: { cancelled: false } })
          case 'bash':
            return Promise.resolve({ success: true, data: { output: 'ok', exitCode: 0, cancelled: false } })
          default:
            return Promise.resolve({ success: true, data: {} })
        }
      },
      respondUi() {},
      close() {
        return Promise.resolve()
      },
      running: true
    }
  }

  const lastCall = (rpc, type) => [...rpc.calls].reverse().find((call) => call.type === type)
  const fresh = (script) => {
    const agent = new AgentController({ push: () => {}, cwd: join(temp, 'cwd') })
    const rpc = fakeRpc(script)
    agent.rpc = rpc
    return { agent, rpc }
  }

  console.log('\n--- 1. sessionEntries：游标与失败翻译 ---')
  {
    const { agent, rpc } = fresh()
    const res = await agent.sessionEntries()
    deepEqual(res, { ok: true, entries: [{ id: 'e1', type: 'message' }], leafId: 'e1' }, '无参：返回 entries + leafId')
    check(!('since' in lastCall(rpc, 'get_entries').payload), '无参：payload 不带 since')

    const withCursor = await agent.sessionEntries('entry-9')
    check(withCursor.ok === true, '带 since：成功')
    deepEqual(lastCall(rpc, 'get_entries').payload, { since: 'entry-9' }, '带 since：payload 透传 since')
    deepEqual(withCursor.entries, [{ id: 'e1', type: 'message' }], '带 since：仍返回 entries')
  }
  {
    const { agent } = fresh({ fail: { get_entries: 'Entry not found: nope' } })
    const res = await agent.sessionEntries('nope')
    deepEqual(res, { ok: false, error: 'Entry not found: nope' }, '逻辑失败：原样返回 {ok:false,error}')
  }
  {
    const { agent } = fresh({ reject: { get_entries: '命令 get_entries 超时（30000ms）' } })
    const res = await agent.sessionEntries()
    deepEqual(res, { ok: false, error: '命令 get_entries 超时（30000ms）' }, '超时：不抛，返回 {ok:false,error}')
  }

  console.log('\n--- 2. sessionTree：透传与失败翻译 ---')
  {
    const { agent, rpc } = fresh()
    const res = await agent.sessionTree()
    deepEqual(res, { ok: true, tree: [{ entry: { id: 'e1' }, children: [] }], leafId: 'e1' }, '成功：返回 tree + leafId')
    const call = lastCall(rpc, 'get_tree')
    check(call !== undefined && Object.keys(call.payload).length === 0, 'get_tree 不带参数')
  }
  {
    const { agent } = fresh({ fail: { get_tree: 'boom' } })
    deepEqual(await agent.sessionTree(), { ok: false, error: 'boom' }, '逻辑失败：{ok:false,error}')
  }
  {
    const { agent } = fresh({ reject: { get_tree: 'pi 进程已退出' } })
    deepEqual(await agent.sessionTree(), { ok: false, error: 'pi 进程已退出' }, '进程退出：不抛')
  }

  console.log('\n--- 3. compact：customInstructions 兼容 ---')
  {
    const { agent, rpc } = fresh()
    deepEqual(await agent.compact(), { ok: true }, '无参：成功')
    deepEqual(lastCall(rpc, 'compact').payload, {}, '无参：payload 为空（兼容旧调用）')

    deepEqual(await agent.compact('  Focus on code changes  '), { ok: true }, '带指令：成功')
    deepEqual(lastCall(rpc, 'compact').payload, { customInstructions: 'Focus on code changes' }, '带指令：trim 后透传 customInstructions')

    deepEqual(await agent.compact('   '), { ok: true }, '纯空白：成功')
    deepEqual(lastCall(rpc, 'compact').payload, {}, '纯空白：视作无指令')
  }
  {
    const { agent } = fresh({ reject: { compact: '命令 compact 超时（300000ms）' } })
    deepEqual(await agent.compact('x'), { ok: false, error: '命令 compact 超时（300000ms）' }, '超时：不抛')
  }

  console.log('\n--- 4. exportHtml：outputPath 兼容 ---')
  {
    const { agent, rpc } = fresh()
    deepEqual(await agent.exportHtml(), { ok: true, path: '/tmp/session.html' }, '无参：成功')
    deepEqual(lastCall(rpc, 'export_html').payload, {}, '无参：payload 为空（兼容旧调用）')

    deepEqual(await agent.exportHtml('/tmp/custom.html'), { ok: true, path: '/tmp/session.html' }, '带路径：成功')
    deepEqual(lastCall(rpc, 'export_html').payload, { outputPath: '/tmp/custom.html' }, '带路径：透传 outputPath')
  }
  {
    const { agent } = fresh({ fail: { export_html: '导出失败' } })
    deepEqual(await agent.exportHtml(), { ok: false, error: '导出失败' }, '逻辑失败：{ok:false,error}')
  }
  {
    const { agent } = fresh({ reject: { export_html: '命令 export_html 超时（30000ms）' } })
    deepEqual(await agent.exportHtml(), { ok: false, error: '命令 export_html 超时（30000ms）' }, '超时：不抛')
  }

  console.log('\n--- 5. runBash：excludeFromContext 兼容 ---')
  {
    const { agent, rpc } = fresh()
    deepEqual(await agent.runBash('echo hi'), { ok: true }, '无参：成功')
    deepEqual(lastCall(rpc, 'bash').payload, { command: 'echo hi' }, '无参：payload 不带 excludeFromContext')

    deepEqual(await agent.runBash('echo hi', { excludeFromContext: true }), { ok: true }, 'true：成功')
    deepEqual(lastCall(rpc, 'bash').payload, { command: 'echo hi', excludeFromContext: true }, 'true：透传 excludeFromContext')

    deepEqual(await agent.runBash('echo hi', { excludeFromContext: false }), { ok: true }, 'false：成功')
    deepEqual(lastCall(rpc, 'bash').payload, { command: 'echo hi', excludeFromContext: false }, 'false：显式透传 false')
  }

  console.log('\n--- 6. newSession：parentSession、取消、超时 ---')
  {
    const { agent, rpc } = fresh()
    deepEqual(await agent.newSession(), { ok: true }, '无参：成功')
    deepEqual(lastCall(rpc, 'new_session').payload, {}, '无参：payload 为空（兼容旧调用）')

    deepEqual(await agent.newSession('/sessions/parent.jsonl'), { ok: true }, '带父会话：成功')
    deepEqual(lastCall(rpc, 'new_session').payload, { parentSession: '/sessions/parent.jsonl' }, '带父会话：透传 parentSession')
  }
  {
    const { agent } = fresh({ data: { get_state: { sessionId: 's-1' } } })
    /* 直接改 fake 的 new_session 响应以模拟扩展取消。 */
    agent.rpc.command = ((original) => (type, payload, opts) =>
      type === 'new_session'
        ? Promise.resolve({ success: true, data: { cancelled: true } })
        : original(type, payload, opts))(agent.rpc.command.bind(agent.rpc))
    deepEqual(await agent.newSession(), { ok: false, error: '会话切换被扩展取消' }, '扩展取消：{ok:false,error}')
  }
  {
    const { agent } = fresh({ reject: { new_session: '命令 new_session 超时（30000ms）' } })
    deepEqual(await agent.newSession(), { ok: false, error: '命令 new_session 超时（30000ms）' }, '超时：不抛')
  }

  console.log('\n--- 7. 内部 sessionEntriesLite 改名后行为不变 ---')
  {
    const { agent } = fresh({
      data: {
        get_entries: {
          entries: [
            { id: 'c1', type: 'custom', customType: 'todos', data: { items: [] } },
            { id: 'm1', type: 'message', message: { role: 'user' } }
          ],
          leafId: 'm1'
        }
      }
    })
    const custom = await agent.getCustomEntries()
    deepEqual(custom, [{ id: 'c1', customType: 'todos', data: { items: [] } }], 'getCustomEntries 仍走内部读取并过滤 custom 条目')
  }

  console.log('\n--- 8. pi 未就绪：全部返回 {ok:false}，不抛 ---')
  {
    const agent = new AgentController({ push: () => {}, cwd: join(temp, 'cwd') })
    deepEqual(await agent.sessionEntries(), { ok: false, error: 'pi 尚未就绪' }, 'sessionEntries：pi 未就绪')
    deepEqual(await agent.sessionTree(), { ok: false, error: 'pi 尚未就绪' }, 'sessionTree：pi 未就绪')
    deepEqual(await agent.exportHtml(), { ok: false, error: 'pi 尚未就绪' }, 'exportHtml：pi 未就绪')
    deepEqual(await agent.compact(), { ok: false, error: 'pi 尚未就绪' }, 'compact：pi 未就绪')
    deepEqual(await agent.runBash('echo hi'), { ok: false, error: 'pi 尚未就绪' }, 'runBash：pi 未就绪')
    deepEqual(await agent.newSession(), { ok: false, error: 'pi 尚未就绪' }, 'newSession：pi 未就绪')
  }

  console.log('\n--- 9. 正在运行：读取/导出类命令不被状态门挡住 ---')
  {
    const { agent, rpc } = fresh()
    agent.agentRunning = true
    agent.state = { ...(agent.state ?? {}), isStreaming: true, isAgentRunning: true }
    deepEqual(await agent.sessionEntries(), { ok: true, entries: [{ id: 'e1', type: 'message' }], leafId: 'e1' }, '运行中：sessionEntries 仍可读')
    deepEqual(await agent.sessionTree(), { ok: true, tree: [{ entry: { id: 'e1' }, children: [] }], leafId: 'e1' }, '运行中：sessionTree 仍可读')
    deepEqual(await agent.exportHtml(), { ok: true, path: '/tmp/session.html' }, '运行中：exportHtml 仍可用')
    check(rpc.calls.some((call) => call.type === 'get_entries'), '运行中确实发出了 get_entries')
  }

  console.log(`\nPASS: ${checks} checks；pi 原生 RPC 参数透传与失败翻译（无模型 / 无网络 / 无 Electron）`)
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => undefined)
}
