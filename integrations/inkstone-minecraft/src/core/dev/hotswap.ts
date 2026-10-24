import { readFile } from 'node:fs/promises'
import type { HotswapResult } from '../../shared/dev-api.ts'
import { classSignature, describeJdwpError, JdwpClient, JdwpError, SCHEMA_ERRORS } from './jdwp.ts'
import { classNameOf, findInRoots, isMixinClass, type ManifestDiff } from './manifest.ts'

export interface HotswapInput {
  jdwpPort: number
  classRoots: string[]
  diff: ManifestDiff
  mixinPackages: string[]
  mixinHotswap?: boolean
}

export interface HotswapOutcome extends HotswapResult {
  failedPaths: string[]
}

export async function hotswapClasses(input: HotswapInput, connect: (port: number) => Promise<JdwpClient> = (port) => JdwpClient.connect(port)): Promise<HotswapOutcome> {
  const result: HotswapOutcome = {
    swapped: [],
    added: input.diff.added.filter((path) => path.endsWith('.class')).map(classNameOf),
    removed: input.diff.removed.filter((path) => path.endsWith('.class')).map(classNameOf),
    skippedNotLoaded: [],
    restartNeeded: false,
    restartReasons: [],
    failedPaths: []
  }
  const changed = input.diff.changed.filter((path) => path.endsWith('.class'))
  const mixinNames = new Set(changed.filter((path) => isMixinClass(classNameOf(path), input.mixinPackages)).map(classNameOf))
  const mixins = input.mixinHotswap ? [] : changed.filter((path) => mixinNames.has(classNameOf(path)))
  for (const path of mixins) {
    result.restartNeeded = true
    result.restartReasons.push({ reason: 'mixin', detail: `Mixin 类 ${classNameOf(path)} 改动后要重启才能重新织入` })
    result.failedPaths.push(path)
  }
  const regular = changed.filter((path) => !mixins.includes(path))
  if (!regular.length) return result
  let client: JdwpClient
  try {
    client = await connect(input.jdwpPort)
  } catch (error) {
    result.restartNeeded = true
    result.restartReasons.push({ reason: 'jdwp-unavailable', detail: error instanceof Error ? error.message : String(error) })
    result.failedPaths.push(...regular)
    return result
  }
  try {
    const entries: Array<{ path: string; name: string; typeId: bigint; bytes: Buffer }> = []
    for (const path of regular) {
      const name = classNameOf(path)
      const loaded = await client.classesBySignature(classSignature(name))
      if (!loaded.length) {
        result.skippedNotLoaded.push(name)
        continue
      }
      const file = findInRoots(input.classRoots, path)
      if (!file) continue
      const bytes = await readFile(file)
      for (const type of loaded) entries.push({ path, name, typeId: type.typeId, bytes })
    }
    if (!entries.length) return result
    try {
      await client.redefineClasses(entries)
      result.swapped.push(...new Set(entries.map((entry) => entry.name)))
      return result
    } catch (error) {
      if (!(error instanceof JdwpError)) throw error
    }
    const byClass = new Map<string, typeof entries>()
    for (const entry of entries) byClass.set(entry.name, [...(byClass.get(entry.name) ?? []), entry])
    for (const [name, group] of byClass) {
      try {
        await client.redefineClasses(group)
        result.swapped.push(name)
      } catch (error) {
        const code = error instanceof JdwpError ? error.code : -1
        result.restartNeeded = true
        result.restartReasons.push({
          reason: mixinNames.has(name) ? 'mixin' : SCHEMA_ERRORS.has(code) ? 'schema-change' : 'redefine-failed',
          detail: `${name}：${code >= 0 ? describeJdwpError(code) : error instanceof Error ? error.message : String(error)}${mixinNames.has(name) ? '（Mixin 热替换只支持改方法体，详情用 mc_logs filter=MixinAgent 查看）' : ''}`
        })
        result.failedPaths.push(group[0].path)
      }
    }
    return result
  } finally {
    await client.dispose()
  }
}
