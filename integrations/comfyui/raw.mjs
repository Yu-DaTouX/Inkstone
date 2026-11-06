import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fetchComfyWorkflow } from './discovery.mjs'
import { toApiPrompt, workflowNodeTypes, isApiPrompt } from './workflow.mjs'
import { comfyAbortRequests, comfyUpload, imageSignal, inside, loadSources, queuePosition, sniffFormat, sniffVideoFormat, VIDEO_MIME, SOURCE_MIME, VIDEO_SOURCE_MIME, watchComfyProgress } from './generation.mjs'
import { comboOptions, formatNodeErrors, inputType, suggestTypes, validatePrompt } from './validate.mjs'

const MAX_WORKFLOW_BYTES = 8 * 1024 * 1024
const INLINE_LIMIT = 24000
const SEARCH_LIMIT = 25
const MAX_OUTPUT_FILES = 8
const MAX_FILE_BYTES = 1024 * 1024 * 1024
const RUN_TIMEOUT_MS = 40 * 60_000
const INFO_CACHE_MS = 60_000

export class RawError extends Error {}

const infoCache = new Map()

export function resetInfoCache() { infoCache.clear() }

async function getJson(server, path, timeout, signal) {
  const response = await fetch(`${server.baseUrl}${path}`, { signal: imageSignal(timeout, signal) }).catch(() => null)
  if (!response?.ok) return null
  return response.json().catch(() => null)
}

async function allObjectInfo(server, signal) {
  const cached = infoCache.get(server.baseUrl)
  if (cached && Date.now() - cached.at < INFO_CACHE_MS) return cached.value
  const value = await getJson(server, '/object_info', 60_000, signal)
  if (!value) throw new RawError('读取不到 ComfyUI 的节点目录（/object_info）')
  infoCache.set(server.baseUrl, { at: Date.now(), value })
  return value
}

async function infoFor(server, types, signal) {
  const cached = infoCache.get(server.baseUrl)?.value
  const info = {}
  for (const type of types) {
    if (cached?.[type]) { info[type] = cached[type]; continue }
    const entry = (await getJson(server, `/object_info/${encodeURIComponent(type)}`, 10_000, signal))?.[type]
    if (entry) info[type] = entry
  }
  return info
}

function describeSpec(spec, detailed) {
  const type = inputType(spec)
  const options = comboOptions(spec)
  const extra = spec?.[1] && typeof spec[1] === 'object' ? spec[1] : {}
  if (!detailed) return options ? `COMBO(${options.length} 项)` : type
  if (options) return { type: 'COMBO', options: options.length > 60 ? options.slice(0, 60) : options, ...(options.length > 60 ? { optionCount: options.length } : {}), ...(extra.default !== undefined ? { default: extra.default } : {}) }
  const out = { type }
  for (const key of ['default', 'min', 'max', 'step', 'multiline', 'tooltip']) if (extra[key] !== undefined) out[key] = extra[key]
  return out
}

function summarize(name, entry, detailed) {
  const group = which => Object.fromEntries(Object.entries(entry.input?.[which] ?? {}).map(([key, spec]) => [key, describeSpec(spec, detailed)]))
  const outputs = (entry.output ?? []).map((type, index) => ({ slot: index, type: Array.isArray(type) ? 'COMBO' : type, name: entry.output_name?.[index] ?? type }))
  return {
    type: name, display_name: entry.display_name, category: entry.category,
    ...(detailed && entry.description ? { description: entry.description } : {}),
    required: group('required'), optional: group('optional'), outputs,
    ...(entry.output_node ? { output_node: true } : {}), ...(entry.api_node ? { api_node: true } : {})
  }
}

export async function nodeCatalog(server, params, signal) {
  const types = Array.isArray(params.types) ? params.types.filter(type => typeof type === 'string').slice(0, 20) : []
  if (types.length) {
    const info = await infoFor(server, types, signal)
    const missing = types.filter(type => !info[type])
    const all = missing.length ? Object.keys(await allObjectInfo(server, signal).catch(() => ({}))) : []
    return {
      nodes: types.filter(type => info[type]).map(type => summarize(type, info[type], true)),
      ...(missing.length ? { missing: missing.map(type => ({ type, similar: suggestTypes(type, all) })) } : {})
    }
  }
  const all = await allObjectInfo(server, signal)
  const words = String(params.search ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const category = typeof params.category === 'string' ? params.category.toLowerCase() : ''
  const hits = Object.entries(all).filter(([name, entry]) => {
    if (category && !String(entry.category ?? '').toLowerCase().includes(category)) return false
    const hay = `${name} ${entry.display_name ?? ''} ${entry.category ?? ''} ${entry.description ?? ''}`.toLowerCase()
    return words.every(word => hay.includes(word))
  })
  if (!words.length && !category) {
    const counts = {}
    for (const entry of Object.values(all)) { const key = String(entry.category ?? '').split('/')[0] || '(无分类)'; counts[key] = (counts[key] ?? 0) + 1 }
    return { total: Object.keys(all).length, categories: counts, hint: '用 search 关键词或 category 缩小范围，用 types 取节点完整定义' }
  }
  return { total: hits.length, nodes: hits.slice(0, SEARCH_LIMIT).map(([name, entry]) => summarize(name, entry, false)), ...(hits.length > SEARCH_LIMIT ? { truncated: `只列出前 ${SEARCH_LIMIT} 个，请加关键词` } : {}) }
}

function resolveInside(raw, roots, what) {
  const path = resolve(roots.cwd, raw)
  if (!inside(roots.cwd, path) && !(roots.artifactDir && inside(roots.artifactDir, path))) throw new RawError(`${what}必须在项目目录或插件成果目录内：${raw}`)
  return path
}

async function readJsonFile(raw, roots) {
  const path = resolveInside(raw, roots, '工作流文件')
  const real = await realpath(path).catch(() => null)
  if (!real) throw new RawError(`工作流文件不存在：${raw}`)
  const allowed = await Promise.all([roots.cwd, roots.artifactDir].filter(Boolean).map(root => realpath(root).catch(() => null)))
  if (!allowed.some(root => root && inside(root, real))) throw new RawError(`工作流文件必须在项目目录或插件成果目录内：${raw}`)
  const info = await stat(real)
  if (!info.isFile() || info.size > MAX_WORKFLOW_BYTES) throw new RawError('工作流文件无效或超过 8MB')
  try { return JSON.parse((await readFile(real, 'utf8')).replace(/^﻿/, '')) }
  catch (error) { throw new RawError(`工作流文件不是有效 JSON：${error.message}`) }
}

function tryParse(text) {
  try { return JSON.parse(text) } catch { throw new RawError('prompt 字符串不是有效 JSON') }
}

export async function loadPrompt(server, params, roots, signal) {
  const given = [params.prompt !== undefined, typeof params.path === 'string', typeof params.name === 'string'].filter(Boolean).length
  if (given !== 1) throw new RawError('工作流来源必须三选一：prompt（API 格式对象）、path（项目内 JSON 文件）、name（ComfyUI 已保存工作流）')
  let source
  if (params.prompt !== undefined) source = typeof params.prompt === 'string' ? tryParse(params.prompt) : params.prompt
  else if (typeof params.path === 'string') source = await readJsonFile(params.path, roots)
  else source = await fetchComfyWorkflow(server.baseUrl, String(params.name), signal).catch(() => { throw new RawError(`读不到已保存工作流 ${params.name}，用 comfyui_service status 看名称`) })
  if (!source || typeof source !== 'object') throw new RawError('工作流不是有效的 JSON 对象')
  if (isApiPrompt(source)) return { prompt: source, converted: false }
  if (!Array.isArray(source.nodes)) throw new RawError('既不是 API 格式（{节点编号: {class_type, inputs}}），也不是界面格式（含 nodes 数组）')
  const info = await infoFor(server, workflowNodeTypes(source), signal)
  return { prompt: toApiPrompt(source, info), converted: true }
}

function brief(prompt, info) {
  return Object.entries(prompt).map(([id, node]) => {
    const literals = Object.fromEntries(Object.entries(node.inputs ?? {}).map(([key, value]) => [key, Array.isArray(value) ? `→${value[0]}:${value[1]}` : typeof value === 'string' && value.length > 80 ? `${value.slice(0, 80)}…` : value]))
    return { id, type: node.class_type, ...(info[node.class_type]?.output_node ? { output: true } : {}), inputs: literals }
  })
}

export async function readWorkflow(server, params, roots, signal) {
  const { prompt, converted } = await loadPrompt(server, params, roots, signal)
  const info = await infoFor(server, [...new Set(Object.values(prompt).map(node => node.class_type))], signal)
  const text = JSON.stringify(prompt)
  let savedTo
  if (typeof params.outPath === 'string') {
    const path = resolveInside(params.outPath, { cwd: roots.cwd }, '输出文件')
    if (extname(path).toLowerCase() !== '.json') throw new RawError('outPath 必须是 .json 文件')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(prompt, null, 2), { flag: params.overwrite === true ? 'w' : 'wx' }).catch(error => { throw new RawError(error.code === 'EEXIST' ? `${params.outPath} 已存在，换个文件名或传 overwrite: true` : error.message) })
    savedTo = path
  }
  const inline = text.length <= INLINE_LIMIT
  return {
    format: 'api', convertedFromUi: converted, nodeCount: Object.keys(prompt).length,
    ...(savedTo ? { savedTo } : {}),
    ...(inline ? { prompt } : { overview: brief(prompt, info), note: `完整 JSON ${text.length} 字符，未内联；传 outPath 保存到项目文件后用文件工具读写` })
  }
}

export async function validateWorkflow(server, params, roots, signal) {
  const { prompt, converted } = await loadPrompt(server, params, roots, signal)
  const types = [...new Set(Object.values(prompt).map(node => node?.class_type).filter(type => typeof type === 'string'))]
  const info = await infoFor(server, types, signal)
  const unknown = types.some(type => !info[type])
  const all = unknown ? Object.keys(await allObjectInfo(server, signal).catch(() => ({}))) : []
  return { convertedFromUi: converted, nodeCount: Object.keys(prompt).length, ...validatePrompt(prompt, info, all), prompt }
}

export async function uploadMedia(server, paths, roots, signal) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 4) throw new RawError('paths 需要 1–4 个项目内的图片或视频路径')
  const out = []
  for (const raw of paths) {
    const isVideo = Boolean(VIDEO_SOURCE_MIME[extname(String(raw)).toLowerCase()])
    const [source] = await loadSources([raw], roots, isVideo ? { mime: VIDEO_SOURCE_MIME, maxBytes: 500 * 1024 * 1024 } : { mime: SOURCE_MIME, maxBytes: 20 * 1024 * 1024 })
    out.push({ path: raw, name: await comfyUpload(server, source, signal), kind: isVideo ? 'video' : 'image' })
  }
  return { uploaded: out, hint: '把 name 填进 LoadImage 的 image、LoadVideo 的 file 等输入' }
}

function collectFiles(outputs) {
  const files = []
  const texts = []
  for (const [node, output] of Object.entries(outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos', 'audio'])
      for (const item of output[key] ?? []) if (typeof item?.filename === 'string') files.push({ ...item, node, key })
    for (const text of output.text ?? []) if (typeof text === 'string') texts.push({ node, text: text.slice(0, 4000) })
  }
  const final = files.filter(item => item.type === 'output')
  return { files: final.length ? final : files, texts }
}

function executionError(entry) {
  const message = entry.status?.messages?.find(([kind]) => kind === 'execution_error')?.[1]
  if (!message) return '工作流执行失败（ComfyUI 没有给出详情）'
  const trace = Array.isArray(message.traceback) ? message.traceback.slice(-3).join('').trim().slice(-600) : ''
  return `节点 ${message.node_id}（${message.node_type}）执行失败：${message.exception_type ?? ''} ${String(message.exception_message ?? '').trim().slice(0, 600)}${trace ? `\n${trace}` : ''}`.trim()
}

async function saveOutputs(server, files, texts, artifactDir, signal) {
  await mkdir(artifactDir, { recursive: true })
  const saved = []
  const skipped = []
  for (const item of files) {
    if (saved.length >= MAX_OUTPUT_FILES) { skipped.push(`${item.filename}：超过 ${MAX_OUTPUT_FILES} 个文件上限`); continue }
    const query = new URLSearchParams({ filename: item.filename, subfolder: item.subfolder ?? '', type: item.type ?? 'output' })
    const file = await fetch(`${server.baseUrl}/view?${query}`, { signal: imageSignal(300_000, signal) })
    if (!file.ok) { skipped.push(`${item.filename}：HTTP ${file.status}`); continue }
    const bytes = Buffer.from(await file.arrayBuffer())
    const image = sniffFormat(bytes)
    const animated = /\.(gif|webp)$/i.test(item.filename) && item.key !== 'images'
    const format = image && !animated ? image : sniffVideoFormat(bytes)
    if (!format || !bytes.length || bytes.length > MAX_FILE_BYTES) { skipped.push(`${item.filename}：不支持的格式（${item.key}）或过大`); continue }
    const path = resolve(artifactDir, `${randomUUID()}.${format}`)
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 })
    saved.push({ path, node: item.node, filename: item.filename, bytes: bytes.length, mimeType: image && !animated ? `image/${format}` : VIDEO_MIME[format], kind: image && !animated ? 'image' : 'video' })
  }
  if (!saved.length && !texts.length) throw new RawError(`输出都无法保存：${skipped.join('；')}`)
  return { files: saved, path: saved[0]?.path, texts, ...(skipped.length ? { skipped } : {}) }
}

export async function runPrompt(server, prompt, { managed, signal, onProgress, artifactDir }) {
  const check = () => { if (signal?.aborted) throw new RawError('已取消') }
  const clientId = `yan-${randomUUID()}`
  onProgress?.({ stage: 'submitting' })
  const watcher = await watchComfyProgress(server, clientId, prompt, onProgress)
  try {
    const response = await fetch(`${server.baseUrl}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }), signal: imageSignal(30_000, signal) })
    if (!response.ok) {
      const detail = formatNodeErrors(await response.json().catch(() => null))
      throw new RawError(`ComfyUI 拒绝了工作流（HTTP ${response.status}）：\n${detail || '没有返回可读的错误信息'}\n修正这些节点的输入后再提交；用 comfyui_nodes 的 types 查看节点定义。`)
    }
    const promptId = (await response.json().catch(() => ({}))).prompt_id
    if (!promptId) throw new RawError('ComfyUI 没有返回 prompt_id')
    const abort = () => {
      for (const request of comfyAbortRequests(promptId, managed))
        void fetch(`${server.baseUrl}${request.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: request.body, signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (signal?.aborted) { abort(); check() }
      const deadline = Date.now() + RUN_TIMEOUT_MS
      for (let tick = 0; Date.now() < deadline; tick++) {
        await delay(1_000, undefined, { signal })
        check()
        if (onProgress && !watcher.started && tick % 3 === 0) {
          const place = await queuePosition(server, promptId, signal)
          if (place) watcher.queued(place.position, place.running)
        }
        const history = await fetch(`${server.baseUrl}/history/${encodeURIComponent(promptId)}`, { signal: imageSignal(10_000, signal) }).catch(() => null)
        check()
        if (!history?.ok) continue
        const entry = (await history.json().catch(() => ({})))[promptId]
        if (!entry) continue
        if (entry.status?.status_str === 'error') throw new RawError(executionError(entry))
        if (!entry.status?.completed) continue
        const { files, texts } = collectFiles(entry.outputs)
        if (!files.length && !texts.length) throw new RawError('工作流完成但没有可下载的输出。可能所有节点命中缓存（改 seed 或任一输入后重跑），或输出节点没连上数据')
        onProgress?.({ stage: 'downloading', node: undefined, nodeType: undefined, step: undefined, steps: undefined, stepPercent: undefined })
        return await saveOutputs(server, files, texts, artifactDir, signal)
      }
      abort()
      throw new RawError('等待超过 40 分钟，已取消')
    } finally { signal?.removeEventListener('abort', abort) }
  } finally { watcher.close() }
}
