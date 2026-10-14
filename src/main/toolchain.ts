/**
 * 宿主依赖的外部命令检测：新装的 Windows 设备常常没有 Git for Windows。
 *
 * 只回报 `ToolStatus.reason` 里的原因码，不拼句子 —— 给人读的文案由界面按当前语言
 * 渲染（`renderer/src/lib/toolchain-text.ts`）。主进程不知道界面语言，写在这里的
 * 中文会在英文界面上原样显示。
 *
 * · bash —— pi 的内置 bash 工具在 Windows 上需要它。查找顺序与随包 pi 的
 *   `getShellConfig` 保持一致（见 `git-runtime.ts` 的 `findSystemBash`）；
 *   这里报「有」，pi 就一定找得到。
 * · git —— 审阅面板、工作树、子任务隔离与检查点直接调用它。
 *
 * 缺失时可以由用户一键装受管的 PortableGit（`git-runtime.ts`）；装好后它的目录已经
 * 在本进程的 PATH 上，这里看到的就是「有」，并标出它来自受管那份。
 */
import { existsSync, lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { MANAGED_GIT_ROOT, findSystemBash, findSystemGit } from './git-runtime'
import type { ToolchainStatus, ToolStatus } from '../shared/ipc'

/**
 * 没有 bash 时 pi 把命令行工具换成 PowerShell，优先 PowerShell 7（pwsh），没有就用系统自带的 5.1。
 * 商店版 pwsh.exe 是指向受保护目录的链接，existsSync 跟随链接会得到 false，只看链接本身。
 */
function hasPowerShell7(): boolean {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  return (process.env[pathKey] ?? '').split(delimiter).some((dir) => {
    if (!dir) return false
    try {
      lstatSync(join(dir, 'pwsh.exe'))
      return true
    } catch {
      return false
    }
  })
}

async function configuredShellPath(): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(PI_AGENT_DIR, 'settings.json'), 'utf8')) as { shellPath?: unknown }
    return typeof raw.shellPath === 'string' && raw.shellPath.trim() ? raw.shellPath.trim() : undefined
  } catch {
    return undefined
  }
}

function isManaged(path: string): boolean {
  return path.toLowerCase().startsWith(MANAGED_GIT_ROOT.toLowerCase())
}

async function detectBash(): Promise<ToolStatus> {
  /* 类 Unix 系统上 bash 是基础组件，pi 自己会处理，不在这里报缺失 */
  if (process.platform !== 'win32') return { ok: true }

  const custom = await configuredShellPath()
  if (custom && !existsSync(custom)) {
    return { ok: false, reason: { code: 'shell-path-missing', path: custom } }
  }
  const found = await findSystemBash()
  if (found) return { ok: true, path: found, ...(isManaged(found) ? { managed: true } : {}) }
  return { ok: false, reason: { code: 'bash-missing', shell: hasPowerShell7() ? 'pwsh' : 'powershell' } }
}

function detectGit(): ToolStatus {
  const found = findSystemGit()
  if (found) return { ok: true, path: found, ...(isManaged(found) ? { managed: true } : {}) }
  return { ok: false, reason: { code: 'git-missing' } }
}

export async function detectToolchain(): Promise<ToolchainStatus> {
  return { platform: process.platform, bash: await detectBash(), git: detectGit() }
}
