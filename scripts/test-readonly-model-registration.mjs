import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = await mkdtemp(join(tmpdir(), 'inkstone-readonly-model-'))
try {
  const path = join(temp, 'check.mjs')
  await build({ entryPoints: ['src/main/subagents/registered-model.ts'], outfile: path, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { confirmRegisteredModel: confirmReadOnlyRegisteredModel } = await import(pathToFileURL(path).href)
  const normalizePath = join(temp, 'normalize.mjs')
  await build({ entryPoints: ['src/shared/model-capabilities.ts'], outfile: normalizePath, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
  const { normalizeModelInfo } = await import(pathToFileURL(normalizePath).href)
  let checks = 0, calls = []
  const check = (condition, text) => { assert.ok(condition, text); checks += 1 }
  const rpc = { command: async (...args) => { calls.push(args); return { success: true } } }
  check(await confirmReadOnlyRegisteredModel(rpc, 'provider/model') === undefined, '注册模型成功时不改选其他模型')
  check(calls[0][0] === 'set_model' && calls[0][1].provider === 'provider' && calls[0][1].modelId === 'model' && calls[0][2].timeoutMs === 2000, '复用原生精确选择并设置超时')
  calls = []
  await confirmReadOnlyRegisteredModel(rpc, 'commandcode/deepseek/deepseek-v4.1-flash')
  check(calls[0][1].modelId === 'deepseek/deepseek-v4.1-flash', '模型 id 内的斜杠不会拆错 provider')
  const rejected = { command: async () => ({ success: false, error: 'Model not found' }) }
  const error = await confirmReadOnlyRegisteredModel(rejected, 'virtual/auto')
  check(error.includes('Model not found') && error.includes('未发送任务'), 'CLI 同名合成模型不被放行')
  check(error.startsWith('子任务') && !error.includes('不支持只读'), '普通指定模型缺注册也拒绝，但不误称只读')
  const readOnlyError = await confirmReadOnlyRegisteredModel(rejected, 'virtual/auto', { readOnly: true })
  check(readOnlyError.startsWith('只读子任务') && readOnlyError.includes('不支持只读'), '只读扩展缺失给出准确的能力说明')
  const apiRpc = api => ({ command: async type => type === 'get_state' ? { success: true, data: { model: { api } } } : { success: true } })
  check(await confirmReadOnlyRegisteredModel(apiRpc('pi-virtual'), 'virtual/auto', { expectedApi: 'pi-virtual' }) === undefined, '原生注册与来源API一致时放行')
  check(typeof await confirmReadOnlyRegisteredModel(apiRpc('openai-completions'), 'virtual/auto', { expectedApi: 'pi-virtual' }) === 'string', '已注册同名物理模型也不能冒充来源虚拟模型')
  check(typeof await confirmReadOnlyRegisteredModel(apiRpc(undefined), 'virtual/auto', { expectedApi: 'pi-virtual' }) === 'string', '缺少API身份时不猜')
  const source = normalizeModelInfo({ id: 'auto', provider: 'virtual', api: ' pi-virtual ' })
  check(source.api === 'pi-virtual', '正式来源模型归一化保留 API，去除外侧空白')
  check(normalizeModelInfo({ id: 'legacy' }).api === undefined, '旧原生响应缺 API 不猜')
  check(normalizeModelInfo({ id: 'bad', api: 123 }).api === undefined, '坏 API 类型不作为身份')
  check(normalizeModelInfo({ id: 'empty', api: '  ' }).api === undefined, '空 API 不作为身份')
  check(await confirmReadOnlyRegisteredModel(apiRpc(source.api), 'virtual/auto', { expectedApi: source.api }) === undefined, '来源归一化→原生状态 API 一致时放行')
  check(typeof await confirmReadOnlyRegisteredModel(apiRpc('openai-completions'), 'virtual/auto', { expectedApi: source.api }) === 'string', '来源归一化→已注册同名物理 API 不同仍拒绝')
  check(typeof await confirmReadOnlyRegisteredModel(apiRpc(undefined), 'virtual/auto', { expectedApi: source.api }) === 'string', '来源保留 API 后，原生状态缺 API 不能绕过校核')
  const failed = { command: async () => { throw new Error('timeout') } }
  check((await confirmReadOnlyRegisteredModel(failed, 'virtual/auto')).includes('timeout'), '读取或选择失败按未核对处理')
  const before = calls.length
  check(typeof await confirmReadOnlyRegisteredModel(rpc, 'unqualified') === 'string' && calls.length === before, '缺 provider 不猜身份、不发送选择')
  check(typeof await confirmReadOnlyRegisteredModel(rpc, 'provider/') === 'string', '空模型 id 不查询')
  console.log(`readonly-model-registration: ${checks} 项核对边界检查通过`)
} finally { await rm(temp, { recursive: true, force: true }) }
