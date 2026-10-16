export const GIT_RUNTIME_PIN = {
  version: '2.56.0.2',
  tag: 'v2.56.0.windows.2',
  asset: 'PortableGit-2.56.0.2-64-bit.7z.exe',
  size: 60027568,
  sha256: '075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b',
  github: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe',
  mirror: 'https://cdn.npmmirror.com/binaries/git-for-windows/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe'
} as const

export type GitInstallPhase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'

export interface GitInstallProgress {
  phase: GitInstallPhase
  received?: number
  total?: number
  message?: string
}

export interface GitRuntimeStatus {
  supported: boolean
  systemGit: boolean
  systemBash: boolean
  managedInstalled: boolean
  managedVersion?: string
  installing: boolean
  downloadSize: number
}
