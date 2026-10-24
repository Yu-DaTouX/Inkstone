import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fetchManifest, fetchVersion, manifestEntries, versionPlan, type RawVersion } from './meta.ts'
import { downloadPending, pendingFiles, toDownloadOptions } from './plan.ts'
import type { InstallResult, VersionInstallOptions } from './types.ts'

export function versionDir(folder: string, name: string): string {
  return join(folder, 'versions', name)
}

export function instanceJsonPath(folder: string, name: string): string {
  return join(versionDir(folder, name), `${name}.json`)
}

export function assertFreeName(folder: string, name: string): void {
  if (existsSync(instanceJsonPath(folder, name))) throw new Error(`实例「${name}」已存在`)
}

export async function prepareInstance(folder: string, name: string, isolated: boolean): Promise<void> {
  await mkdir(versionDir(folder, name), { recursive: true })
  if (isolated) await mkdir(join(versionDir(folder, name), 'mods'), { recursive: true })
}

export async function writeInstanceJson(folder: string, name: string, version: RawVersion): Promise<void> {
  await writeFile(instanceJsonPath(folder, name), `${JSON.stringify({ ...version, id: name }, null, 2)}\n`)
}

export async function installVanilla(options: VersionInstallOptions): Promise<InstallResult> {
  const folder = options.folder
  const name = options.name ?? options.version
  const download = toDownloadOptions(options)
  assertFreeName(folder, name)
  const manifest = await fetchManifest(download)
  if (!manifestEntries(manifest).some((entry) => entry.id === options.version)) throw new Error(`版本清单里没有 ${options.version}`)
  const version = await fetchVersion(folder, options.version, { ...download, manifest })
  const plan = await versionPlan(folder, version, name, download)
  const pending = await pendingFiles(plan.files, 'sha1', { concurrency: options.concurrency, signal: options.signal, onProgress: options.onProgress })
  const report = await downloadPending(pending, download)
  await prepareInstance(folder, name, options.isolated ?? true)
  await writeInstanceJson(folder, name, version)
  return {
    name,
    minecraft: options.version,
    loader: 'vanilla',
    loaderVersion: null,
    isolated: options.isolated ?? true,
    total: plan.files.length,
    downloaded: pending.length,
    skipped: plan.files.length - pending.length,
    bytes: report.bytes,
    mods: [],
    note: null
  }
}
