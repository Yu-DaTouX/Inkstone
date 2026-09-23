/**
 * 三类整理动作账本的宿主侧读数（实施-11 C-2b）。
 *
 * 扩展写 `<YAN_DATA_DIR>/context-actions/<sessionId>.jsonl` —— 它才知道
 * `tool-sweep` / `episode-fold` 这一轮到底做没做；宿主只负责**读**与聚合，
 * 不猜、不补。文件不存在 = 本会话还没发生任何整理（不是错误）。
 *
 * 安全：sessionId 直接进文件名，所以复用 `context-state-store` 的
 * 路径穿越判据（`isSafeSessionId`），与 task-plan / context 归档同一条链。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseActionLines,
  summarizeActions,
  type ContextActionSummary
} from '../shared/context-actions'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

/** 账本目录（测试可传 dataDir 隔离） */
export function contextActionsDir(dataDir: string): string {
  return join(dataDir, 'context-actions')
}

export function contextActionsFile(dataDir: string, sessionId: string): string {
  return join(contextActionsDir(dataDir), `${sessionId}.jsonl`)
}

const EMPTY: ContextActionSummary = summarizeActions([])

/**
 * 读并聚合当前会话的整理动作。
 *
 * 读不到（文件不存在 / 权限 / 非法 sessionId）都返回**空统计**：
 * 这是诊断读数，读不到不该让任何调用方失败。
 */
export async function readContextActions(
  sessionId: string | undefined | null,
  options: { dataDir?: string; limit?: number } = {}
): Promise<ContextActionSummary> {
  if (!isSafeSessionId(sessionId)) return EMPTY
  const dataDir = options.dataDir ?? YAN_DIR
  let text = ''
  try {
    text = await readFile(contextActionsFile(dataDir, sessionId as string), 'utf8')
  } catch {
    return EMPTY
  }
  return summarizeActions(parseActionLines(text, options.limit ?? 300))
}
