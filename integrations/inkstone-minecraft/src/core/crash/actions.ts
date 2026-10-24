import type { JavaEntry } from '../../shared/api.ts'
import type { CrashAction, CrashRuleMatch, CrashSuspect } from '../../shared/crash-api.ts'
import { modLabel } from './mods.ts'
import { ruleById } from './rules.ts'

export interface CrashActionContext {
  rule: CrashRuleMatch | null
  suspects: CrashSuspect[]
  missing: string[]
  names: Map<string, string>
  javas: JavaEntry[]
  javaPath: string | null
  requiredMajor: number | null
  maxMemoryMb: number
  totalMemMb: number
}

function memoryLabel(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`
}

export function suggestMemoryMb(maxMemoryMb: number, totalMemMb: number): number {
  const cap = Math.max(1024, Math.floor((totalMemMb * 0.75) / 256) * 256)
  const doubled = Math.max(maxMemoryMb * 2, 2048)
  return doubled <= cap ? doubled : Math.min(cap, maxMemoryMb + 1024)
}

function javaCandidate(context: CrashActionContext): JavaEntry | null {
  const candidates = context.javas
    .filter((java) => java.path.toLowerCase() !== (context.javaPath ?? '').toLowerCase())
    .filter((java) => context.requiredMajor === null || java.majorVersion >= context.requiredMajor)
    .sort((a, b) => a.majorVersion - b.majorVersion)
  return candidates[0] ?? null
}

function declareName(names: Map<string, string>, id: string): string {
  return modLabel(names, id).replace(/（.*）$/, '')
}

export function buildCrashActions(context: CrashActionContext): CrashAction[] {
  const actions: CrashAction[] = []
  const rule = context.rule ? ruleById(context.rule.id) : null
  const kinds = new Set(rule?.actions ?? ['mods', 'export'])
  if (kinds.has('install-deps') && context.missing.length > 0) {
    actions.push({
      kind: 'install-deps',
      label: `补全依赖（${context.missing.map((id) => declareName(context.names, id)).join('、')}）`,
      hint: '从 Modrinth 下载到 mods 目录',
      value: context.missing.join(',')
    })
  }
  if (kinds.has('java')) {
    const java = javaCandidate(context)
    if (java) {
      actions.push({
        kind: 'java',
        label: `换用 Java ${java.majorVersion}`,
        hint: java.path,
        value: java.path
      })
    }
  }
  if (kinds.has('memory')) {
    const suggested = suggestMemoryMb(context.maxMemoryMb, context.totalMemMb)
    if (suggested > context.maxMemoryMb) {
      actions.push({ kind: 'memory', label: `调高内存到 ${memoryLabel(suggested)}`, hint: `当前 ${memoryLabel(context.maxMemoryMb)}`, value: String(suggested) })
    }
  }
  if (kinds.has('disable-mod') && context.suspects.length > 0) {
    const suspect = context.suspects[0]
    actions.push({ kind: 'disable-mod', label: `停用 ${suspect.name}`, hint: suspect.fileName, value: suspect.fileName })
  }
  if (kinds.has('repair')) actions.push({ kind: 'repair', label: '去修复版本文件', hint: '版本页 → 修复', value: null })
  if (kinds.has('mods')) actions.push({ kind: 'mods', label: '打开 Mod 管理', hint: null, value: null })
  actions.push({ kind: 'export', label: '导出报告', hint: 'zip 诊断包', value: null })
  return actions
}
