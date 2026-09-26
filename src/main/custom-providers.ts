/*
 * 自定义 API 服务的宿主读写（实施-23 M1）。
 *
 * 真源就是 pi 的 `models.json`（`<PI_AGENT_DIR>/models.json`）。砚只写其中
 * `yan-` 前缀的条目，其它 provider 与未知字段原样保留 —— 合并逻辑在
 * `shared/custom-provider.ts`（纯函数、有单测），这里只负责文件与原子写。
 *
 * 写盘是「临时文件 + rename」：中途崩了也不会留下半个 JSON 把 pi 的模型
 * 配置弄坏（models.json 坏了 pi 会直接加载不到任何模型）。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import {
  mergeCustomProviders,
  readCustomProviders,
  validateCustomProvider,
  type CustomProviderInput,
  type CustomProviderTestResult,
  type CustomProviderView
} from '../shared/custom-provider'

export const MODELS_FILE = join(PI_AGENT_DIR, 'models.json')

export interface CustomProviderResult {
  ok: boolean
  errors?: string[]
  providers?: CustomProviderView[]
}

type Json = Record<string, unknown>

/**
 * 读盘。文件不存在 = 空配置（合法）；JSON 坏掉**不覆盖**，直接拒绝保存 ——
 * 宁可让用户先去修文件，也不能用一份空配置把他的模型定义冲掉。
 */
async function readRaw(): Promise<{ ok: true; json: unknown } | { ok: false; error: string }> {
  try {
    const text = await readFile(MODELS_FILE, 'utf8')
    try {
      return { ok: true, json: JSON.parse(text) }
    } catch {
      return { ok: false, error: `models.json 不是合法 JSON，先修好再保存：${MODELS_FILE}` }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, json: {} }
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function writeAtomic(json: Json): Promise<void> {
  await mkdir(PI_AGENT_DIR, { recursive: true })
  const tmp = `${MODELS_FILE}.yan-tmp`
  await writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  await rename(tmp, MODELS_FILE)
}

/** 列出砚拥有的自定义服务（密钥只回存在状态） */
export async function listCustomProviders(): Promise<CustomProviderView[]> {
  const raw = await readRaw()
  if (!raw.ok) return []
  return readCustomProviders(raw.json)
}

/** 新增或更新一个自定义服务 */
export async function saveCustomProvider(input: CustomProviderInput): Promise<CustomProviderResult> {
  const checked = validateCustomProvider(input)
  if (!checked.ok || !checked.value) return { ok: false, errors: checked.errors }

  const raw = await readRaw()
  if (!raw.ok) return { ok: false, errors: [raw.error] }

  const merged = mergeCustomProviders(raw.json, [checked.value], [])
  if (merged.changed) await writeAtomic(merged.next)
  return { ok: true, providers: readCustomProviders(merged.next) }
}

/** 删除一个自定义服务（只允许删砚自己的条目） */
export async function removeCustomProvider(id: string): Promise<CustomProviderResult> {
  const raw = await readRaw()
  if (!raw.ok) return { ok: false, errors: [raw.error] }
  const merged = mergeCustomProviders(raw.json, [], [id])
  if (merged.changed) await writeAtomic(merged.next)
  return { ok: true, providers: readCustomProviders(merged.next) }
}

/* ── 连接测试（实施-23 M2）───────────────────────────────────────────
 *
 * 计划要求把「URL/凭证检查」与「可能计费的真实模型请求」**分开**显示，
 * 各自带成本和结果 —— 一次按钮点下去就静默发一条真实请求是不可接受的。
 *
 * 两段都从**磁盘上已保存的配置**取参数（密钥不经过 IPC）：
 *   · endpoint —— 宿主直接 `GET <baseUrl>/models`，不带推理，永远免费；
 *   · billable —— 交给 pi 的 `--print --no-session` 跑一条极短提示词，
 *                 用的是这条 provider 自己的模型，真实计费。
 */

/** 与 pi 的 `models.json` 一致：OpenAI 兼容端点统一取 `<baseUrl>/models` */
export function modelsEndpoint(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/models`
}

async function readProviderEntry(id: string): Promise<Json | null> {
  const raw = await readRaw()
  if (!raw.ok) return null
  const providers = (raw.json as Json)?.providers
  if (!providers || typeof providers !== 'object') return null
  const entry = (providers as Json)[id]
  return entry && typeof entry === 'object' ? (entry as Json) : null
}

/**
 * 免费段：地址与凭证检查。
 *
 * 结论只报 HTTP 状态与可读原因，**不回显密钥**，也不把响应体整个抛给渲染端
 * （第三方端点的错误体可能带一堆无关信息，甚至回显请求头）。
 */
export async function testCustomProviderEndpoint(id: string): Promise<CustomProviderTestResult> {
  const started = Date.now()
  const entry = await readProviderEntry(id)
  if (!entry) return { ok: false, mode: 'endpoint', ms: 0, message: '这个服务不在 models.json 里' }
  const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : ''
  const apiKey = typeof entry.apiKey === 'string' ? entry.apiKey : ''
  if (!baseUrl) return { ok: false, mode: 'endpoint', ms: 0, message: '这条服务没有 Base URL' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(modelsEndpoint(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    })
    const ms = Date.now() - started
    if (response.status === 401 || response.status === 403) {
      return { ok: false, mode: 'endpoint', ms, message: `凭证被拒绝（HTTP ${response.status}）` }
    }
    if (!response.ok) {
      return { ok: false, mode: 'endpoint', ms, message: `端点返回 HTTP ${response.status}` }
    }
    await response.arrayBuffer()
    return { ok: true, mode: 'endpoint', ms, message: `地址可达，凭证可用（HTTP ${response.status}）` }
  } catch (error) {
    const ms = Date.now() - started
    const aborted = (error as { name?: string }).name === 'AbortError'
    return {
      ok: false,
      mode: 'endpoint',
      ms,
      message: aborted ? '连接超时（10 秒）' : `连不上：${error instanceof Error ? error.message : String(error)}`
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 计费段：让 pi 用这条 provider 的模型跑一条**极短**提示词。
 *
 * `--no-session` 是刻意的：连接测试不该在会话历史里留下一条没头没尾的记录。
 * 这里必须由调用方（渲染端）先明确告知用户「这一步会真实计费」再触发。
 */
export async function testCustomProviderBillable(opts: {
  id: string
  modelId: string
  piBin: string
}): Promise<CustomProviderTestResult> {
  const started = Date.now()
  const entry = await readProviderEntry(opts.id)
  if (!entry) return { ok: false, mode: 'billable', ms: 0, message: '这个服务不在 models.json 里' }
  if (!opts.modelId) return { ok: false, mode: 'billable', ms: 0, message: '先填一个模型 ID，再发真实请求' }
  if (!opts.piBin) {
    return { ok: false, mode: 'billable', ms: 0, message: '找不到 pi 可执行文件，无法发真实请求' }
  }

  const { spawn } = await import('node:child_process')
  return await new Promise<CustomProviderTestResult>((resolve) => {
    const child = spawn(
      opts.piBin,
      [
        '--print',
        '--no-session',
        '--model',
        `${opts.id}/${opts.modelId}`,
        '只回复两个字：收到'
      ],
      {
        env: { ...process.env, PI_CODING_AGENT_DIR: PI_AGENT_DIR },
        windowsHide: true
      }
    )
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({
        ok: false,
        mode: 'billable',
        ms: Date.now() - started,
        message: '真实请求超时（60 秒）'
      })
    }, 60_000)
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, mode: 'billable', ms: Date.now() - started, message: error.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      const text = stdout.trim()
      if (code === 0 && text) return resolve({ ok: true, mode: 'billable', ms, message: '真实请求成功', text })
      /* 只回最后一行错误，避免把可能含请求细节的长日志全抛给界面 */
      const reason = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? `退出码 ${code}`
      resolve({ ok: false, mode: 'billable', ms, message: reason.slice(0, 200) })
    })
  })
}
