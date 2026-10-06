/**
 * 受管 Git 运行时的契约（主进程 / 渲染端共用）。
 *
 * 新装的 Windows 设备常常没有 Git for Windows：pi 的命令行工具要 Git Bash，
 * 改动审阅、工作树、子任务隔离与检查点要 git 本体。用户点一下就把 PortableGit
 * 下载到砚的数据目录，不弹安装向导、不要管理员权限、不改系统 PATH。
 *
 * 下载物按这里写死的 SHA-256 校验，通过才会解压并运行。升级 Git 版本时改这份常量
 * （摘要取自 Git for Windows 发布页该资产的 `digest`），不要放宽成「不校验」。
 */

export const GIT_RUNTIME_PIN = {
  version: '2.56.0.2',
  tag: 'v2.56.0.windows.2',
  asset: 'PortableGit-2.56.0.2-64-bit.7z.exe',
  size: 60027568,
  sha256: '075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b',
  /** 官方发布页与 npmmirror 的同名镜像（国内通常直连 GitHub 很慢或不通） */
  github: 'https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe',
  mirror: 'https://cdn.npmmirror.com/binaries/git-for-windows/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe'
} as const

export type GitInstallPhase = 'idle' | 'downloading' | 'verifying' | 'extracting' | 'done' | 'error'

export interface GitInstallProgress {
  phase: GitInstallPhase
  /** 已下载字节（downloading 阶段） */
  received?: number
  total?: number
  /** error 时给人读的原因；其余阶段是一句进度说明 */
  message?: string
}

export interface GitRuntimeStatus {
  /** 只有 Windows 提供这条路；其它平台由系统包管理器负责 git */
  supported: boolean
  /** 系统里（不含受管那份）已有 git / bash */
  systemGit: boolean
  systemBash: boolean
  /** 受管 Git 已安装及版本 */
  managedInstalled: boolean
  managedVersion?: string
  /** 正在安装中 */
  installing: boolean
  /** 一次安装要下载的大小（字节），界面提示用 */
  downloadSize: number
}
