import type { InstanceInfo, JavaEntry, LoaderKind } from '../../shared/api.ts'
import type { PreflightItem, PreflightReport } from '../../shared/launch-api.ts'
import { pickJava } from '../java.ts'
import { duplicateModIds, missingDependencies, modLabel, modNames, scanMods } from './mods.ts'

export interface PreflightInput {
  versionId: string
  loader: LoaderKind
  instance: InstanceInfo
  javas: JavaEntry[]
  javaPath: string | null
  accountName: string | null
  maxMemoryMb: number
  totalMemMb: number
  modsDir: string
  missingFiles: number | null
}

function memoryLabel(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`
}

export function filesItem(missing: number | null): PreflightItem {
  if (missing === null) return { id: 'files', level: 'ok', title: '文件检查跳过', detail: '', action: null, value: null }
  if (missing === 0) return { id: 'files', level: 'ok', title: '文件完整', detail: '', action: null, value: null }
  return {
    id: 'files',
    level: 'warn',
    title: `缺 ${missing} 个文件`,
    detail: '启动时会自动补全，补不齐就停下',
    action: 'repair',
    value: null
  }
}

export async function preflightLaunch(input: PreflightInput): Promise<PreflightReport> {
  const items: PreflightItem[] = []
  items.push(
    input.accountName
      ? { id: 'account', level: 'ok', title: `账号 ${input.accountName}`, detail: '', action: null, value: null }
      : { id: 'account', level: 'block', title: '还没有账号', detail: '先添加一个离线账号', action: null, value: null }
  )

  const chosen = input.javaPath ?? pickJava(input.javas, input.instance.javaMajor)?.path ?? null
  const chosenJava = chosen ? input.javas.find((java) => java.path === chosen) ?? null : null
  const required = input.instance.javaMajor
  if (!chosen) {
    items.push({
      id: 'java',
      level: 'block',
      title: `没有找到 Java ${required ?? ''}`.trim(),
      detail: '在设置 → Java 里添加一个 Java 21',
      action: 'java',
      value: null
    })
  } else if (required !== null && chosenJava && chosenJava.majorVersion < required) {
    items.push({
      id: 'java',
      level: 'block',
      title: `Java 版本太低：需要 ${required}，当前 ${chosenJava.majorVersion}`,
      detail: chosen,
      action: 'java',
      value: chosen
    })
  } else {
    items.push({
      id: 'java',
      level: 'ok',
      title: chosenJava ? `Java ${chosenJava.majorVersion}` : 'Java 已指定',
      detail: chosen,
      action: null,
      value: null
    })
  }

  const limit = Math.floor(input.totalMemMb * 0.75)
  if (input.maxMemoryMb > limit) {
    items.push({
      id: 'memory',
      level: 'warn',
      title: `内存上限 ${memoryLabel(input.maxMemoryMb)} 超过物理内存的 75%`,
      detail: `物理内存 ${memoryLabel(input.totalMemMb)}，建议降到 ${memoryLabel(limit)}`,
      action: 'memory',
      value: String(input.maxMemoryMb)
    })
  } else if (input.maxMemoryMb < 512) {
    items.push({ id: 'memory', level: 'warn', title: `内存上限只有 ${memoryLabel(input.maxMemoryMb)}`, detail: '带 Mod 的版本至少给 2 GB', action: 'memory', value: String(input.maxMemoryMb) })
  } else {
    items.push({ id: 'memory', level: 'ok', title: `内存上限 ${memoryLabel(input.maxMemoryMb)}`, detail: '', action: null, value: null })
  }

  const mods = await scanMods(input.modsDir)
  const issues = missingDependencies(mods)
  if (issues.length > 0) {
    const names = modNames(mods)
    const first = issues[0]
    const missing = [...new Set(issues.flatMap((issue) => issue.missing))]
    items.push({
      id: 'deps',
      level: 'warn',
      title: `缺 ${missing.length} 个前置 Mod`,
      detail: `${first.name} 需要 ${missing.map((id) => modLabel(names, id)).join('、')}`,
      action: 'install-deps',
      value: missing.join(',')
    })
  } else {
    items.push({ id: 'deps', level: 'ok', title: mods.length > 0 ? `${mods.filter((mod) => mod.enabled).length} 个 Mod 依赖齐全` : '没有 Mod', detail: '', action: null, value: null })
  }

  const duplicates = duplicateModIds(mods)
  if (duplicates.length > 0) {
    items.push({
      id: 'duplicates',
      level: 'warn',
      title: `重复载入 ${duplicates.length} 个 Mod`,
      detail: `${duplicates[0].modId}：${duplicates[0].files.join('、')}`,
      action: 'disable-mod',
      value: duplicates[0].files[1] ?? null
    })
  }

  items.push(filesItem(input.missingFiles))
  return {
    versionId: input.versionId,
    loader: input.loader,
    blocked: items.some((item) => item.level === 'block'),
    items,
    javaPath: chosen,
    javaMajor: chosenJava?.majorVersion ?? null,
    maxMemoryMb: input.maxMemoryMb
  }
}
