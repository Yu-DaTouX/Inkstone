/** 本地委派命令；默认当前目录，Git 隔离与只读均显式选择。 */
export type SubagentCommandIsolation = 'worktree' | 'controlled-cwd' | 'shared-cwd'
export interface ParsedSubagentCommand { task: string; model?: string; isolation: SubagentCommandIsolation }
const COMMAND = /^\/subagent(?:\s|$)/i
export function parseSubagentCommand(input: string): ParsedSubagentCommand | null {
  const raw = input.trim()
  if (!COMMAND.test(raw)) return null
  let task = raw.replace(COMMAND, '').trim()
  let isolation: SubagentCommandIsolation = 'shared-cwd'
  if (/(^|\s)--worktree(?=\s|$)/i.test(task)) {
    isolation = 'worktree'; task = task.replace(/(^|\s)--worktree(?=\s|$)/i, '').trim()
  }
  if (/(^|\s)--read-only(?=\s|$)/i.test(task)) {
    isolation = 'controlled-cwd'; task = task.replace(/(^|\s)--read-only(?=\s|$)/i, '').trim()
  }
  let model: string | undefined
  task = task.replace(/(^|\s)--model\s+(?:"([^"\r\n]+)"|(\S+))/i, (_all, _space, quoted, plain) => {
    model = quoted ?? plain; return ''
  }).trim()
  return { task, isolation, ...(model ? { model } : {}) }
}
