/**
 * 把「自动压缩上限」交给 pi 原生执行，让长任务运行中途也受它约束。
 *
 * context-trim.js 只在一轮结束（agent_settled）后才检查上限；一次连续跑几个小时的任务
 * 不会结束，上下文可以一直涨到 pi 原生线（窗口 − reserveTokens）才压缩。扩展里的
 * `ctx.compact()` 会先中止正在运行的 agent，不能在运行中使用；pi 原生的压缩检查
 * 则在每条回复后与下一次请求前都会执行，并支持按模型覆盖 `reserveTokens`。
 * 所以这里把「窗口 − 上限」写成该模型的 `compaction.modelOverrides[provider/id].reserveTokens`。
 *
 * 边界：
 * · 这是砚唯一写 pi 用户级 settings.json 的地方，只动 `compaction.modelOverrides` 里自己写过的条目；
 *   用户手写的覆盖不碰。写过哪些记在砚数据目录的 compaction-lines.json。
 * · pi 进程只在启动时读设置，已运行的会话要等下次启动才用新值；扩展的一轮结束检查仍在兜底。
 * · 上限不低于原生线的模型不需要覆盖，旧条目会被清掉。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { autoCompactAt } from '../shared/context-limits'
import { PI_AGENT_DIR, YAN_DIR } from './paths'

const DEFAULT_RESERVE_TOKENS = 16_384

export interface LineModel {
  provider: string
  id: string
  contextWindow: number
}

type Json = Record<string, unknown>

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * 纯函数：在已有设置上套用砚的覆盖，返回新设置与新的「自己写过」记录；没有变化返回 undefined。
 * `owned` 记的是砚写过的 reserveTokens，值与现存不一致就说明用户改过，不再认领。
 */
export function applyLines(
  settings: Json,
  owned: Record<string, number>,
  models: LineModel[],
  cap: number
): { settings: Json; owned: Record<string, number> } | undefined {
  const compaction: Json = isObj(settings.compaction) ? { ...settings.compaction } : {}
  const overrides: Json = isObj(compaction.modelOverrides) ? { ...compaction.modelOverrides } : {}
  const base = typeof compaction.reserveTokens === 'number' && compaction.reserveTokens >= 0 ? compaction.reserveTokens : DEFAULT_RESERVE_TOKENS
  const nextOwned: Record<string, number> = {}
  let changed = false

  for (const model of models) {
    const window = Math.round(model.contextWindow)
    if (!(window > 0)) continue
    const key = `${model.provider}/${model.id}`
    const entry = isObj(overrides[key]) ? { ...(overrides[key] as Json) } : undefined
    const current = entry?.reserveTokens
    const ours = owned[key] !== undefined && current === owned[key]
    if (entry && current !== undefined && !ours) continue

    const want = window - autoCompactAt(cap, window)
    if (want > base) {
      if (current !== want) {
        overrides[key] = { ...entry, reserveTokens: want }
        changed = true
      }
      nextOwned[key] = want
    } else if (ours && entry) {
      delete entry.reserveTokens
      if (Object.keys(entry).length > 0) overrides[key] = entry
      else delete overrides[key]
      changed = true
    }
  }
  /* 没出现在这次模型列表里的旧记录保持原样，免得模型暂时不可用就丢掉认领 */
  for (const [key, value] of Object.entries(owned)) {
    if (!(key in nextOwned) && !models.some(m => `${m.provider}/${m.id}` === key)) nextOwned[key] = value
  }
  if (!changed && JSON.stringify(nextOwned) === JSON.stringify(owned)) return undefined

  if (Object.keys(overrides).length > 0) compaction.modelOverrides = overrides
  else delete compaction.modelOverrides
  const next = { ...settings }
  if (Object.keys(compaction).length > 0) next.compaction = compaction
  else delete next.compaction
  return { settings: next, owned: nextOwned }
}

async function readJson(path: string): Promise<Json | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isObj(parsed) ? parsed : undefined
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? {} : undefined
  }
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

let queue: Promise<unknown> = Promise.resolve()

/** 串行执行：启动列模型与拖动滑块可能同时到达。设置文件读不懂（坏了）时不写，免得覆盖用户内容。 */
export function syncNativeCompactionLines(models: LineModel[], cap: number): Promise<void> {
  const run = async (): Promise<void> => {
    const file = join(PI_AGENT_DIR, 'settings.json')
    const recordFile = join(YAN_DIR, 'compaction-lines.json')
    const settings = await readJson(file)
    if (!settings) return
    const rawOwned = await readJson(recordFile)
    const owned: Record<string, number> = {}
    for (const [key, value] of Object.entries(rawOwned ?? {})) if (typeof value === 'number') owned[key] = value
    const result = applyLines(settings, owned, models, cap)
    if (!result) return
    await writeAtomic(file, result.settings)
    await writeAtomic(recordFile, result.owned)
  }
  const next = queue.then(run, run)
  queue = next.catch(() => undefined)
  return next
}
