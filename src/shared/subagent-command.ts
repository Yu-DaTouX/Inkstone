/** 本地委派命令；只解析正文前的连续选项，任务中的示例参数必须保留。 */
export type SubagentCommandIsolation = 'worktree' | 'controlled-cwd' | 'shared-cwd'
export interface ParsedSubagentCommand { task: string; model?: string; isolation: SubagentCommandIsolation }
const COMMAND = /^\/subagent(?:\s|$)/i
export function parseSubagentCommand(input: string): ParsedSubagentCommand | null {
  const raw = input.trim()
  if (!COMMAND.test(raw)) return null
  let task = raw.replace(COMMAND, '').trim()
  let isolation: SubagentCommandIsolation = 'shared-cwd'
  let model: string | undefined
  while (task) {
    const flag = /^(--worktree|--read-only)(?=\s|$)/i.exec(task)
    if (flag) {
      isolation = flag[1].toLowerCase() === '--worktree' ? 'worktree' : 'controlled-cwd'
      task = task.slice(flag[0].length).trimStart()
      continue
    }
    const choice = /^--model\s+(?:"([^"\r\n]+)"|(\S+))/i.exec(task)
    if (choice) {
      model = choice[1] ?? choice[2]
      task = task.slice(choice[0].length).trimStart()
      continue
    }
    if (/^--(?=\s|$)/.test(task)) task = task.slice(2).trimStart()
    break
  }
  return { task: task.trim(), isolation, ...(model ? { model } : {}) }
}
