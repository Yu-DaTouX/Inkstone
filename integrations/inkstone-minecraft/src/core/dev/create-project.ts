import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { CreateFabricProjectRequest, CreateFabricProjectResult, FabricVersionSet, MappingFlavor } from '../../shared/dev-api.ts'
import { detectJava, pickJava } from './java.ts'
import { templatesDir } from './assets.ts'
import { isUnobfuscated, resolveFabricVersions, type FetchText } from './fabric-meta.ts'
import { ensureWrapper } from './gradle.ts'
import { encodePng } from './png.ts'
import { exampleItemTexture } from './texture.ts'

const JAVA_KEYWORDS = new Set(
  'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record yield sealed permits'.split(' ')
)

export function validateModId(modId: string): string | null {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(modId)) return 'mod id 需 2–64 位，小写字母开头，只含小写字母、数字、- 和 _'
  if (modId.startsWith('fabric')) return 'mod id 不要以 fabric 开头（Fabric 自用）'
  if (['minecraft', 'java', 'fabricloader'].includes(modId)) return `mod id 不能是保留名 ${modId}`
  return null
}

export function validatePackageName(name: string): string | null {
  const parts = name.split('.')
  if (parts.length < 2) return '包名至少两段，例如 com.example.mymod'
  for (const part of parts) {
    if (!/^[a-z_][a-z0-9_]*$/.test(part)) return `包名段「${part}」只能用小写字母、数字和下划线，且不能以数字开头`
    if (JAVA_KEYWORDS.has(part)) return `包名段「${part}」是 Java 关键字`
  }
  return null
}

export function modClassName(modId: string): string {
  const pascal = modId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('')
  return /^[A-Z]/.test(pascal) ? pascal : `Mod${pascal}`
}

export function exampleSupported(minecraft: string): boolean {
  return minecraft === '1.21' || minecraft === '1.21.1'
}

export function renderTemplate(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_whole, key: string) => {
    if (!(key in values)) throw new Error(`模板变量 ${key} 未提供`)
    return values[key]
  })
}

export function templateValues(request: { modId: string; packageName: string; modName: string; mappings: MappingFlavor }, versions: FabricVersionSet, example: boolean): Record<string, string> {
  const unobfuscated = isUnobfuscated(versions.minecraft)
  const modClass = modClassName(request.modId)
  const mappingsLine = unobfuscated
    ? ''
    : request.mappings === 'mojmap'
      ? '\tmappings loom.officialMojangMappings()'
      : '\tmappings "net.fabricmc:yarn:${project.yarn_mappings}:v2"'
  const lang = (name: string) => (example ? `\t"item.${request.modId}.example_item": "${name}"` : '')
  return {
    modId: request.modId,
    modName: request.modName.replaceAll('\\', '\\\\').replaceAll('"', '\\"'),
    packageName: request.packageName,
    modClass,
    minecraft: versions.minecraft,
    loader: versions.loader,
    loom: versions.loom,
    loomPlugin: versions.loomPlugin,
    fabricApi: versions.fabricApi,
    javaRelease: String(versions.javaRelease),
    yarnProperty: versions.yarn && request.mappings === 'yarn' && !unobfuscated ? `yarn_mappings=${versions.yarn}` : '',
    mappingsLine,
    implementation: unobfuscated ? 'implementation' : 'modImplementation',
    exampleInit: example ? '\t\tModItems.register();\n' : '',
    langEntriesEn: lang('Example Item'),
    langEntriesZh: lang('示例物品')
  }
}

export function templatePath(path: string, values: Record<string, string>): string {
  const mapped = path
    .split(/[\\/]/)
    .map((part) => (part === 'gitignore' ? '.gitignore' : part))
    .join('/')
  return mapped
    .replaceAll('__package_path__', values.packageName.replaceAll('.', '/'))
    .replaceAll('__ModClass__', values.modClass)
    .replaceAll('__modid__', values.modId)
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full)))
    else out.push(full)
  }
  return out
}

async function isEmptyDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return true
  if (!(await stat(dir)).isDirectory()) return false
  return (await readdir(dir)).length === 0
}

export interface CreateProjectDeps {
  fetchText?: FetchText
  skipWrapper?: boolean
  javaPaths?: string[]
}

export async function createFabricProject(request: CreateFabricProjectRequest, deps: CreateProjectDeps = {}): Promise<CreateFabricProjectResult> {
  const modError = validateModId(request.modId)
  if (modError) throw new Error(modError)
  const packageError = validatePackageName(request.packageName)
  if (packageError) throw new Error(packageError)
  const projectDir = resolve(request.targetDir)
  if (!(await isEmptyDir(projectDir))) throw new Error(`目标目录不是空目录：${projectDir}`)
  const mappings: MappingFlavor = request.mappings ?? 'yarn'
  const versions = await resolveFabricVersions(request.minecraftVersion, { mappings, fetchText: deps.fetchText, overrides: request.versions })
  const example = exampleSupported(versions.minecraft)
  const values = templateValues({ modId: request.modId, packageName: request.packageName, modName: request.modName?.trim() || request.modId, mappings }, versions, example)
  const sources = ['base', ...(example ? [`example-${mappings}`, 'example-assets'] : [])]
  const files: string[] = []
  for (const source of sources) {
    const root = join(templatesDir(), 'fabric', source)
    for (const file of await walk(root)) {
      const target = join(projectDir, templatePath(relative(root, file), values))
      await mkdir(resolve(target, '..'), { recursive: true })
      await writeFile(target, renderTemplate(await readFile(file, 'utf8'), values))
      files.push(relative(projectDir, target).split(sep).join('/'))
    }
  }
  if (example) {
    const texture = join(projectDir, 'src', 'main', 'resources', 'assets', request.modId, 'textures', 'item', 'example_item.png')
    await mkdir(resolve(texture, '..'), { recursive: true })
    await writeFile(texture, encodePng(exampleItemTexture()))
    files.push(relative(projectDir, texture).split(sep).join('/'))
  }
  let javaPath = request.javaPath ?? null
  if (!javaPath) javaPath = pickJava(await detectJava(deps.javaPaths ?? []), versions.javaRelease)?.path ?? null
  let wrapperSource: CreateFabricProjectResult['wrapperSource'] = 'download'
  if (!deps.skipWrapper) {
    if (!javaPath) throw new Error(`需要 Java ${versions.javaRelease} 或更高版本来运行 Gradle，请先安装`)
    const source = await ensureWrapper(projectDir, versions.gradle, javaPath)
    wrapperSource = source === 'download' ? 'download' : 'local-gradle'
    files.push('gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties')
  }
  return { projectDir, versions, mappings, files: files.sort(), example, javaPath, wrapperSource }
}
