import { EventEmitter } from 'node:events'
import { runSuite } from './lib/test-suite.mjs'

function fakeRpcFactory(plan) {
  const made = []
  const create = (opts) => {
    const rpc = new EventEmitter()
    const record = { opts, commands: [], closed: false, rpc }
    made.push(record)
    rpc.spawn = () => {
      if (plan.spawnError) setTimeout(() => rpc.emit('spawn-error', new Error(plan.spawnError)), 1)
    }
    rpc.close = async () => { record.closed = true }
    rpc.command = async (type, payload = {}) => {
      record.commands.push({ type, ...payload })
      if (type === 'get_state') return { success: plan.ready !== false }
      if (type === 'set_thinking_level') return { success: true }
      if (type === 'prompt') {
        if (plan.promptError) return { success: false, error: plan.promptError }
        const events = plan.events ?? []
        setTimeout(() => {
          for (const event of events) rpc.emit('event', event)
          if (plan.exitAfter) rpc.emit('exit', 1, null)
        }, plan.delay ?? 2)
        return { success: true }
      }
      return { success: true }
    }
    return rpc
  }
  return { made, create }
}

const delta = (text) => ({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
const end = (message) => ({ type: 'message_end', message: { role: 'assistant', ...message } })
const settled = { type: 'agent_settled' }

await runSuite(import.meta.url, async (ok, compile) => {
  const { callModel, modelCallArgs, modelCallTimeout, ModelCallError, MODEL_CALL_DEFAULT_TIMEOUT_MS, MODEL_CALL_MAX_TIMEOUT_MS } = await compile('src/main/model-call.ts')
  const runtime = (plan) => {
    const factory = fakeRpcFactory(plan)
    return { factory, runtime: { cwd: 'C:/data', env: { PI_CODING_AGENT_DIR: 'C:/pi' }, createRpc: factory.create, readyPollMs: 1 } }
  }

  ok(MODEL_CALL_DEFAULT_TIMEOUT_MS === 300_000 && MODEL_CALL_MAX_TIMEOUT_MS === 1_800_000, '默认超时 5 分钟、上限 30 分钟')
  ok(modelCallTimeout(undefined) === 300_000 && modelCallTimeout(10_000_000) === 1_800_000 && modelCallTimeout(500) === 1000, '超时按上下限收拢')
  const args = modelCallArgs({ model: 'fake/m1', system: '你是译者', prompt: 'x' })
  ok(['--no-session', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates', '--no-tools'].every((flag) => args.includes(flag)), '裸 pi：不加载会话、扩展、上下文文件、技能、模板和工具', args.join(' '))
  ok(args[args.indexOf('--model') + 1] === 'fake/m1' && args[args.indexOf('--system-prompt') + 1] === '你是译者', '模型与系统提示词进 pi 参数')

  {
    const { factory, runtime: rt } = runtime({ events: [delta('你'), delta('好'), end({ provider: 'fake', model: 'm1', stopReason: 'stop', usage: { input: 12, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 16, cost: { total: 0.002 } } }), settled] })
    const result = await callModel({ model: 'fake/m1', prompt: '说你好', thinking: 'high' }, rt)
    ok(result.text === '你好' && result.model === 'fake/m1' && result.stopReason === 'stop', '返回文本、实际模型与 stopReason', JSON.stringify(result))
    ok(result.usage?.input === 12 && result.usage.output === 3 && result.usage.totalTokens === 16 && result.usage.cost === 0.002, '带回 token 用量与费用', JSON.stringify(result.usage))
    const commands = factory.made[0].commands
    ok(commands.some((c) => c.type === 'set_thinking_level' && c.level === 'high') && commands.some((c) => c.type === 'prompt' && c.message === '说你好'), '思考档与提示词经 RPC 发出', JSON.stringify(commands))
    ok(factory.made[0].closed && factory.made[0].opts.cwd === 'C:/data' && factory.made[0].opts.env.PI_CODING_AGENT_DIR === 'C:/pi', '用完关闭 pi 进程；凭据目录由调用方给定')
  }

  {
    const { factory, runtime: rt } = runtime({ events: [delta('x'), end({ stopReason: 'stop' }), settled] })
    await callModel({ model: 'fake/m1', prompt: 'p' }, rt)
    ok(factory.made[0].commands.some((c) => c.type === 'set_thinking_level' && c.level === 'off'), '没给 thinking 时关闭思考（与插件路径一致）')
  }

  {
    const message = '429 You exceeded your current quota, please check your plan and billing details.'
    const { runtime: rt } = runtime({ events: [end({ stopReason: 'error', errorMessage: message }), settled] })
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p' }, rt) } catch (e) { error = e }
    ok(error instanceof ModelCallError && error.kind === 'model' && error.message.includes('exceeded your current quota'), '模型报错原样带回，不吞掉', String(error?.message))
  }

  {
    const { runtime: rt } = runtime({ events: [end({ stopReason: 'error', errorMessage: '401 Incorrect API key provided: sk-live-abcdef123456' }), settled] })
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p' }, rt) } catch (e) { error = e }
    ok(/Incorrect API key provided/.test(error?.message) && !/sk-live-abcdef123456/.test(error?.message), '报错里的密钥被遮掉，其余原样保留', String(error?.message))
  }

  {
    const { runtime: rt } = runtime({ promptError: 'No API key found for fake' })
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p', timeoutMs: 5000 }, rt) } catch (e) { error = e }
    ok(error?.kind === 'model' && /No API key found/.test(error.message), 'prompt 命令被 pi 拒绝时立即带回原因，不等到超时', String(error?.message))
  }

  {
    const { factory, runtime: rt } = runtime({ events: [] })
    const started = Date.now()
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p', timeoutMs: 1000 }, rt) } catch (e) { error = e }
    ok(error?.kind === 'timeout' && Date.now() - started < 3000 && factory.made[0].closed, '超时可配置，到点失败并关闭进程', `${error?.kind} ${Date.now() - started}ms`)
  }

  {
    const { factory, runtime: rt } = runtime({ events: [] })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p', signal: controller.signal }, rt) } catch (e) { error = e }
    ok(error?.kind === 'cancelled' && factory.made[0].closed, '外部取消立即结束并关闭进程')
  }

  {
    const { runtime: rt } = runtime({ events: [], exitAfter: true })
    rt.createRpc = ((create) => (opts) => {
      const rpc = create(opts)
      const spawn = rpc.spawn
      rpc.spawn = () => {
        spawn()
        setTimeout(() => rpc.emit('stderr', 'Model "nope" not found'), 1)
      }
      return rpc
    })(rt.createRpc)
    let error
    try { await callModel({ model: 'fake/nope', prompt: 'p' }, rt) } catch (e) { error = e }
    ok(error?.kind === 'empty' && /not found/.test(error.message), 'pi 没回文本就退出时带上 stderr 末尾', String(error?.message))
  }

  {
    const { runtime: rt } = runtime({ events: [delta('x'.repeat(50)), settled] })
    let error
    try { await callModel({ model: 'fake/m1', prompt: 'p', maxOutputChars: 10 }, rt) } catch (e) { error = e }
    ok(error?.kind === 'too-long', '输出超过上限时失败')
  }

  {
    let error
    try { await callModel({ model: '', prompt: 'p' }, runtime({}).runtime) } catch (e) { error = e }
    ok(error?.kind === 'invalid', '缺模型时拒绝调用')
    try { await callModel({ model: 'a/b', prompt: 'p', thinking: 'ultra' }, runtime({}).runtime) } catch (e) { error = e }
    ok(error?.kind === 'invalid' && /thinking/.test(error.message), '思考档只接受 pi 支持的值')
  }
})
