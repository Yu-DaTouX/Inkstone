import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { gradleUserHome } from './gradle.ts'
import { ZipReader } from './zip.ts'

export interface TextureSource {
  source: string
  bytes: Buffer
  mcmeta: string | null
}

export function textureWriteDir(resourceDirs: string[], namespace: string): string {
  return (
    resourceDirs.find((dir) => existsSync(join(dir, 'assets', namespace))) ??
    resourceDirs.find((dir) => /[\\/]main[\\/]resources$/.test(dir)) ??
    resourceDirs[0]
  )
}

export function texturePathFromId(ref: string): string | null {
  const match = ref.match(/^([a-z0-9_.-]+):([a-z0-9_./-]+)$/)
  if (!match) return null
  let path = match[2]
  if (!path.startsWith('textures/')) path = `textures/${path}`
  if (!path.endsWith('.png')) path = `${path}.png`
  return `assets/${match[1]}/${path}`
}

export async function loadTexture(ref: string, options: { projectDir: string; resourceDirs: string[]; minecraft: string | null; userHome?: string }): Promise<TextureSource> {
  const looksLikeFile = /\.png$/i.test(ref) && (isAbsolute(ref) || ref.includes('/') || ref.includes('\\')) && !/^[a-z0-9_.-]+:[a-z]/.test(ref)
  if (looksLikeFile) {
    const file = isAbsolute(ref) ? ref : resolve(options.projectDir, ref)
    if (!existsSync(file)) throw new Error(`找不到贴图文件 ${file}`)
    const meta = `${file}.mcmeta`
    return { source: file, bytes: await readFile(file), mcmeta: existsSync(meta) ? await readFile(meta, 'utf8') : null }
  }
  const path = texturePathFromId(ref)
  if (!path) throw new Error(`无法识别的贴图引用：${ref}（用 命名空间:路径，例如 minecraft:block/stone 或 mymod:item/ruby，或者给 png 文件路径）`)
  for (const dir of options.resourceDirs) {
    const file = join(dir, ...path.split('/'))
    if (existsSync(file)) return { source: file, bytes: await readFile(file), mcmeta: existsSync(`${file}.mcmeta`) ? await readFile(`${file}.mcmeta`, 'utf8') : null }
  }
  if (options.minecraft) {
    const jar = join(options.userHome ?? gradleUserHome(), 'caches', 'fabric-loom', options.minecraft, 'minecraft-client.jar')
    if (existsSync(jar)) {
      const zip = await ZipReader.open(jar)
      const bytes = await zip.read(path)
      if (bytes) {
        const meta = await zip.read(`${path}.mcmeta`)
        return { source: `${jar}!/${path}`, bytes, mcmeta: meta ? meta.toString('utf8') : null }
      }
    }
  }
  throw new Error(`在项目资源和 Minecraft ${options.minecraft ?? ''} 客户端里都没找到 ${path}`)
}
