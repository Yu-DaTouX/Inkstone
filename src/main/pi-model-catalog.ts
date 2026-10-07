/*
 * 随包 pi 自带模型目录的能力摘要（能否思考、协议、上下文、输出上限）。
 *
 * 文件由 scripts/gen-pi-model-catalog.mjs 从当前随包 pi 生成，放在薄层资源旁边：
 * 内置 Command Code 扩展在 pi 进程里读同一份，主进程在接入自定义服务时读它。
 * 找不到文件（资源漏打包）时返回空表 —— 接入照常进行，只是不能自动标出能否思考。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PiModelCatalog } from '../shared/custom-provider'

const FILE = join('generated', 'pi-model-catalog.json')
let cached: Promise<PiModelCatalog> | undefined

function catalogPath(): string | undefined {
  const here = fileURLToPath(new URL('.', import.meta.url))
  return [
    process.resourcesPath ? join(process.resourcesPath, 'yan-thin', FILE) : '',
    join(here, '..', '..', 'resources', 'pi-extensions', FILE),
    join(process.cwd(), 'resources', 'pi-extensions', FILE)
  ].find((path) => path && existsSync(path))
}

export function readPiModelCatalog(): Promise<PiModelCatalog> {
  cached ??= (async () => {
    const path = catalogPath()
    if (!path) return {}
    try {
      const json = JSON.parse(await readFile(path, 'utf8')) as { models?: PiModelCatalog }
      return json.models ?? {}
    } catch {
      return {}
    }
  })()
  return cached
}
