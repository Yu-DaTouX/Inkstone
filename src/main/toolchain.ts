/**
 * 宿主依赖的外部命令检测：新装的 Windows 设备常常没有 Git for Windows。
 *
 * · bash —— pi 的内置 bash 工具在 Windows 上需要它。查找顺序与随包 pi 的
 *   `getShellConfig` 保持一致（见 `git-runtime.ts` 的 `findSystemBash`）；
 *   这里报「有」，pi 就一定找得到。
 * · git —— 审阅面板、工作树、子任务隔离与检查点直接调用它。
 *
 * 缺失时可以由用户一键装受管的 PortableGit（`git-runtime.ts`）；装好后它的目录已经
 * 在本进程的 PATH 上，这里看到的就是「有」，并标出它来自受管那份。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { MANAGED_GIT_ROOT, findSystemBash, findSystemGit } from './git-runtime'
import type { ToolchainStatus, ToolStatus } from '../shared/ipc'

const GIT_DOWNLOAD = 'https://git-scm.com/download/win'

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
    return {
      ok: false,
      hint: `pi 设置里的 shellPath 指向的文件不存在：${custom}。请改成真实的 bash.exe 路径，或删掉这一项后安装 Git。`
    }
  }
  const found = await findSystemBash()
  if (found) return { ok: true, path: found, ...(isManaged(found) ? { managed: true } : {}) }
  return {
    ok: false,
    hint: `这台设备没有找到 bash，内置的命令行工具暂时不能用。可以一键安装 Git（约 57MB，装在砚的数据目录，不改系统）；也可以自己安装 Git for Windows（${GIT_DOWNLOAD}）后重启砚。`
  }
}

function detectGit(): ToolStatus {
  const found = findSystemGit()
  if (found) return { ok: true, path: found, ...(isManaged(found) ? { managed: true } : {}) }
  return {
    ok: false,
    hint:
      process.platform === 'win32'
        ? `这台设备没有找到 git，改动审阅、工作树、子任务隔离与检查点不可用。可以一键安装 Git（约 57MB，装在砚的数据目录，不改系统）；也可以自己安装 Git for Windows（${GIT_DOWNLOAD}）后重启砚。`
        : '这台设备没有找到 git，改动审阅、工作树、子任务隔离与检查点不可用。请先安装 git。'
  }
}

export async function detectToolchain(): Promise<ToolchainStatus> {
  return { platform: process.platform, bash: await detectBash(), git: detectGit() }
}
