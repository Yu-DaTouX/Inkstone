import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameSyncWithRetry } from './atomic-write'

export interface LauncherOptions {
  packagedResourcesDir?: string
  devResourcesDir?: string
  execPath: string
  binDir: string
  onNodeLauncherError?: (error: unknown) => void
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
    renameSyncWithRetry(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

function batchQuote(value: string): string {
  return `"${value.replace(/%/g, '%%')}"`
}

export function cmdLauncherText(...command: string[]): string {
  const line = command.map(batchQuote).join(' ')
  const lines = ['@echo off', 'setlocal', 'set "ELECTRON_RUN_AS_NODE=1"']
  if (/[^\x00-\x7f]/.test(line)) {
    lines.push(
      'for /f "delims=" %%a in (\'chcp\') do for %%b in (%%a) do set "YAN_CP=%%b"',
      'chcp 65001 >nul',
      `${line} %* & call set "YAN_EC=%%ERRORLEVEL%%" & call chcp %%YAN_CP%% >nul & call exit /b %%YAN_EC%%`
    )
  } else {
    lines.push(`${line} %* & call exit /b %%ERRORLEVEL%%`)
  }
  return [...lines, ''].join('\r\n')
}

export function nodeLauncherPath(binDir: string, platform: NodeJS.Platform = process.platform): string {
  return join(binDir, platform === 'win32' ? 'yan-node.cmd' : 'yan-node')
}

export function ensureNodeLauncher(opts: { execPath: string; binDir: string }): string {
  mkdirSync(opts.binDir, { recursive: true })
  writeIfChanged(join(opts.binDir, 'yan-node.cmd'), cmdLauncherText(opts.execPath))
  const shPath = join(opts.binDir, 'yan-node')
  writeIfChanged(shPath, ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${opts.execPath}" "$@"`, ''].join('\n'))
  try {
    chmodSync(shPath, 0o755)
  } catch {
  }
  return nodeLauncherPath(opts.binDir)
}

export function ensureYanLauncher(
  opts: LauncherOptions
): { binDir: string; launcher: string; cliPath: string } | null {
  const cliPath = resolveYanCli(opts)
  if (!cliPath) return null

  mkdirSync(opts.binDir, { recursive: true })

  const cmdPath = join(opts.binDir, 'yan.cmd')
  writeIfChanged(cmdPath, cmdLauncherText(opts.execPath, cliPath))

  const shPath = join(opts.binDir, 'yan')
  writeIfChanged(
    shPath,
    ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec "${opts.execPath}" "${cliPath}" "$@"`, ''].join('\n')
  )
  try {
    chmodSync(shPath, 0o755)
  } catch {
  }

  try {
    ensureNodeLauncher(opts)
  } catch (error) {
    if (opts.onNodeLauncherError) opts.onNodeLauncherError(error)
    else console.warn('[yan-cli] yan-node launcher update failed', error)
  }

  return { binDir: opts.binDir, launcher: process.platform === 'win32' ? cmdPath : shPath, cliPath }
}
