import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LauncherOptions {
  packagedResourcesDir?: string
  devResourcesDir?: string
  execPath: string
  binDir: string
}

export function resolveYanCli(opts: LauncherOptions): string | null {
  const candidates = [
    opts.packagedResourcesDir ? join(opts.packagedResourcesDir, 'yan-cli', 'yan.mjs') : null,
    opts.devResourcesDir ? join(opts.devResourcesDir, 'yan-cli', 'yan.mjs') : null
  ].filter((x): x is string => !!x)

  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export function ensureYanLauncher(
  opts: LauncherOptions
): { binDir: string; launcher: string; cliPath: string } | null {
  const cliPath = resolveYanCli(opts)
  if (!cliPath) return null

  mkdirSync(opts.binDir, { recursive: true })

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

  const shPath = join(opts.binDir, 'yan')
  writeFileSync(
    shPath,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${opts.execPath}" "${cliPath}" "$@"`, ''].join('\n'),
    'utf8'
  )
  try {
    chmodSync(shPath, 0o755)
  } catch {
  }

  return { binDir: opts.binDir, launcher: process.platform === 'win32' ? cmdPath : shPath, cliPath }
}
