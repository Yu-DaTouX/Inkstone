import { randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubagentRun, UIMessage } from '../shared/ipc'
import { readSessionMessages } from './session-reader'

export interface SubagentHistoryRecord {
  run: SubagentRun
  rootCwd: string
}

const validId = (id: unknown): id is string => typeof id === 'string' && /^sub-[a-zA-Z0-9-]+$/.test(id)
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const MAX_TRANSCRIPT = 200

export class SubagentHistory {
  private records = new Map<string, SubagentHistoryRecord>()
  private hidden = new Set<string>()
  private loaded?: Promise<void>
  private writes = new Map<string, Promise<void>>()

  constructor(private readonly dir: string) {}

  load(): Promise<void> {
    return this.loaded ??= this.readHistory()
  }

  list(): SubagentHistoryRecord[] {
    return [...this.records.values()].filter(({ run }) => !this.hidden.has(run.id))
  }

  get(id: string): SubagentHistoryRecord | undefined {
    return this.hidden.has(id) ? undefined : this.records.get(id)
  }

  private async readHistory(): Promise<void> {
    const files = await readdir(this.dir, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith('.json') || !validId(file.name.slice(0, -5))) continue
      try {
        const path = join(this.dir, file.name)
        if ((await stat(path)).size > MAX_HISTORY_BYTES) continue
        const data = JSON.parse(await readFile(path, 'utf8'))
        if (!data || data.id !== file.name.slice(0, -5) || typeof data.task !== 'string' ||
          !Number.isFinite(data.startedAt) || typeof data.rootCwd !== 'string' ||
          !['starting', 'running', 'done', 'error', 'cancelled'].includes(data.status)) continue
        if (data.hidden === true) { this.hidden.add(data.id); continue }
        let transcript: UIMessage[] = Array.isArray(data.transcript)
          ? data.transcript.filter((m: UIMessage) => m && typeof m.id === 'string' && typeof m.text === 'string' && ['user', 'assistant', 'tool'].includes(m.role)).slice(-MAX_TRANSCRIPT)
          : []
        let sourceCwd: string | undefined
        const interrupted = data.status === 'starting' || data.status === 'running'
        if (!Array.isArray(data.transcript) || interrupted) {
          let nativeTranscript: UIMessage[] = []
          const sessionDir = join(this.dir, 'sessions', data.id)
          const sessions = await readdir(sessionDir, { withFileTypes: true }).catch(() => [])
          for (const session of sessions.filter(f => f.isFile() && f.name.endsWith('.jsonl')).sort((a, b) => a.name.localeCompare(b.name))) {
            const path = join(sessionDir, session.name)
            if ((await stat(path)).size > MAX_HISTORY_BYTES) continue
            const history = await readSessionMessages(path)
            if (history) {
              nativeTranscript = [...nativeTranscript, ...history.messages].slice(-MAX_TRANSCRIPT)
              sourceCwd = history.sourceCwd ?? sourceCwd
            }
          }
          if (nativeTranscript.length) transcript = nativeTranscript
        }
        const run: SubagentRun = {
          ...data,
          cwd: typeof data.cwd === 'string' ? data.cwd : sourceCwd ?? data.rootCwd,
          model: typeof data.model === 'string' ? data.model : [...transcript].reverse().find(m => m.role === 'assistant' && m.model)?.model,
          isolation: ['controlled-cwd', 'shared-cwd', 'worktree'].includes(data.isolation) ? data.isolation : 'shared-cwd',
          transcript,
          toolCalls: !interrupted && Number.isFinite(data.toolCalls) ? data.toolCalls : transcript.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
          review: data.review ?? 'none',
          ...(interrupted ? { status: 'error', endReason: 'exited', endedAt: data.endedAt ?? (await stat(path)).mtimeMs,
            error: '应用退出时子代理未完成，未自动恢复执行', latestActivity: '运行已中断' } : {})
        }
        this.records.set(run.id, { run, rootCwd: data.rootCwd })
      } catch {
      }
    }
  }

  async save(run: SubagentRun, rootCwd: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!validId(run.id)) throw new Error('无效的子代理运行身份')
    const snapshot = JSON.parse(JSON.stringify(run)) as SubagentRun
    const previous = this.writes.get(run.id) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(this.dir, { recursive: true })
      const temp = join(this.dir, `${run.id}.${randomBytes(6).toString('hex')}.tmp`)
      const dismissedAt = this.records.get(run.id)?.run.dismissedAt
      const saved = snapshot.status === 'error' && typeof dismissedAt === 'number' && Number.isFinite(dismissedAt)
        ? { ...snapshot, dismissedAt }
        : snapshot
      await writeFile(temp, JSON.stringify({ ...extra, ...saved, rootCwd, schemaVersion: 1, hidden: this.hidden.has(run.id) }, null, 2), 'utf8')
      await rename(temp, join(this.dir, `${run.id}.json`))
      this.records.set(run.id, { run: saved, rootCwd })
    })
    this.writes.set(run.id, next)
    try { await next } finally { if (this.writes.get(run.id) === next) this.writes.delete(run.id) }
  }

  async hide(run: SubagentRun, rootCwd: string): Promise<void> {
    this.hidden.add(run.id)
    try { await this.save(run, rootCwd) } catch (error) { this.hidden.delete(run.id); throw error }
    this.records.delete(run.id)
  }
}
