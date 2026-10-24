// Portions of this file are derived from @xmcl/installer (packages/installer/profile.ts),
// Copyright (c) 2023 CI010, licensed under the MIT License.
// Source: https://github.com/Voxelum/minecraft-launcher-core-node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { ZipReader } from '../dev/zip.ts'
import { abortError, isAbortError } from '../download/download.ts'
import type { RawVersion } from './meta.ts'
import { sha1OfFile } from './plan.ts'
import type { ProgressListener, TaskProgress } from './types.ts'

export type InstallSide = 'client' | 'server'

export interface RawProcessor {
  jar?: unknown
  classpath?: unknown
  args?: unknown
  outputs?: unknown
  sides?: unknown
}

export interface InstallProfile {
  profile: string
  version: string
  minecraft: string
  jsonPath: string
  data: Record<string, { client: string; server: string }>
  processors: RawProcessor[]
  libraries: unknown[]
  versionInfo: RawVersion | null
  filePath: string | null
}

export interface MavenCoordinate {
  group: string
  artifact: string
  version: string
  classifier: string
  extension: string
  name: string
}

export function parseMaven(name: string): MavenCoordinate {
  const [body, extension = 'jar'] = name.split('@')
  const [group, artifact, version, classifier = ''] = body.split(':')
  if (!group || !artifact || !version) throw new Error(`无法解析 maven 坐标：${name}`)
  return { group, artifact, version, classifier, extension, name }
}

export function mavenFilePath(name: string): string {
  const coordinate = parseMaven(name)
  const file = coordinate.classifier
    ? `${coordinate.artifact}-${coordinate.version}-${coordinate.classifier}.${coordinate.extension}`
    : `${coordinate.artifact}-${coordinate.version}.${coordinate.extension}`
  return `${coordinate.group.replaceAll('.', '/')}/${coordinate.artifact}/${coordinate.version}/${file}`
}

export function libraryDiskPath(folder: string, name: string): string {
  return join(folder, 'libraries', ...mavenFilePath(name).split('/'))
}

function dataOf(raw: unknown): Record<string, { client: string; server: string }> {
  const result: Record<string, { client: string; server: string }> = {}
  if (!raw || typeof raw !== 'object') return result
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') {
      result[key] = { client: value, server: value }
      continue
    }
    if (!value || typeof value !== 'object') continue
    const entry = value as { client?: unknown; server?: unknown }
    const client = typeof entry.client === 'string' ? entry.client : ''
    const server = typeof entry.server === 'string' ? entry.server : ''
    if (client || server) result[key] = { client, server }
  }
  return result
}

function processorsOf(raw: unknown): RawProcessor[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is RawProcessor => !!item && typeof item === 'object')
}

export function parseInstallProfile(raw: unknown): InstallProfile {
  const profile = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const versionInfo = profile.versionInfo && typeof profile.versionInfo === 'object' ? (profile.versionInfo as RawVersion) : null
  const install = profile.install && typeof profile.install === 'object' ? (profile.install as { filePath?: unknown }) : null
  const minecraft =
    typeof profile.minecraft === 'string' ? profile.minecraft : typeof versionInfo?.inheritsFrom === 'string' ? versionInfo.inheritsFrom : ''
  return {
    profile: typeof profile.profile === 'string' ? profile.profile : '',
    version: typeof profile.version === 'string' ? profile.version : minecraft,
    minecraft,
    jsonPath: typeof profile.json === 'string' ? profile.json.replace(/^\//, '') : 'version.json',
    data: dataOf(profile.data),
    processors: processorsOf(profile.processors),
    libraries: Array.isArray(profile.libraries) ? profile.libraries : [],
    versionInfo,
    filePath: install && typeof install.filePath === 'string' ? install.filePath : null
  }
}

export interface ProcessorContext {
  folder: string
  minecraft: string
  side: InstallSide
  installer: string
  clientLzma: string | null
}

export interface ProcessorOutput {
  path: string
  sha1: string | null
}

export interface ResolvedProcessor {
  jar: string
  jarPath: string
  classpath: string[]
  classpathPaths: string[]
  args: string[]
  outputs: ProcessorOutput[]
}

function unquote(value: string): string {
  const text = value.trim()
  return text.length >= 2 && text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1) : text
}

export function resolveProcessors(profile: InstallProfile, context: ProcessorContext): ResolvedProcessor[] {
  const base: Record<string, string> = {
    SIDE: context.side,
    MINECRAFT_JAR: join(context.folder, 'versions', context.minecraft, `${context.minecraft}.jar`),
    ROOT: context.folder,
    MINECRAFT_VERSION: context.minecraft,
    LIBRARY_DIR: join(context.folder, 'libraries'),
    INSTALLER: context.installer
  }
  const data: Record<string, { client: string; server: string }> = { ...profile.data }
  if (context.clientLzma) {
    data.BINPATCH = { client: context.clientLzma, server: context.clientLzma }
  }
  const cache = new Map<string, string>()
  const stack: string[] = []
  const resolve = (name: string): string => {
    const fixed = base[name]
    if (fixed !== undefined) return fixed
    const cached = cache.get(name)
    if (cached !== undefined) return cached
    const entry = data[name]
    if (!entry) throw new Error(`install_profile.json 里没有变量 ${name}`)
    if (stack.includes(name)) throw new Error(`install_profile.json 的变量 ${name} 循环引用`)
    stack.push(name)
    const value = resolveValue(context.side === 'client' ? entry.client : entry.server)
    stack.pop()
    cache.set(name, value)
    return value
  }
  const resolveValue = (raw: string): string => {
    const expanded = unquote(raw).replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => resolve(key))
    const bracket = expanded.match(/^\[(.+)\]$/)
    return bracket ? libraryDiskPath(context.folder, bracket[1]) : expanded
  }
  const resolveArg = (raw: string): string => {
    const bracket = raw.match(/^\[(.+)\]$/)
    return bracket ? libraryDiskPath(context.folder, bracket[1]) : raw.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => resolve(key))
  }
  const processors: ResolvedProcessor[] = []
  for (const processor of profile.processors) {
    const sides = Array.isArray(processor.sides) ? processor.sides.filter((side): side is string => typeof side === 'string') : []
    if (sides.length > 0 && !sides.includes(context.side)) continue
    const jar = typeof processor.jar === 'string' ? processor.jar : ''
    if (!jar) throw new Error('install_profile.json 的处理器缺少 jar 字段')
    const classpath = Array.isArray(processor.classpath) ? processor.classpath.filter((item): item is string => typeof item === 'string') : []
    const args = Array.isArray(processor.args) ? processor.args.filter((item): item is string => typeof item === 'string').map(resolveArg) : []
    const outputs: ProcessorOutput[] = []
    if (processor.outputs && typeof processor.outputs === 'object') {
      for (const [key, value] of Object.entries(processor.outputs as Record<string, unknown>)) {
        if (typeof value !== 'string') continue
        const path = resolveArg(key)
        const checksum = unquote(resolveArg(value).replaceAll("'", '')).toLowerCase()
        if (!path) continue
        outputs.push({ path, sha1: /^[0-9a-f]{40}$/.test(checksum) ? checksum : null })
      }
    }
    processors.push({
      jar,
      jarPath: libraryDiskPath(context.folder, jar),
      classpath,
      classpathPaths: classpath.map((name) => libraryDiskPath(context.folder, name)),
      args,
      outputs
    })
  }
  return processors
}

function manifestLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(' ') && lines.length) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  return lines
}

export async function jarMainClass(jarPath: string): Promise<string | null> {
  const zip = await ZipReader.open(jarPath)
  const manifest = await zip.read('META-INF/MANIFEST.MF')
  if (!manifest) return null
  for (const line of manifestLines(manifest.toString('utf8'))) {
    const match = line.match(/^Main-Class:\s*(.+)$/i)
    if (match) return match[1].trim()
  }
  return null
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tail(text: string, lines = 6): string {
  return text.split(/\r?\n/).filter((line) => line.trim()).slice(-lines).join('\n')
}

function runJava(spawnImpl: typeof spawn, javaPath: string, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(javaPath, args, { cwd, windowsHide: true, signal })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-8000)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', (error) => reject(error))
    child.on('close', (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(`退出码 ${code}${output ? `\n${tail(output)}` : ''}`))
    })
  })
}

export interface ProcessorRunOptions {
  javaPath: string
  cwd: string
  signal?: AbortSignal
  onProgress?: ProgressListener
  verifyOutputs?: boolean
  spawnImpl?: typeof spawn
}

export interface ProcessorRunResult {
  ran: number
  outputs: number
}

export async function verifyProcessorOutputs(processor: ResolvedProcessor, verify = true, signal?: AbortSignal): Promise<number> {
  let verified = 0
  for (const output of processor.outputs) {
    if (signal?.aborted) throw abortError()
    if (!existsSync(output.path)) throw new Error(`处理器 ${processor.jar} 的产物缺失：${output.path}`)
    if (!verify || !output.sha1) continue
    const actual = await sha1OfFile(output.path)
    if (actual !== output.sha1) throw new Error(`处理器 ${processor.jar} 的产物 sha1 不符：${output.path}（期望 ${output.sha1}，实际 ${actual}）`)
    verified += 1
  }
  return verified
}

export async function runProcessors(processors: ResolvedProcessor[], options: ProcessorRunOptions): Promise<ProcessorRunResult> {
  const total = processors.length
  const progress: TaskProgress = { done: 0, total, unit: 'steps' }
  options.onProgress?.(progress, total ? '运行安装处理器' : '没有需要运行的处理器')
  let ran = 0
  let outputs = 0
  for (const processor of processors) {
    if (options.signal?.aborted) throw abortError()
    if (!existsSync(processor.jarPath)) throw new Error(`处理器 ${processor.jar} 的 jar 不存在：${processor.jarPath}`)
    const missing = [...processor.classpathPaths, processor.jarPath].filter((path) => !existsSync(path))
    if (missing.length) throw new Error(`处理器 ${processor.jar} 的 classpath 缺少文件：${missing.join(', ')}`)
    const mainClass = await jarMainClass(processor.jarPath)
    if (!mainClass) throw new Error(`处理器 ${processor.jar} 的 jar 没有 Main-Class`)
    const classpath = [...processor.classpathPaths, processor.jarPath].join(delimiter)
    try {
      await runJava(options.spawnImpl ?? spawn, options.javaPath, ['-cp', classpath, mainClass, ...processor.args], options.cwd, options.signal)
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw abortError()
      throw new Error(`运行处理器 ${processor.jar} 失败：${messageOf(error)}`)
    }
    ran += 1
    outputs += await verifyProcessorOutputs(processor, options.verifyOutputs !== false, options.signal)
    options.onProgress?.({ done: ran, total, unit: 'steps' }, `运行处理器 ${ran}/${total}`)
  }
  return { ran, outputs }
}
