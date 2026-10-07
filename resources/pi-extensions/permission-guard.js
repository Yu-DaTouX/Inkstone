/**
 * 权限档位 —— 薄层侧：日常模式下，没经确认的删除改为移到回收站。
 *
 * ══════════════════════════════════════════════════════════════════
 * 范围
 * ══════════════════════════════════════════════════════════════════
 * 档位是桌面设置里的 `permissionMode`（全局，用户 2026-10-07 定为两档）：
 *   · `danger`（缺省）危险批准 —— 只有高危清单要确认（danger-guard 负责）；
 *   · `all`            全部允许 —— 什么都不问。
 *
 * 两档都不为普通删除弹确认，底线是「没经确认的删除一律移到回收站」：桌面是「日常」界面
 * 模式时（表格、整理文件之类没有版本控制的事务），拦下 rm / del / Remove-Item 等删除命令，
 * 让模型改用 `yan file trash`。
 *   · 危险批准档下，高危的大范围删除仍由 danger-guard 先问，问过的照常执行；
 *   · 全部允许档下，它们同样改走回收站（danger-guard 在编码模式也这样处理）；
 *   · 系统临时目录里的删除照常放行，否则清理临时文件腾不出空间；
 *   · 编码模式不拦普通删除：项目有版本控制，清构建产物不该塞进回收站。
 *
 * 提醒式护栏，不是沙箱：靠命令文本识别删除，拼接、脚本里再调用都绕得开。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { detectDanger, hasDelete, isTempPath, shellDeleteTargets, trashHint } from './danger-guard.js'

const SHELL_TOOLS = new Set(['bash', 'powershell'])

export { hasDelete }

function desktopPrefs() {
  try {
    const dir = process.env.YAN_DATA_DIR?.trim() || join(homedir(), '.pi', 'agent', 'yan')
    const settings = JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8'))
    return {
      mode: settings.permissionMode === 'all' ? 'all' : 'danger',
      /* 界面模式缺省按「日常」（应用默认值）；明确是 coding 才不拦普通删除 */
      daily: settings.workspaceMode !== 'coding'
    }
  } catch {
    return { mode: 'danger', daily: true }
  }
}

/**
 * 这次调用要不要改走回收站。返回 `null` = 放行；否则 `{ targets }`（拦下时告诉模型删的是什么）。
 */
export function trashVerdict(toolName, input, cwd, prefs) {
  const name = String(toolName ?? '')
  if (!SHELL_TOOLS.has(name) || !prefs.daily) return null
  const command = String(input?.command ?? '')
  if (!hasDelete(command)) return null
  /* 危险批准档：高危删除由 danger-guard 先问，问过的照常执行 */
  if (prefs.mode !== 'all' && detectDanger(name, input ?? {}, cwd).length > 0) return null
  const targets = shellDeleteTargets(command, cwd)
  if (targets.length > 0 && targets.every(isTempPath)) return null
  return { targets }
}

export default function permissionGuardExtension(pi) {
  pi.on('tool_call', async (event, ctx) => {
    if (process.env.YAN_DANGER_GUARD === '0') return undefined
    const verdict = trashVerdict(event?.toolName, event?.input ?? {}, ctx?.cwd, desktopPrefs())
    if (!verdict) return undefined
    return { block: true, reason: trashHint(verdict.targets) }
  })
}
