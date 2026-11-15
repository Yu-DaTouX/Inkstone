import { pick } from '../../shared/ui-lang'
import { createHash } from 'node:crypto'
import { Script, createContext, runInContext } from 'node:vm'
import { normalizeAgentCall, type WorkflowAgentOptions } from './agent-options'
import type { IoLine } from './journal'
import { normalizeModelCall, type WorkflowModelOptions } from './model-options'
import type { ProjectFiles } from './project-files'
import { WORKFLOW_SCRIPT_FILENAME, wrapWorkflowCode } from './script'

export type AgentReply = { ok: true; json: string } | { ok: false; stopped?: boolean; error: string }

export interface SandboxHost {
  agent(seq: number, prompt: string, options: WorkflowAgentOptions): Promise<AgentReply>
  model?(seq: number, prompt: string, options: WorkflowModelOptions): Promise<AgentReply>
  files?: ProjectFiles
  io?(line: Omit<IoLine, 'kind' | 'attempt' | 'at'>): void
  phase(title: string): void
  log(text: string): void
  fatal(message: string): void
}

export interface SandboxInput {
  code: string
  argsJson?: string
  maxAgents: number
  maxItems: number
  maxModels?: number
}

export type SandboxOutcome = { ok: true; json: string } | { ok: false; error: string }

const PRELUDE = `(function install(host) {
  'use strict'
  const RealDate = Date
  const block = (what) => host.fatal(what + ' is not available in workflow scripts, so that a resumed run repeats the same agent() calls; pass timestamps or seeds in through args')
  function WorkflowDate(...values) {
    if (!new.target) block('Date()')
    if (values.length === 0) block('new Date()')
    return Reflect.construct(RealDate, values, new.target)
  }
  WorkflowDate.prototype = RealDate.prototype
  Object.defineProperty(RealDate.prototype, 'constructor', { value: WorkflowDate, writable: true, configurable: true })
  Object.defineProperty(WorkflowDate, 'UTC', { value: RealDate.UTC })
  Object.defineProperty(WorkflowDate, 'parse', { value: RealDate.parse })
  Object.defineProperty(WorkflowDate, 'now', { value: () => block('Date.now()') })
  Object.defineProperty(globalThis, 'Date', { value: WorkflowDate, writable: false, configurable: false, enumerable: false })
  Object.defineProperty(Math, 'random', { value: () => block('Math.random()'), writable: false, configurable: false })
  const settle = (value) => Promise.resolve(value).then((result) => (result === undefined ? null : result), () => null)
  const listOf = (value, name) => {
    if (value === null || value === undefined || typeof value[Symbol.iterator] !== 'function' || typeof value === 'string') throw new TypeError(name + '() needs an array')
    const items = Array.from(value)
    if (items.length > host.maxItems) host.fatal(name + '() got ' + items.length + ' items; a single parallel()/pipeline() call takes at most ' + host.maxItems + '. Split the list into batches.')
    return items
  }
  function agent(prompt, options) {
    return host.agent(prompt, options)
  }
  function parallel(tasks) {
    const items = listOf(tasks, 'parallel')
    return Promise.all(items.map((task) => {
      try {
        return settle(typeof task === 'function' ? task() : task)
      } catch {
        return null
      }
    }))
  }
  function pipeline(list, fn) {
    if (typeof fn !== 'function') throw new TypeError('pipeline(items, fn) needs a function as the second argument')
    const items = listOf(list, 'pipeline')
    return Promise.all(items.map((item, index) => {
      try {
        return settle(fn(item, index))
      } catch {
        return null
      }
    }))
  }
  function model(prompt, options) {
    return host.model(prompt, options)
  }
  function readText(path) {
    return new Promise((resolve) => resolve(host.readText(path)))
  }
  function writeText(path, text) {
    return new Promise((resolve) => resolve(host.writeText(path, text)))
  }
  function listFiles(dir, glob) {
    return new Promise((resolve) => resolve(host.listFiles(dir, glob)))
  }
  function phase(title) {
    host.phase(String(title))
  }
  function log(text) {
    host.log(typeof text === 'string' ? text : JSON.stringify(text))
  }
  return { agent, model, readText, writeText, listFiles, parallel, pipeline, phase, log }
})`

function describeError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const message = String((error as { message?: unknown }).message ?? error)
  const stack = String((error as { stack?: unknown }).stack ?? '')
  const line = new RegExp(`${WORKFLOW_SCRIPT_FILENAME}:(\\d+)`).exec(stack)?.[1]
  return line ? `${message}（${WORKFLOW_SCRIPT_FILENAME} 第 ${line} 行）` : message
}

export async function runWorkflowSandbox(input: SandboxInput, host: SandboxHost): Promise<SandboxOutcome> {
  const context = createContext({}, { name: 'workflow', codeGeneration: { strings: false, wasm: false } })
  const parse = runInContext('JSON.parse', context) as (text: string) => unknown
  const SandboxError = runInContext('Error', context) as ErrorConstructor
  let seq = 0
  let modelSeq = 0
  const maxModels = input.maxModels ?? 0
  let fatal: string | null = null
  const fail = (message: string): never => {
    if (!fatal) {
      fatal = message
      host.fatal(message)
    }
    throw new SandboxError(message)
  }
  const bridge = {
    maxItems: input.maxItems,
    fatal: (message: string) => fail(message),
    phase: (title: string) => host.phase(title.slice(0, 120)),
    log: (text: string) => host.log(String(text).slice(0, 500)),
    agent: (prompt: unknown, options: unknown) => {
      let call: ReturnType<typeof normalizeAgentCall>
      try {
        call = normalizeAgentCall(prompt, options)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      if (seq >= input.maxAgents) fail(`超过单次运行最多 ${input.maxAgents} 个 agent() 调用的上限；把工作拆成几次运行`)
      const at = seq
      seq += 1
      return host.agent(at, call.prompt, call.options).then((reply) => {
        if (reply.ok) return parse(reply.json)
        if (reply.stopped) return null
        throw new SandboxError(reply.error)
      })
    }
  }
  const clip = (value: unknown): string => (typeof value === 'string' ? value : String(value)).slice(0, 300)
  const files = (): ProjectFiles => {
    if (!host.files) throw new SandboxError(pick('这个运行没有项目目录，readText / writeText / listFiles 不可用', 'This run has no project folder; readText / writeText / listFiles are not available'))
    return host.files
  }
  const io = (line: Omit<IoLine, 'kind' | 'attempt' | 'at'>): void => {
    try {
      host.io?.(line)
    } catch {
    }
  }
  const fileCall = <T>(op: IoLine['op'], path: unknown, run: () => T, describe: (value: T) => Omit<IoLine, 'kind' | 'attempt' | 'at' | 'op'>): T => {
    try {
      const value = run()
      io({ op, ...describe(value) })
      return value
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      io({ op, path: clip(path ?? '.'), error: message.slice(0, 500) })
      throw new SandboxError(message)
    }
  }
  Object.assign(bridge, {
    model: (prompt: unknown, options: unknown) => {
      if (!host.model) return fail(pick('这个运行没有接上直接模型调用，model() 不可用', 'This run has no direct model call host; model() is not available'))
      let call: ReturnType<typeof normalizeModelCall>
      try {
        call = normalizeModelCall(prompt, options)
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error))
      }
      if (modelSeq >= maxModels) fail(pick(`超过单次运行最多 ${maxModels} 个 model() 调用的上限；把工作拆成几次运行`, `Over the limit of ${maxModels} model() calls per run; split the work into several runs`))
      const at = modelSeq
      modelSeq += 1
      return host.model(at, call.prompt, call.options).then((reply) => {
        if (reply.ok) return parse(reply.json)
        if (reply.stopped) return null
        throw new SandboxError(reply.error)
      })
    },
    readText: (path: unknown) => fileCall('read', path, () => {
      const text = files().readText(path)
      return { text, path: files().relativeOf(path) }
    }, (value) => ({ path: value.path, bytes: Buffer.byteLength(value.text, 'utf8') })).text,
    writeText: (path: unknown, text: unknown) => parse(JSON.stringify(fileCall('write', path, () => files().writeText(path, text), (value) => ({
      path: value.path,
      bytes: value.bytes,
      sha: createHash('sha256').update(String(text)).digest('hex').slice(0, 16)
    })))),
    listFiles: (dir: unknown, glob: unknown) => parse(JSON.stringify(fileCall('list', dir, () => files().listFiles(dir, glob), (value) => ({
      path: dir === undefined || dir === null || dir === '' ? '.' : files().relativeOf(dir) || '.',
      count: value.length
    }))))
  })
  const install = runInContext(PRELUDE, context, { filename: 'workflow-prelude.js' }) as (host: unknown) => Record<string, unknown>
  const api = install(bridge)
  for (const name of ['agent', 'model', 'readText', 'writeText', 'listFiles', 'parallel', 'pipeline', 'phase', 'log'] as const) {
    Object.defineProperty(context, name, { value: api[name], writable: false, configurable: false, enumerable: false })
  }
  Object.defineProperty(context, 'args', { value: input.argsJson === undefined ? undefined : parse(input.argsJson), writable: false, configurable: false, enumerable: false })
  try {
    const script = new Script(wrapWorkflowCode(input.code), { filename: WORKFLOW_SCRIPT_FILENAME })
    const result = await (script.runInContext(context) as Promise<unknown>)
    if (fatal) return { ok: false, error: fatal }
    let json: string | undefined
    try {
      json = JSON.stringify(result === undefined ? null : result)
    } catch (error) {
      return { ok: false, error: `脚本的返回值不能转成 JSON：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, json: json ?? 'null' }
  } catch (error) {
    return { ok: false, error: fatal ?? describeError(error) }
  }
}
