import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GameFolder, PclAccountRef, PclAccountType, PclSnapshot } from '../shared/api.ts'

export interface PclLocations {
  appData: string
  launcherDirs?: string[]
}

export function parseKeyValueLines(text: string): Map<string, string> {
  const entries = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '')
    const at = line.indexOf(':')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (/^'.*'$/.test(value) || /^".*"$/.test(value)) value = value.slice(1, -1)
    if (key && !key.startsWith('#')) entries.set(key, value)
  }
  return entries
}

export function parseLaunchFolders(value: unknown): GameFolder[] {
  if (typeof value !== 'string') return []
  const folders: GameFolder[] = []
  for (const item of value.split('|')) {
    const at = item.indexOf('>')
    const name = at >= 0 ? item.slice(0, at).trim() : ''
    const path = (at >= 0 ? item.slice(at + 1) : item).trim()
    if (!path) continue
    folders.push({ name: name || path, path: normalizeFolder(path) })
  }
  return folders
}

export function parseJavaList(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const list = JSON.parse(value) as unknown
    if (!Array.isArray(list)) return []
    return list
      .filter((item): item is { Path: string; IsEnable?: boolean } => !!item && typeof item === 'object' && typeof (item as { Path?: unknown }).Path === 'string')
      .filter((item) => item.IsEnable !== false)
      .map((item) => item.Path)
  } catch {
    return []
  }
}

export function javaFromSelection(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as { Path?: unknown }
    if (typeof parsed.Path !== 'string' || !parsed.Path) return null
    return /java(w)?\.exe$/i.test(parsed.Path) ? parsed.Path : join(parsed.Path, 'java.exe')
  } catch {
    return null
  }
}

function accountType(value: unknown): PclAccountType {
  return value === 'microsoft' || value === 'authlib' || value === 'offline' ? value : 'unknown'
}

function shortString(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

export function parseProfiles(text: string): PclAccountRef[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return []
  }
  const list = (data as { profiles?: unknown })?.profiles
  if (!Array.isArray(list)) return []
  const accounts: PclAccountRef[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const username = shortString(record.username, 64)
    if (!username) continue
    accounts.push({
      type: accountType(record.type),
      username,
      uuid: shortString(record.uuid, 64) ?? '',
      server: shortString(record.server, 400),
      serverName: shortString(record.serverName, 100)
    })
  }
  return accounts
}

export function normalizeFolder(path: string): string {
  return path.replace(/[\\/]+$/, '')
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

export async function readPclSnapshot(locations: PclLocations): Promise<PclSnapshot> {
  const sources: string[] = []
  const folders: GameFolder[] = []
  const javaPaths: string[] = []
  let selectedFolder: string | null = null
  let selectedVersion: string | null = null
  let downloadFolder: string | null = null

  const addFolder = (folder: GameFolder): void => {
    if (!folders.some((item) => item.path.toLowerCase() === folder.path.toLowerCase())) folders.push(folder)
  }

  const globalPath = join(locations.appData, 'PCLCE', 'config.v1.json')
  const globalText = await readText(globalPath)
  if (globalText) {
    try {
      const config = JSON.parse(globalText) as Record<string, unknown>
      sources.push(globalPath)
      for (const folder of parseLaunchFolders(config.LaunchFolders)) addFolder(folder)
      javaPaths.push(...parseJavaList(config.LaunchArgumentJavaUser))
      downloadFolder = shortString(config.CacheDownloadFolder, 400)
    } catch {
    }
  }

  for (const dir of locations.launcherDirs ?? []) {
    const ymlPath = join(dir, 'config.v1.yml')
    const yml = await readText(ymlPath)
    if (!yml) continue
    sources.push(ymlPath)
    const values = parseKeyValueLines(yml)
    const folder = values.get('LaunchFolderSelect')
    if (folder) {
      selectedFolder = normalizeFolder(folder)
      addFolder({ name: selectedFolder, path: selectedFolder })
    }
    selectedVersion = values.get('LaunchInstanceSelect') || values.get('LaunchVersionSelect') || selectedVersion
  }

  if (!selectedFolder && folders.length > 0) selectedFolder = folders[0].path
  if (selectedFolder && !selectedVersion) {
    const iniPath = join(selectedFolder, 'PCL.ini')
    const ini = await readText(iniPath)
    if (ini) {
      sources.push(iniPath)
      selectedVersion = parseKeyValueLines(ini).get('Version') || null
    }
  }

  const profilesPath = join(locations.appData, '.pclce', 'profiles.json')
  const profiles = await readText(profilesPath)
  const accounts = profiles ? parseProfiles(profiles) : []
  if (profiles) sources.push(profilesPath)

  return {
    found: sources.length > 0,
    sources,
    folders,
    selectedFolder,
    selectedVersion,
    javaPaths: [...new Set(javaPaths)],
    accounts,
    downloadFolder
  }
}

export async function readPclVersionSetup(folder: string, versionId: string): Promise<Map<string, string>> {
  const text = await readText(join(folder, 'versions', versionId, 'PCL', 'Setup.ini'))
  return text ? parseKeyValueLines(text) : new Map()
}
