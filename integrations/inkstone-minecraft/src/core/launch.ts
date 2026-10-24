import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createMinecraftProcessWatcher, generateArguments, launch, Version, type LaunchOption, type ResolvedVersion } from '@xmcl/core'
import { offline } from '@xmcl/user'
import type { LogLine } from '../shared/api.ts'
import type { LaunchStep, LaunchStepId, LaunchStepProgress } from '../shared/launch-api.ts'

export interface OfflineLaunchOptions {
  folder: string
  versionId: string
  username: string
  javaPath: string
  gameDir: string
  maxMemoryMb: number
  nativeRoot: string
  extraJVMArgs?: string[]
  jvmArgs?: string
  gameArgs?: string
  resolution?: { width?: number; height?: number; fullscreen?: boolean }
}

export function splitArgs(text: string | null | undefined): string[] {
  if (!text) return []
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (const char of text) {
    if (char === '"' || char === "'") {
      if (quote === char) quote = null
      else if (quote === null) quote = char
      else current += char
      continue
    }
    if (quote === null && /\s/.test(char)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += char
  }
  if (current) args.push(current)
  return args
}

export interface LaunchEvents {
  log(line: LogLine): void
  windowReady(): void
  exit(code: number | null, crashReport: string | null): void
  error(message: string): void
}

export const LAUNCHER_NAME = 'Inkstone Minecraft'

export const LAUNCH_STEP_LABELS: Record<LaunchStepId, string> = {
  account: '检查账号',
  java: '检查 Java',
  files: '补全文件',
  process: '启动进程',
  window: '等待窗口'
}

export const LAUNCH_STEP_ORDER: LaunchStepId[] = ['account', 'java', 'files', 'process', 'window']

export function initialLaunchSteps(): LaunchStep[] {
  return LAUNCH_STEP_ORDER.map((id) => ({ id, label: LAUNCH_STEP_LABELS[id], state: 'pending', detail: null, progress: null }))
}

export function updateLaunchStep(steps: LaunchStep[], id: LaunchStepId, patch: Partial<Omit<LaunchStep, 'id' | 'label'>>): LaunchStep[] {
  return steps.map((step) => (step.id === id ? { ...step, ...patch } : step))
}

export function stepProgress(done: number, total: number, unit: LaunchStepProgress['unit']): LaunchStepProgress {
  return { done, total, unit }
}

export function useOwnVersionJar(folder: string, resolved: ResolvedVersion): ResolvedVersion {
  const jarOf = (id: string): string => join(folder, 'versions', id, `${id}.jar`)
  if (existsSync(jarOf(resolved.minecraftVersion))) return resolved
  const owner = resolved.inheritances.find((id) => existsSync(jarOf(id)))
  return owner ? { ...resolved, minecraftVersion: owner } : resolved
}

async function buildLaunchOption(options: OfflineLaunchOptions, version: ResolvedVersion, username: string): Promise<LaunchOption> {
  const auth = offline(username)
  const extraJVMArgs = [...splitArgs(options.jvmArgs), ...(options.extraJVMArgs ?? [])]
  const extraMCArgs = splitArgs(options.gameArgs)
  const resolution =
    options.resolution && (options.resolution.width || options.resolution.height || options.resolution.fullscreen)
      ? {
          ...(options.resolution.width ? { width: options.resolution.width } : {}),
          ...(options.resolution.height ? { height: options.resolution.height } : {}),
          ...(options.resolution.fullscreen ? { fullscreen: true } : {})
        }
      : undefined
  return {
    gamePath: options.gameDir,
    resourcePath: options.folder,
    version,
    javaPath: options.javaPath,
    gameProfile: auth.selectedProfile,
    accessToken: auth.accessToken,
    userType: 'legacy',
    launcherName: LAUNCHER_NAME,
    launcherBrand: LAUNCHER_NAME,
    maxMemory: options.maxMemoryMb,
    nativeRoot: join(options.nativeRoot, options.versionId),
    extraJVMArgs: extraJVMArgs.length > 0 ? extraJVMArgs : undefined,
    extraMCArgs: extraMCArgs.length > 0 ? extraMCArgs : undefined,
    resolution,
    extraExecOption: { windowsHide: false }
  }
}

export async function describeLaunchCommand(options: OfflineLaunchOptions): Promise<string[]> {
  const version = useOwnVersionJar(options.folder, await Version.parse(options.folder, options.versionId))
  return generateArguments(await buildLaunchOption(options, version, options.username))
}

export async function launchOffline(options: OfflineLaunchOptions, events: LaunchEvents): Promise<ChildProcess> {
  const nativeRoot = join(options.nativeRoot, options.versionId)
  await mkdir(nativeRoot, { recursive: true })
  await mkdir(options.gameDir, { recursive: true })
  const version = useOwnVersionJar(options.folder, await Version.parse(options.folder, options.versionId))
  const child = await launch(await buildLaunchOption(options, version, options.username))
  const pipe = (stream: 'out' | 'err') => (chunk: Buffer | string) => {
    for (const text of chunk.toString().split(/\r?\n/)) {
      if (text) events.log({ at: Date.now(), stream, text })
    }
  }
  child.stdout?.on('data', pipe('out'))
  child.stderr?.on('data', pipe('err'))
  const watcher = createMinecraftProcessWatcher(child)
  watcher.on('error', (error: unknown) => events.error(error instanceof Error ? error.message : String(error)))
  watcher.on('minecraft-window-ready', () => events.windowReady())
  watcher.on('minecraft-exit', ({ code, crashReport }) => events.exit(code ?? null, crashReport || null))
  return child
}
