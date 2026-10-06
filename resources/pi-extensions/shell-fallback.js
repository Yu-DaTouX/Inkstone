/**
 * 没有 Git Bash 时，命令行工具退到 PowerShell。
 *
 * 随包 pi 在 Windows 上只有找得到 bash.exe 才能跑 `bash` 工具。宿主在启动 pi 时发现
 * 找不到（也没装受管 Git），就设置 `YAN_SHELL=powershell`；这里在每轮开始前把工具表里的
 * `bash` 换成 pi 自带的 `powershell`（Windows 自带，不需要任何下载），模型看到的就是一个能用的命令行工具，
 * 而不是每次调用都失败的 bash。
 *
 * 必须在 work-mode.js **之前**加载：它记录「宿主给的原始工具集」作恢复基线，要记到换好之后的这一份。
 * 没有设置环境变量（正常有 bash）时这个扩展什么都不做，也不碰工具表。
 */

function toolName(entry) {
  if (typeof entry === 'string') return entry
  if (entry && typeof entry === 'object' && typeof entry.name === 'string') return entry.name
  return ''
}

export default function shellFallback(pi) {
  if (process.env.YAN_SHELL !== 'powershell') return
  pi.on('before_agent_start', () => {
    try {
      const names = (pi.getActiveTools?.() ?? []).map(toolName).filter(Boolean)
      if (names.includes('powershell') && !names.includes('bash')) return
      const next = names.filter((name) => name !== 'bash')
      if (!next.includes('powershell')) next.push('powershell')
      pi.setActiveTools?.(next)
    } catch {
      /* 换不成就保持原样：宁可 bash 报「没找到」，也不能让整个回合起不来 */
    }
  })
}
