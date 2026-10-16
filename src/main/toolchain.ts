import { existsSync, lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { PI_AGENT_DIR } from './paths'
import { MANAGED_GIT_ROOT, findSystemBash, findSystemGit } from './git-runtime'
import type { ToolchainStatus, ToolStatus } from '../shared/ipc'

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
