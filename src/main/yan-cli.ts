/**
 * 生成随包 `yan` CLI 的**启动器**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要生成，而不是直接分发一个 exe
 * ══════════════════════════════════════════════════════════════════
 * 模型在 bash 里敲的是 `yan …`，它必须：
 *   · 在**用户没装 node / 没有 .js 文件关联**的机器上也能跑；
 *   · 用的是**应用自带的那份运行时**，而不是用户环境里碰巧存在的某个 node；
 *   · PATH 里一定找得到（但不能改用户的系统 PATH）。
 *
 * 所以做法是：每次启动把两个小启动器写进 `YAN_DIR/bin/`，
 * 内容是「用本应用的 Electron 二进制、以纯 Node 模式执行随包的 yan.mjs」，
 * 然后**只往 pi 子进程的 PATH 前置这个目录**。用户系统 PATH 不动。
 *
 * ```
 *   pi 子进程 PATH = <YAN_DIR>/bin ; 原来的 PATH
 *   yan.cmd        → ELECTRON_RUN_AS_NODE=1 "<应用 exe>" "<随包>/yan.mjs" %*
 * ```
 *
 * ── 为什么不用 `node` ──
 *   打包后的 Windows 用户机器上不保证有 node；即使有，版本也不受控。
 *   应用自带的 Electron 在 `ELECTRON_RUN_AS_NODE=1` 下就是一个标准 Node。
 *
 * ── 为什么每次启动都重写 ──
 *   开发态与打包态的 `yan.mjs` 路径不同，用户还可能移动便携版 EXE。
 *   这两个文件只有几十字节，重写的成本远低于「路径过期但没人发现」。
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LauncherOptions {
  /**
   * 打包态的资源根（`process.resourcesPath`），其下有 `yan-cli/`。
   * 开发态不存在，会回落到 `devResourcesDir`。
   */
  packagedResourcesDir?: string
  /** 开发态的 `resources/` 目录（仓库里那一份）。 */
  devResourcesDir?: string
  /** Electron 可执行文件（`process.execPath`）。 */
  execPath: string
  /** 启动器输出目录，通常是 `YAN_DIR/bin`。 */
  binDir: string
}

/**
 * 找到随包的 `yan.mjs`。
 *
 * 两个候选都查，是因为**开发态与打包态的相对位置不同**：
 * 打包后它在 `process.resourcesPath/yan-cli/`，开发态在仓库的 `resources/yan-cli/`。
 */
export function resolveYanCli(opts: LauncherOptions): string | null {
  const candidates = [
    opts.packagedResourcesDir ? join(opts.packagedResourcesDir, 'yan-cli', 'yan.mjs') : null,
    opts.devResourcesDir ? join(opts.devResourcesDir, 'yan-cli', 'yan.mjs') : null
  ].filter((x): x is string => !!x)

  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * 写启动器并返回可执行文件路径。
 *
 * 返回 `null` 表示**找不到 yan.mjs**（例如打包时漏了 extraResources）——
 * 调用方应当据此把「能力入口不可用」写进诊断，而不是让模型对着
 * `'yan' 不是内部或外部命令` 发呆。
 */
export function ensureYanLauncher(
  opts: LauncherOptions
): { binDir: string; launcher: string; cliPath: string } | null {
  const cliPath = resolveYanCli(opts)
  if (!cliPath) return null

  mkdirSync(opts.binDir, { recursive: true })

  /*
   * Windows：`.cmd` 才能被 cmd.exe / PowerShell 直接解析。
   * `set "VAR=value"` 的引号写法避免路径里出现 `&` 时被拆断。
   */
  const cmdPath = join(opts.binDir, 'yan.cmd')
  writeFileSync(
    cmdPath,
    [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${opts.execPath}" "${cliPath}" %*`,
      ''
    ].join('\r\n'),
    'utf8'
  )

  /*
   * POSIX：同一份逻辑，给非 Windows 的调试环境用（当前只发 Windows 包，
   * 但 test:unit / CI 里可能在别的平台上跑）。
   */
  const shPath = join(opts.binDir, 'yan')
  writeFileSync(
    shPath,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${opts.execPath}" "${cliPath}" "$@"`, ''].join('\n'),
    'utf8'
  )
  try {
    chmodSync(shPath, 0o755)
  } catch {
    /* Windows 上 chmod 可能无效，不影响 .cmd 那条路 */
  }

  return { binDir: opts.binDir, launcher: process.platform === 'win32' ? cmdPath : shPath, cliPath }
}
