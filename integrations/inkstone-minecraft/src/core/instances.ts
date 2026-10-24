import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Version } from '@xmcl/core'
import type { InstanceInfo, LoaderKind } from '../shared/api.ts'
import { javaFromSelection, readPclVersionSetup } from './pcl-import.ts'

interface RawLibrary {
  name?: unknown
}

interface RawVersionJson {
  inheritsFrom?: unknown
  mainClass?: unknown
  libraries?: unknown
  arguments?: { game?: unknown }
}

const LOADER_LIBRARIES: Array<{ kind: LoaderKind; prefix: string; generic?: boolean }> = [
  { kind: 'fabric', prefix: 'net.fabricmc:fabric-loader:' },
  { kind: 'quilt', prefix: 'org.quiltmc:quilt-loader:' },
  { kind: 'neoforge', prefix: 'net.neoforged:neoforge:' },
  { kind: 'neoforge', prefix: 'net.neoforged:forge:' },
  { kind: 'neoforge', prefix: 'net.neoforged.fancymodloader:' },
  { kind: 'neoforge', prefix: 'net.neoforged:', generic: true },
  { kind: 'forge', prefix: 'net.minecraftforge:forge:' },
  { kind: 'forge', prefix: 'net.minecraftforge:fmlloader:' },
  { kind: 'forge', prefix: 'net.minecraftforge:', generic: true }
]

const FML_VERSION_FLAGS = ['--fml.neoForgeVersion', '--fml.forgeVersion']

function fmlLoaderVersion(json: RawVersionJson): string | null {
  const game = Array.isArray(json.arguments?.game) ? json.arguments.game : []
  for (const flag of FML_VERSION_FLAGS) {
    const index = game.findIndex((item) => item === flag)
    const value = game[index + 1]
    if (index >= 0 && typeof value === 'string') return value
  }
  return null
}

export function detectLoader(json: RawVersionJson): { loader: LoaderKind; loaderVersion: string | null } {
  const names = Array.isArray(json.libraries)
    ? (json.libraries as RawLibrary[]).map((lib) => (typeof lib?.name === 'string' ? lib.name : ''))
    : []
  const fmlVersion = fmlLoaderVersion(json)
  for (const { kind, prefix, generic } of LOADER_LIBRARIES) {
    const hit = names.find((name) => name.startsWith(prefix))
    if (!hit) continue
    const rest = hit.slice(prefix.length).split(':')
    return { loader: kind, loaderVersion: fmlVersion ?? (generic ? null : rest[0] || null) }
  }
  const mainClass = typeof json.mainClass === 'string' ? json.mainClass : ''
  if (mainClass.startsWith('net.fabricmc')) return { loader: 'fabric', loaderVersion: null }
  if (mainClass.startsWith('org.quiltmc')) return { loader: 'quilt', loaderVersion: null }
  if (mainClass.startsWith('net.neoforged')) return { loader: 'neoforge', loaderVersion: fmlVersion }
  if (mainClass.startsWith('net.minecraftforge')) return { loader: 'forge', loaderVersion: fmlVersion }
  if (mainClass === 'cpw.mods.bootstraplauncher.BootstrapLauncher') {
    return { loader: names.some((name) => name.startsWith('net.neoforged')) ? 'neoforge' : 'forge', loaderVersion: fmlVersion }
  }
  if (mainClass === 'net.minecraft.client.main.Main') return { loader: 'vanilla', loaderVersion: null }
  return { loader: 'unknown', loaderVersion: null }
}

export function decideIsolation(versionDir: string, setup: Map<string, string>, loader: LoaderKind): boolean {
  const flag = setup.get('VersionArgumentIndieV2')
  if (flag?.toLowerCase() === 'true') return true
  for (const marker of ['mods', 'saves', 'options.txt', 'config', 'resourcepacks']) {
    if (existsSync(join(versionDir, marker))) return true
  }
  return loader !== 'vanilla' && loader !== 'unknown' && flag?.toLowerCase() !== 'false'
}

async function countMods(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.jar')).length
  } catch {
    return 0
  }
}

export async function readInstance(folder: string, id: string): Promise<InstanceInfo> {
  const versionDir = join(folder, 'versions', id)
  const base: InstanceInfo = {
    id,
    folder,
    minecraftVersion: null,
    loader: 'unknown',
    loaderVersion: null,
    javaMajor: null,
    isolated: false,
    gameDir: folder,
    modCount: 0,
    preferredJava: null,
    error: null
  }
  let raw: RawVersionJson
  try {
    raw = JSON.parse(await readFile(join(versionDir, `${id}.json`), 'utf8')) as RawVersionJson
  } catch {
    return { ...base, error: '缺少或无法解析版本 JSON' }
  }
  const { loader, loaderVersion } = detectLoader(raw)
  const setup = await readPclVersionSetup(folder, id)
  const isolated = decideIsolation(versionDir, setup, loader)
  const gameDir = isolated ? versionDir : folder
  const info: InstanceInfo = {
    ...base,
    loader,
    loaderVersion: loaderVersion ?? setup.get('VersionFabric') ?? null,
    isolated,
    gameDir,
    modCount: await countMods(join(gameDir, 'mods')),
    preferredJava: javaFromSelection(setup.get('VersionArgumentJavaSelect'))
  }
  try {
    const resolved = await Version.parse(folder, id)
    info.minecraftVersion = resolved.minecraftVersion
    info.javaMajor = resolved.javaVersion?.majorVersion ?? null
  } catch (error) {
    info.minecraftVersion = setup.get('VersionOriginal') ?? (typeof raw.inheritsFrom === 'string' ? raw.inheritsFrom : null)
    info.error = error instanceof Error ? error.message : String(error)
  }
  return info
}

export async function listInstances(folder: string): Promise<InstanceInfo[]> {
  let entries: string[]
  try {
    entries = (await readdir(join(folder, 'versions'), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
  const list = await Promise.all(entries.filter((id) => existsSync(join(folder, 'versions', id, `${id}.json`))).map((id) => readInstance(folder, id)))
  return list.sort((a, b) => a.id.localeCompare(b.id, 'zh-CN'))
}
