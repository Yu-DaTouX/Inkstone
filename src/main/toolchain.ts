/**
 * 宿主依赖的外部命令检测：新装的 Windows 设备常常没有 Git for Windows。
 *
 * · bash —— pi 的内置 bash 工具在 Windows 上需要它。查找顺序与随包 pi 的
 *   `getShellConfig` 保持一致（pi 设置里的 `shellPath` → Program Files\Git →
 *   Program Files (x86)\Git → PATH 里的 bash.exe）；这里报「有」，pi 就一定找得到。
 * · git —— 审阅面板、工作树与子任务隔离直接调用它。
 *
 * 只做检测与说明，不替用户安装任何东西。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import type { ToolchainStatus, ToolStatus } from '../shared/ipc'

const GIT_DOWNLOAD = 'https://git-scm.com/download/win'

function whichOnPath(name: string): Promise<string | undefined> {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    execFile(finder, [name], { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(undefined)
      const first = String(stdout).trim().split(/\r?\n/)[0]?.trim()
      resolve(first || undefined)
    })
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

async function detectBash(): Promise<ToolStatus> {
  /* 类 Unix 系统上 bash 是基础组件，pi 自己会处理，不在这里报缺失 */
  if (process.platform !== 'win32') return { ok: true }

  const custom = await configuredShellPath()
  if (custom) {
    if (existsSync(custom)) return { ok: true, path: custom }
    return {
      ok: false,
      hint: `pi 设置里的 shellPath 指向的文件不存在：${custom}。请改成真实的 bash.exe 路径，或删掉这一项后安装 Git for Windows（${GIT_DOWNLOAD}）。`
    }
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter((root): root is string => !!root)
  for (const root of roots) {
    const candidate = join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return { ok: true, path: candidate }
  }
  const onPath = await whichOnPath('bash.exe')
  if (onPath) return { ok: true, path: onPath }
  return {
    ok: false,
    hint: `这台设备没有找到 bash，内置的命令行工具暂时不能用。请安装 Git for Windows（${GIT_DOWNLOAD}）后重启砚；已有 bash 的话，在 ${join(PI_AGENT_DIR, 'settings.json')} 里设置 "shellPath"。`
  }
}

async function detectGit(): Promise<ToolStatus> {
  const found = await whichOnPath('git')
  if (found) return { ok: true, path: found }
  return {
    ok: false,
    hint:
      process.platform === 'win32'
        ? `这台设备没有找到 git，改动审阅、工作树与子任务隔离不可用。请安装 Git for Windows（${GIT_DOWNLOAD}）后重启砚。`
        : '这台设备没有找到 git，改动审阅、工作树与子任务隔离不可用。请先安装 git。'
  }
}

export async function detectToolchain(): Promise<ToolchainStatus> {
  const [bash, git] = await Promise.all([detectBash(), detectGit()])
  return { platform: process.platform, bash, git }
}
