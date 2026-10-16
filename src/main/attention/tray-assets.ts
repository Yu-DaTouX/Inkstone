/**
 * 托盘品牌素材装载（v3 L12）。
 *
 * 读 `build/tray/manifest.json`（`npm run icon` 生成），把所有主题 × 状态的
 * 帧用宿主给的 `createImage` **一次性预载进内存**。播放器（`tray-animation.ts`）
 * 之后只在内存里选帧，不再读盘、不再创建图片。
 *
 * manifest 是「真源 → 产物」的唯一桥：真实原生时长（例如运行 750ms 周期、
 * 25ms 帧长）只写在 manifest 里，runtime 不复制第二套 duration/mask 常量。
 *
 * 本模块不 import Electron —— `createImage` / `readFile` / `exists` 都由宿主注入，
 * 因此可以用假实现做「常量缓存不每 tick 加载」的回归。
 */

export type TrayTheme = 'on-light' | 'on-dark'
export type TrayAnimationState = 'idle' | 'running' | 'waiting'

export interface TrayFrame {
  image: unknown
  /** 真实原生时长（毫秒）。 */
  durationMs: number
}

export interface TrayFrameSet {
  frames: readonly TrayFrame[]
  /** 减少动态 / 空闲时的静态亮帧。 */
  static?: unknown
}

export interface TrayAssetDeps {
  /** 候选 `build/tray` 目录（按存在顺序）。 */
  dirs: readonly string[]
  createImage(path: string): unknown
  readFile(path: string): string
  exists(path: string): boolean
  onWarn?(message: string): void
}

export interface TrayAssetStore {
  /** 预载全部素材；成功返回 true。之后 `set()` 纯内存。 */
  load(): boolean
  /** 同步取某主题 + 状态的帧集；缺失/坏 manifest 返回 undefined。 */
  set(state: TrayAnimationState, theme: TrayTheme): TrayFrameSet | undefined
  /** manifest 是否已成功加载。 */
  ready(): boolean
  /** manifest 里记录的真源哈希（诊断用）。 */
  sourceHash(): string | undefined
  dispose(): void
}

interface Manifest {
  version: number
  sourceHash?: string
  timelines: Record<string, { frames: { durationMs: number }[] }>
  themes: Record<string, { static: Record<string, string>; running: string[]; waiting: string[] }>
}

const STATE_KEYS: readonly TrayAnimationState[] = ['idle', 'running', 'waiting']
const THEMES: readonly TrayTheme[] = ['on-light', 'on-dark']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验 manifest 形状：版本、时间线、主题帧列表与时长一一对应。 */
export function validateManifest(raw: unknown): Manifest {
  if (!isRecord(raw) || raw.version !== 1) throw new Error('manifest.version 必须是 1')
  if (!isRecord(raw.timelines) || !isRecord(raw.themes)) throw new Error('manifest 缺少 timelines / themes')
  const timelines = raw.timelines as Manifest['timelines']
  const themes = raw.themes as Manifest['themes']
  for (const state of ['running', 'waiting']) {
    const line = timelines[state]
    if (!isRecord(line) || !Array.isArray(line.frames) || line.frames.length === 0) throw new Error(`manifest.timelines.${state} 缺失`)
    for (const frame of line.frames) {
      if (!isRecord(frame) || typeof frame.durationMs !== 'number' || frame.durationMs <= 0) throw new Error(`manifest.timelines.${state} 帧时长无效`)
    }
  }
  for (const theme of THEMES) {
    const entry = themes[theme]
    if (!isRecord(entry) || !isRecord(entry.static)) throw new Error(`manifest.themes.${theme} 缺失`)
    for (const key of STATE_KEYS) {
      const file = entry.static[key]
      if (typeof file !== 'string' || !file) throw new Error(`manifest.themes.${theme}.static.${key} 缺失`)
    }
    for (const state of ['running', 'waiting'] as const) {
      const files = entry[state]
      if (!Array.isArray(files) || files.some((file) => typeof file !== 'string' || !file)) throw new Error(`manifest.themes.${theme}.${state} 帧列表无效`)
      if (files.length !== timelines[state].frames.length) throw new Error(`manifest.themes.${theme}.${state} 帧数与时间线不符`)
    }
  }
  return raw as unknown as Manifest
}

export function createTrayAssetStore(deps: TrayAssetDeps): TrayAssetStore {
  let manifest: Manifest | null = null
  let dir: string | null = null
  /* 预载缓存：theme → state → 帧集；以及静态图缓存。 */
  const cache = new Map<string, TrayFrameSet>()
  const statics = new Map<string, unknown>()

  const warn = (message: string): void => {
    try {
      deps.onWarn?.(message)
    } catch {
      /* 诊断端口出错不影响装载。 */
    }
  }

  const image = (file: string): unknown => {
    if (!dir) return undefined
    try {
      return deps.createImage(`${dir}/${file}`)
    } catch (error) {
      warn(`托盘素材读取失败 ${file}：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const staticFor = (theme: TrayTheme, state: TrayAnimationState): unknown => {
    const key = `${theme}:${state}`
    if (statics.has(key)) return statics.get(key)
    const file = manifest?.themes[theme]?.static?.[state]
    const value = file ? image(file) : undefined
    statics.set(key, value)
    return value
  }

  return {
    load() {
      cache.clear()
      statics.clear()
      manifest = null
      dir = null
      const found = deps.dirs.find((candidate) => deps.exists(`${candidate}/manifest.json`))
      if (!found) {
        warn('未找到 build/tray/manifest.json：托盘保持静态精修标志')
        return false
      }
      try {
        manifest = validateManifest(JSON.parse(deps.readFile(`${found}/manifest.json`)))
      } catch (error) {
        manifest = null
        warn(`托盘 manifest 无效：${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      dir = found
      for (const theme of THEMES) {
        for (const state of STATE_KEYS) {
          if (state === 'idle') {
            const idle = staticFor(theme, 'idle')
            if (idle === undefined) continue
            cache.set(`${theme}:idle`, { frames: [{ image: idle, durationMs: 1 }], static: idle })
            continue
          }
          const durations = manifest.timelines[state].frames
          const files = manifest.themes[theme][state]
          const frames: TrayFrame[] = []
          let ok = files.length === durations.length
          for (let i = 0; ok && i < files.length; i += 1) {
            const img = image(files[i])
            if (img === undefined) {
              ok = false
              break
            }
            frames.push({ image: img, durationMs: durations[i].durationMs })
          }
          if (!ok) {
            warn(`托盘 ${theme}/${state} 帧不全，退回静态`)
            continue
          }
          cache.set(`${theme}:${state}`, { frames, static: staticFor(theme, state) })
        }
      }
      return cache.size > 0
    },
    set(state, theme) {
      return cache.get(`${theme}:${state}`)
    },
    ready: () => manifest !== null && cache.size > 0,
    sourceHash: () => manifest?.sourceHash,
    dispose() {
      cache.clear()
      statics.clear()
      manifest = null
      dir = null
    }
  }
}
