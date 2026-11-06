const EXACT: Record<string, string> = {
  'Git 强制推送，会覆盖远端历史': 'Git force push overwrites remote history',
  'git reset --hard，会丢弃未提交的改动': 'git reset --hard discards uncommitted changes',
  'git clean -f，会永久删除未跟踪的文件': 'git clean -f permanently deletes untracked files',
  '还原整个工作区，会丢弃未提交的改动': 'Restoring the whole worktree discards uncommitted changes',
  '删除 Git stash 里暂存的改动': 'Deletes changes saved in Git stash',
  '删除数据库或数据表': 'Drops a database or table',
  '格式化或直接写磁盘': 'Formats or writes directly to a disk',
  '把网络内容直接交给 shell 执行': 'Pipes network content straight into a shell',
  '递归修改根目录的权限或属主': 'Recursively changes permissions or owner of the root directory',
  '删除注册表项': 'Deletes a registry key',
  '发布 npm 包（对外发布）': 'Publishes an npm package',
  '关机或重启': 'Shuts down or restarts the machine',
  'PowerShell 编码命令无法解读，砚无法检查其中的操作': 'Encoded PowerShell command cannot be read, so Inkstone cannot check it',
  '命令嵌套层数过多，砚无法检查最内层的操作': 'Command is nested too deeply to check the innermost operation',
  '以管理员身份删除文件': 'Deletes files as administrator',
  '子 Agent 想执行一个难以撤销的操作': 'A subagent wants to run an operation that is hard to undo',
  '允许把这次会话移到另一个文件夹？': 'Move this session to another folder?'
}

const PREFIX: Array<[string, string]> = [
  ['递归删除大范围目录：', 'Recursively deletes a broad directory: '],
  ['递归删除项目之外的目录：', 'Recursively deletes a directory outside the project: '],
  ['PowerShell 编码命令，解码后为：', 'Encoded PowerShell command, decoded: '],
  ['修改项目之外的系统或凭证文件：', 'Modifies a system or credential file outside the project: '],
  ['写入项目之外的路径：', 'Writes outside the project: '],
  ['MCP 工具可能修改数据或对外操作：', 'MCP tool may change data or act externally: '],
  ['修改 pi 或砚的配置、凭据或扩展：', 'Modifies pi or Inkstone settings, credentials or extensions: ']
]

const CJK = /[一-龥]/

export function localizeApprovalText(text: string, lang: string): string {
  if (lang === 'zh-CN' || !CJK.test(text)) return text
  const exact = EXACT[text]
  if (exact) return exact
  for (const [zh, en] of PREFIX) if (text.startsWith(zh)) return `${en}${text.slice(zh.length)}`
  return text
}
