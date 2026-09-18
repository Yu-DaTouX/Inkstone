/**
 * 解析桌面端的 `/subagent` 本地命令。
 *
 * 命令注册表把只读开关写在任务参数之后（`/subagent <任务> [--read-only]`），
 * 但早期路由只接受前置开关，导致用户照着补全文案输入时悄悄落入写入型
 * worktree。这里把参数解析收成无副作用的纯函数，前置/尾置都统一成明确的
 * `controlled-cwd` 模式；没有任务时仍返回空任务，让 UI 保留草稿并不给子代理
 * 发起一个无意义的进程。
 */
export type SubagentCommandIsolation = 'worktree' | 'controlled-cwd'

export interface ParsedSubagentCommand {
  task: string
  isolation: SubagentCommandIsolation
}

const SUBAGENT_COMMAND = /^\/subagent(?:\s|$)/i
const READ_ONLY_TOKEN = /(^|\s)--read-only(?=\s|$)/i

export function parseSubagentCommand(input: string): ParsedSubagentCommand | null {
  const raw = input.trim()
  if (!SUBAGENT_COMMAND.test(raw)) return null

  let task = raw.replace(/^\/subagent(?:\s|$)/i, '').trim()
  const flag = READ_ONLY_TOKEN.exec(task)
  if (!flag) return { task, isolation: 'worktree' }

  /* 删除整个独立 token（连同它前面的一个空白），保留任务其它内容。 */
  task = `${task.slice(0, flag.index)}${task.slice(flag.index + flag[0].length)}`.trim()
  return { task, isolation: 'controlled-cwd' }
}

