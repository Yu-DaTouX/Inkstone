import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { isPng, jarIcon, MAX_ICON_BYTES } from './jar-icon.ts'
import { readPclVersionSetup } from './pcl-import.ts'

const LOADER_ICON_LIBRARIES = ['net.fabricmc:fabric-loader:', 'org.quiltmc:quilt-loader:', 'net.neoforged.fancymodloader:loader:', 'net.neoforged:neoforge:', 'net.minecraftforge:fmlloader:', 'net.minecraftforge:forge:']
const VANILLA_TEXTURES = ['assets/minecraft/textures/block/grass_block_side.png', 'assets/minecraft/textures/blocks/grass_side.png']
const FABRIC_LOADER_FALLBACK = ['assets/fabricloader/icon.png']

interface RawVersion {
  inheritsFrom?: unknown
  jar?: unknown
  libraries?: Array<{ name?: unknown }>
}

export function mavenPath(name: string): string | null {
  const [group, artifact, version, classifier] = name.split(':')
  if (!group || !artifact || !version) return null
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.jar`
  return join(...group.split('.'), artifact, version, file)
}

export function pclLogoPath(versionDir: string, setup: Map<string, string>): string | null {
  if (setup.get('LogoCustom')?.toLowerCase() !== 'true') return null
  const logo = setup.get('Logo')
  if (!logo || /^[a-z]+:\/\//i.test(logo)) return null
  const target = resolve(versionDir, logo)
  const inside = relative(versionDir, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null
  return target
}

async function readJson(path: string): Promise<RawVersion | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RawVersion
  } catch {
    return null
  }
}

async function versionChain(folder: string, id: string): Promise<Array<{ id: string; json: RawVersion }>> {
  const chain: Array<{ id: string; json: RawVersion }> = []
  let current: string | null = id
  while (current && chain.length < 8 && !chain.some((item) => item.id === current)) {
    const json = await readJson(join(folder, 'versions', current, `${current}.json`))
    if (!json) break
    chain.push({ id: current, json })
    current = typeof json.inheritsFrom === 'string' ? json.inheritsFrom : null
  }
  return chain
}

async function readSmallPng(path: string): Promise<Buffer | null> {
  try {
    if ((await stat(path)).size > MAX_ICON_BYTES) return null
    const buffer = await readFile(path)
    return isPng(buffer) ? buffer : null
  } catch {
    return null
  }
}

async function loaderIcon(folder: string, chain: Array<{ json: RawVersion }>): Promise<Buffer | null> {
  const names = chain.flatMap((item) => (Array.isArray(item.json.libraries) ? item.json.libraries : []).map((lib) => (typeof lib?.name === 'string' ? lib.name : '')))
  for (const prefix of LOADER_ICON_LIBRARIES) {
    const name = names.find((item) => item.startsWith(prefix))
    const path = name ? mavenPath(name) : null
    if (!path) continue
    const jar = join(folder, 'libraries', path)
    if (!existsSync(jar)) continue
    const icon = await jarIcon(jar, prefix.startsWith('net.fabricmc') ? FABRIC_LOADER_FALLBACK : [])
    if (icon) return icon
  }
  return null
}

async function vanillaIcon(folder: string, chain: Array<{ id: string; json: RawVersion }>): Promise<Buffer | null> {
  const jars = chain.flatMap((item) => [item.id, typeof item.json.jar === 'string' ? item.json.jar : null]).filter((value): value is string => !!value)
  for (const id of new Set(jars)) {
    const jar = join(folder, 'versions', id, `${id}.jar`)
    if (!existsSync(jar)) continue
    const icon = await jarIcon(jar, VANILLA_TEXTURES)
    if (icon) return icon
  }
  return null
}

export async function readInstanceIcon(folder: string, id: string, customIcon: string | null = null): Promise<Buffer | null> {
  const versionDir = join(folder, 'versions', id)
  if (customIcon) {
    const custom = await readSmallPng(customIcon)
    if (custom) return custom
  }
  for (const name of ['instance.png', 'icon.png']) {
    const pack = await readSmallPng(join(versionDir, name))
    if (pack) return pack
  }
  const pclLogo = pclLogoPath(versionDir, await readPclVersionSetup(folder, id))
  if (pclLogo) {
    const logo = await readSmallPng(pclLogo)
    if (logo) return logo
  }
  const chain = await versionChain(folder, id)
  return (await loaderIcon(folder, chain)) ?? (await vanillaIcon(folder, chain))
}

export class InstanceIconCache {
  private readonly cache = new Map<string, { stamp: number; icon: Promise<string | null> }>()

  async get(folder: string, id: string, customIcon: string | null = null): Promise<string | null> {
    const key = `${folder.toLowerCase()}|${id}|${customIcon ?? ''}`
    let stamp = 0
    try {
      stamp = (await stat(join(folder, 'versions', id, `${id}.json`))).mtimeMs
    } catch {
      stamp = -1
    }
    const hit = this.cache.get(key)
    if (hit && hit.stamp === stamp) return hit.icon
    const icon = readInstanceIcon(folder, id, customIcon).then((png) => (png ? `data:image/png;base64,${png.toString('base64')}` : null))
    this.cache.set(key, { stamp, icon })
    return icon
  }
}
