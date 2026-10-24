import type { FabricVersionSet, MappingFlavor } from '../../shared/dev-api.ts'

export const FABRIC_META = 'https://meta.fabricmc.net/v2'
export const FABRIC_MAVEN = 'https://maven.fabricmc.net'
export const GRADLE_SERVICES = 'https://services.gradle.org'

export type FetchText = (url: string) => Promise<string>

export const defaultFetchText: FetchText = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'inkstone-minecraft' } })
  if (!response.ok) throw new Error(`请求 ${url} 失败：HTTP ${response.status}`)
  return response.text()
}

export function compareVersions(a: string, b: string): number {
  const split = (value: string) => value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  const left = split(a)
  const right = split(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x - y
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    return x < y ? -1 : 1
  }
  return 0
}

export function parseMavenVersions(xml: string): string[] {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1].trim())
}

export function isStableRelease(version: string): boolean {
  return /^\d+(\.\d+)*$/.test(version)
}

export function pickLatestStable(versions: string[]): string | null {
  return versions.filter(isStableRelease).sort(compareVersions).at(-1) ?? null
}

export function pickFabricApi(versions: string[], minecraft: string): string | null {
  const suffix = `+${minecraft}`
  return versions.filter((version) => version.endsWith(suffix)).sort((a, b) => compareVersions(a.slice(0, -suffix.length), b.slice(0, -suffix.length))).at(-1) ?? null
}

interface LoaderEntry {
  loader?: { version?: unknown; stable?: unknown }
}

interface YarnEntry {
  version?: unknown
  build?: unknown
}

export function pickLoader(entries: LoaderEntry[]): string | null {
  const versions = entries.map((entry) => ({ version: entry.loader?.version, stable: entry.loader?.stable === true }))
  const stable = versions.find((entry) => entry.stable && typeof entry.version === 'string')
  const any = versions.find((entry) => typeof entry.version === 'string')
  return (stable?.version ?? any?.version ?? null) as string | null
}

export function pickYarn(entries: YarnEntry[]): string | null {
  const sorted = entries
    .filter((entry): entry is { version: string; build: number } => typeof entry.version === 'string' && typeof entry.build === 'number')
    .sort((a, b) => b.build - a.build)
  return sorted[0]?.version ?? null
}

export function minecraftParts(minecraft: string): number[] {
  return minecraft.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

export function isUnobfuscated(minecraft: string): boolean {
  return minecraftParts(minecraft)[0] >= 26
}

export function javaReleaseFor(minecraft: string): number {
  const [major, minor, patch = 0] = minecraftParts(minecraft)
  if (major >= 26) return 25
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21
  if (minor >= 18) return 17
  if (minor === 17) return 16
  return 8
}

export function loomPluginId(minecraft: string): string {
  return isUnobfuscated(minecraft) ? 'net.fabricmc.fabric-loom' : 'net.fabricmc.fabric-loom-remap'
}

function loomMarkerUrl(pluginId: string): string {
  return `${FABRIC_MAVEN}/${pluginId.replaceAll('.', '/')}/${pluginId}.gradle.plugin/maven-metadata.xml`
}

export async function resolveFabricVersions(
  minecraft: string,
  options: { mappings?: MappingFlavor; fetchText?: FetchText; overrides?: Partial<FabricVersionSet> } = {}
): Promise<FabricVersionSet> {
  const fetchText = options.fetchText ?? defaultFetchText
  const overrides = options.overrides ?? {}
  const mappings = options.mappings ?? 'yarn'
  const pluginId = overrides.loomPlugin ?? loomPluginId(minecraft)
  const encoded = encodeURIComponent(minecraft)
  const needYarn = mappings === 'yarn' && !isUnobfuscated(minecraft) && !overrides.yarn
  const [loaderText, yarnText, apiText, loomText, gradleText] = await Promise.all([
    overrides.loader ? null : fetchText(`${FABRIC_META}/versions/loader/${encoded}?limit=10`),
    needYarn ? fetchText(`${FABRIC_META}/versions/yarn/${encoded}`) : null,
    overrides.fabricApi ? null : fetchText(`${FABRIC_MAVEN}/net/fabricmc/fabric-api/fabric-api/maven-metadata.xml`),
    overrides.loom ? null : fetchText(loomMarkerUrl(pluginId)),
    overrides.gradle ? null : fetchText(`${GRADLE_SERVICES}/versions/current`)
  ])
  const loader = overrides.loader ?? (loaderText ? pickLoader(JSON.parse(loaderText) as LoaderEntry[]) : null)
  if (!loader) throw new Error(`Fabric 还不支持 Minecraft ${minecraft}（没有可用的 loader）`)
  const yarn = overrides.yarn ?? (yarnText ? pickYarn(JSON.parse(yarnText) as YarnEntry[]) : null)
  if (needYarn && !yarn) throw new Error(`Minecraft ${minecraft} 没有 yarn 映射，可改用 mojmap`)
  const fabricApi = overrides.fabricApi ?? (apiText ? pickFabricApi(parseMavenVersions(apiText), minecraft) : null)
  if (!fabricApi) throw new Error(`没有找到适配 Minecraft ${minecraft} 的 Fabric API`)
  const loom = overrides.loom ?? (loomText ? pickLatestStable(parseMavenVersions(loomText)) : null)
  if (!loom) throw new Error('无法确定 Fabric Loom 版本')
  const gradle = overrides.gradle ?? (gradleText ? String((JSON.parse(gradleText) as { version?: unknown }).version ?? '') : '')
  if (!gradle) throw new Error('无法确定 Gradle 版本')
  return {
    minecraft,
    loader,
    yarn: mappings === 'yarn' ? yarn : null,
    fabricApi,
    loom,
    loomPlugin: pluginId,
    gradle,
    javaRelease: overrides.javaRelease ?? javaReleaseFor(minecraft)
  }
}
