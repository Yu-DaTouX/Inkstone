/**
 * 宿主提问的问答记录（按会话分组落盘）。
 *
 * ══════════════════════════════════════════════════════════
 * 为什么需要它
 * ══════════════════════════════════════════════════════════
 * `yan question ask` 的问答只出现在工具结果里 —— 对话流上看不到「用户当时
 * 回答了什么」。用户要求把问答显示成一条带「提问」提示的用户消息。
 *
 * 两条边界（用户 2026-09-26 拍板）：
 *   · **只回放**：不再把问答作为用户消息发一次给模型 —— 模型已经从工具结果
 *     里拿到了同一份内容，再发一次只会让它看到重复信息；
 *   · 记录属于**发起提问的那个会话**：切会话 / 分叉 / 重载后仍按会话对上，
 *     不把别的会话的问答贴到当前对话里。
 *
 * 落盘失败（磁盘满、权限）不抛错：这是附加的可读性信息，
 * 丢了最多是「这条问答在界面上看不到」，不该让一次提问失败。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { QuestionLogEntry } from '../shared/ipc'
import { isSafeSessionId } from './context-state-store'
import { YAN_DIR } from './paths'

/** 每个会话最多留多少条（问答记录只服务回看，不做归档） */
const PER_SESSION_LIMIT = 50

interface QuestionLogDocument {
  version: 1
  sessions: Record<string, QuestionLogEntry[]>
}

/** 落盘路径；与其它会话派生状态同一层（`YAN_DIR/question-log.json`） */
export function questionLogPath(): string {
  return join(YAN_DIR, 'question-log.json')
}

/** 读盘时逐字段校验：手改过的文件不该让界面崩掉 */
function sanitizeEntry(raw: unknown, sessionId: string, index: number): QuestionLogEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const question = typeof value.question === 'string' ? value.question.trim() : ''
  const at = Number(value.at)
  if (!question || !Number.isFinite(at) || at <= 0) return null
  const options = Array.isArray(value.options)
    ? value.options.filter((item): item is string => typeof item === 'string')
    : []
  return {
    id: typeof value.id === 'string' && value.id ? value.id : createHash('sha256').update(`${sessionId}\0${index}\0${question}\0${at}`).digest('hex').slice(0, 32),
    question,
    options,
    answer: typeof value.answer === 'string' && value.answer.trim() ? value.answer : null,
    cancelled: value.cancelled === true,
    at: Math.floor(at)
  }
}

function sanitizeDocument(raw: unknown): QuestionLogDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('提问记录文档结构无效')
  const doc = raw as Record<string, unknown>
  if (doc.version !== 1 || !doc.sessions || typeof doc.sessions !== 'object' || Array.isArray(doc.sessions)) throw new Error('提问记录文档结构无效')
  const out: QuestionLogDocument = { version: 1, sessions: {} }
  for (const [sessionId, list] of Object.entries(doc.sessions as Record<string, unknown>)) {
    if (!isSafeSessionId(sessionId) || !Array.isArray(list)) throw new Error('提问记录会话数据无效')
    const entries = list.map((item, index) => sanitizeEntry(item, sessionId, index)).filter((item): item is QuestionLogEntry => item !== null)
    if (entries.length) out.sessions[sessionId] = entries.slice(-PER_SESSION_LIMIT)
  }
  return out
}

export class QuestionLogStore {
  constructor(private readonly file: () => string = questionLogPath) {}

  /** 某个会话的问答记录（按时间升序） */
  list(sessionId: string | undefined | null): QuestionLogEntry[] {
    if (!isSafeSessionId(sessionId)) return []
    return this.read().sessions[sessionId] ?? []
  }

  /**
   * 记一条；返回该会话**更新后**的完整列表（渲染端整表覆盖，不做增量合并）。
   *
   * 会话身份不可用时返回 null（不记）：宁可少显示一条，也不能把记录挂到
   * 别的会话上 —— 那会让用户看到不属于这个对话的问答。
   */
  append(
    sessionId: string | undefined | null,
    entry: Omit<QuestionLogEntry, 'id'> & { id?: string }
  ): QuestionLogEntry[] | null {
    if (!isSafeSessionId(sessionId)) return null
    const doc = this.read()
    const list = doc.sessions[sessionId] ?? []
    const next = [...list, { ...entry, id: entry.id ?? randomUUID() }].slice(-PER_SESSION_LIMIT)
    doc.sessions[sessionId] = next
    this.write(doc)
    return next
  }

  private read(): QuestionLogDocument {
    let text: string
    try { text = readFileSync(this.file(), 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, sessions: {} }
      throw error
    }
    return sanitizeDocument(JSON.parse(text))
  }

  private write(doc: QuestionLogDocument): void {
    try {
      const path = this.file()
      mkdirSync(dirname(path), { recursive: true })
      const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
      try {
        writeFileSync(temp, JSON.stringify(doc), { encoding: 'utf8', flag: 'wx' })
        renameSync(temp, path)
      } catch (error) {
        rmSync(temp, { force: true })
        throw error
      }
    } catch (error) {
      console.warn('[question-log] 写入失败：', error instanceof Error ? error.message : error)
    }
  }
}

/** 主进程共用一份（按会话分组，无实例状态） */
export const questionLog = new QuestionLogStore()
