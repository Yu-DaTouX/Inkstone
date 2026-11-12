import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

function writeIfChanged(path: string, text: string): void {
  try {
    if (readFileSync(path, 'utf8') === text) return
  } catch {
  }
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function ensureYanLauncher(
  opts: LauncherOptions
): { binDir: string; launcher: string; cliPath: string } | null {
  const cliPath = resolveYanCli(opts)
  if (!cliPath) return null

  mkdirSync(opts.binDir, { recursive: true })

  const cmdPath = join(opts.binDir, 'yan.cmd')
  writeIfChanged(
    cmdPath,
    [
      '@echo off',
      'set "ELECTRON_RUN_AS_NODE=1"',
      `"${opts.execPath}" "${cliPath}" %*`,
      ''
    ].join('\r\n')
  )

  const shPath = join(opts.binDir, 'yan')
  writeIfChanged(
    shPath,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${opts.execPath}" "${cliPath}" "$@"`, ''].join('\n')
  )
  try {
    chmodSync(shPath, 0o755)
  } catch {
  }

  return { binDir: opts.binDir, launcher: process.platform === 'win32' ? cmdPath : shPath, cliPath }
}
