import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import type { LoaderKind } from '../../shared/api.ts'
import type { CrashAction, CrashDiagnosis, CrashRecordSummary } from '../../shared/crash-api.ts'
import { buildCrashActions } from './actions.ts'
import { collectBundle, haystack, maskSecrets, normalizeExitCode, takeSnapshot, type CrashBundle, type CrashSnapshot } from './collect.ts'
import { diagnose, type DiagnosisResult } from './diagnose.ts'
import { modNames } from './mods.ts'
import { makeZip } from './zip.ts'

const SUMMARY_FILE = '摘要.txt'
const DIAGNOSIS_FILE = '诊断.json'
const PACK_FILE = '诊断包.zip'

export interface CrashRunOptions {
  folder: string
  versionId: string
  loader: LoaderKind
  gameDir: string
  javaPath: string | null
  maxMemoryMb: number
}

export interface CrashRunContext {
  options: CrashRunOptions
  snapshot: CrashSnapshot
  startedAt: number
}

export interface CrashFinishOptions {
  exitCode: number | null
  windowShown: boolean
  processLines: string[]
  launchArgs: string[]
  stopped: boolean
  actions?(input: { diagnosis: CrashDiagnosis; bundle: CrashBundle; result: DiagnosisResult }): CrashAction[]
}

export interface CrashAnalysis {
  diagnosis: CrashDiagnosis
  bundle: CrashBundle
}

function timestamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function recordName(at: number, versionId: string): string {
  const safe = versionId.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60)
  return `${timestamp(at)}-${safe}`
}

function crashReasons(options: CrashFinishOptions, bundle: CrashBundle): string[] {
  const reasons: string[] = []
  if (options.exitCode !== null && options.exitCode !== 0) reasons.push(`退出码 ${options.exitCode}`)
  if (!options.windowShown) reasons.push('游戏窗口没出现就退出了')
  if (bundle.crashReports.length > 0) reasons.push(`新的崩溃报告 ${bundle.crashReports.length} 份`)
  if (bundle.hsErr.length > 0) reasons.push(`hs_err ${bundle.hsErr.length} 份`)
  return reasons
}

export function summaryText(diagnosis: CrashDiagnosis, bundle: CrashBundle): string {
  const lines: Array<string | null> = [
    'Inkstone Minecraft 崩溃诊断',
    `版本：${diagnosis.versionId}（${diagnosis.loader}）`,
    `时间：${new Date(diagnosis.at).toLocaleString('zh-CN')}`,
    `退出码：${diagnosis.exitCode ?? 'null'}`,
    `游戏窗口出现：${diagnosis.windowShown ? '是' : '否'}`,
    '',
    diagnosis.rule ? `结论：${diagnosis.rule.explanation}` : '结论：没认出原因，下面是堆栈关键词。',
    diagnosis.rule ? `规则：${diagnosis.rule.id}（置信度 ${diagnosis.rule.confidence === 'high' ? '高' : '中'}）` : null,
    diagnosis.note ? `触发原因：${diagnosis.note}` : null,
    '',
    '证据：',
    ...(diagnosis.evidence.length > 0 ? diagnosis.evidence.slice(0, 10).map((line) => `  [${line.source}] ${line.text}`) : ['  （没有命中的日志片段）']),
    '',
    '嫌疑 Mod：',
    ...(diagnosis.suspects.length > 0 ? diagnosis.suspects.map((suspect) => `  ${suspect.name}（${suspect.fileName}，命中 ${suspect.hits} 次）：${suspect.reasons.join('；')}`) : ['  （没有对上号）']),
    '',
    `关键词：${diagnosis.keywords.join('、') || '无'}`,
    '',
    `启动参数：${bundle.launchArgs}`,
    '',
    '系统信息：',
    bundle.system,
    '',
    'Mod 清单：',
    bundle.modsList
  ]
  return maskSecrets(lines.filter((line): line is string => line !== null).join('\n'))
}

export interface CrashRetention {
  maxPerVersion: number
  maxTotalBytes: number
}

export const CRASH_RETENTION: CrashRetention = { maxPerVersion: 20, maxTotalBytes: 200 * 1024 * 1024 }

async function directoryBytes(dir: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await directoryBytes(path)
      continue
    }
    const info = await stat(path).catch(() => null)
    total += info?.size ?? 0
  }
  return total
}

export class CrashCenter {
  private readonly root: string
  private readonly retention: CrashRetention

  constructor(root: string, retention: Partial<CrashRetention> = {}) {
    this.root = root
    this.retention = { ...CRASH_RETENTION, ...retention }
  }

  async prune(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const records: Array<{ name: string; at: number; key: string; bytes: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(this.root, entry.name)
      const diagnosis = await this.readDiagnosis(dir)
      if (!diagnosis) continue
      records.push({ name: entry.name, at: diagnosis.at, key: `${diagnosis.folder.toLowerCase()}|${diagnosis.versionId}`, bytes: await directoryBytes(dir) })
    }
    records.sort((a, b) => b.at - a.at)
    const groups = new Map<string, typeof records>()
    for (const record of records) {
      const list = groups.get(record.key) ?? []
      list.push(record)
      groups.set(record.key, list)
    }
    const keep = new Set<string>()
    for (const list of groups.values()) for (const record of list.slice(0, this.retention.maxPerVersion)) keep.add(record.name)
    let total = 0
    for (const record of records) {
      if (!keep.has(record.name)) continue
      total += record.bytes
      if (total > this.retention.maxTotalBytes) keep.delete(record.name)
    }
    const removed: string[] = []
    for (const record of records) {
      if (keep.has(record.name)) continue
      await rm(join(this.root, record.name), { recursive: true, force: true })
      removed.push(record.name)
    }
    return removed
  }

  async begin(options: CrashRunOptions): Promise<CrashRunContext> {
    return { options, snapshot: await takeSnapshot(options.gameDir), startedAt: Date.now() }
  }

  async finish(context: CrashRunContext, options: CrashFinishOptions): Promise<CrashAnalysis | null> {
    const bundle = await collectBundle({
      ...context.options,
      processLines: options.processLines,
      launchArgs: options.launchArgs,
      snapshot: context.snapshot,
      exitCode: options.exitCode,
      windowShown: options.windowShown
    })
    const crashed = bundle.crashReports.length > 0 || bundle.hsErr.length > 0 || (!options.windowShown && !options.stopped) || (options.exitCode !== null && options.exitCode !== 0)
    if (!crashed || options.stopped) return null
    const result = diagnose({ text: haystack(bundle), loader: context.options.loader, mods: bundle.mods, sources: bundle.sources })
    const at = Date.now()
    const id = recordName(at, context.options.versionId)
    const recordDir = join(this.root, id)
    const diagnosis: CrashDiagnosis = {
      id,
      at,
      folder: context.options.folder,
      versionId: context.options.versionId,
      loader: context.options.loader,
      exitCode: normalizeExitCode(options.exitCode),
      windowShown: options.windowShown,
      rule: result.rule,
      keywords: result.keywords,
      suspects: result.suspects,
      missing: result.outcome?.missing ?? [],
      evidence: result.evidence,
      actions: [],
      recordDir,
      note: crashReasons(options, bundle).join('；')
    }
    diagnosis.actions = options.actions
      ? options.actions({ diagnosis, bundle, result })
      : buildCrashActions({
          rule: result.rule,
          suspects: result.suspects,
          missing: result.outcome?.missing ?? [],
          names: modNames(bundle.mods),
          javas: [],
          javaPath: context.options.javaPath,
          requiredMajor: null,
          maxMemoryMb: context.options.maxMemoryMb,
          totalMemMb: Math.round(totalmem() / 1024 / 1024)
        })
    await mkdir(join(recordDir, 'crash-reports'), { recursive: true })
    await mkdir(join(recordDir, 'hs_err'), { recursive: true })
    await writeFile(join(recordDir, SUMMARY_FILE), summaryText(diagnosis, bundle), 'utf8')
    await writeFile(join(recordDir, DIAGNOSIS_FILE), maskSecrets(JSON.stringify(diagnosis, null, 2)), 'utf8')
    await writeFile(join(recordDir, '进程输出.log'), maskSecrets(bundle.processText), 'utf8')
    await writeFile(join(recordDir, 'latest.log'), maskSecrets(bundle.latestLog), 'utf8')
    await writeFile(join(recordDir, '系统信息.txt'), bundle.system, 'utf8')
    await writeFile(join(recordDir, 'Mod 清单.txt'), bundle.modsList, 'utf8')
    await writeFile(join(recordDir, '启动参数.txt'), bundle.launchArgs, 'utf8')
    for (const report of bundle.crashReports) await writeFile(join(recordDir, 'crash-reports', report.name), maskSecrets(report.text), 'utf8')
    for (const log of bundle.hsErr) await writeFile(join(recordDir, 'hs_err', log.name), maskSecrets(log.text), 'utf8')
    await this.prune().catch(() => [])
    return { diagnosis, bundle }
  }

  private async readDiagnosis(recordDir: string): Promise<CrashDiagnosis | null> {
    try {
      const diagnosis = JSON.parse(await readFile(join(recordDir, DIAGNOSIS_FILE), 'utf8')) as CrashDiagnosis
      return { ...diagnosis, recordDir }
    } catch {
      return null
    }
  }

  async list(folder: string, versionId: string): Promise<CrashRecordSummary[]> {
    let names: string[]
    try {
      names = (await readdir(this.root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
    const records: CrashRecordSummary[] = []
    for (const name of names) {
      const diagnosis = await this.readDiagnosis(join(this.root, name))
      if (!diagnosis || diagnosis.folder !== folder || diagnosis.versionId !== versionId) continue
      records.push({
        id: diagnosis.id,
        at: diagnosis.at,
        versionId: diagnosis.versionId,
        ruleId: diagnosis.rule?.id ?? null,
        title: diagnosis.rule?.explanation ?? '没认出原因',
        exitCode: diagnosis.exitCode
      })
    }
    return records.sort((a, b) => b.at - a.at)
  }

  async latest(folder: string, versionId: string): Promise<CrashDiagnosis | null> {
    const [first] = await this.list(folder, versionId)
    return first ? this.get(folder, versionId, first.id) : null
  }

  async get(folder: string, versionId: string, id: string): Promise<CrashDiagnosis | null> {
    if (!id || id === '.' || id === '..' || /[\\/:*?"<>|]/.test(id)) return null
    const diagnosis = await this.readDiagnosis(join(this.root, id))
    return diagnosis && diagnosis.folder === folder && diagnosis.versionId === versionId ? diagnosis : null
  }

  async exportRecord(folder: string, versionId: string, id: string): Promise<{ path: string; bytes: number } | null> {
    const diagnosis = await this.get(folder, versionId, id)
    if (!diagnosis) return null
    const recordDir = join(this.root, id)
    const files: Array<{ name: string; data: Buffer }> = []
    const collectDir = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === PACK_FILE) continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) await collectDir(path, `${prefix}${entry.name}/`)
        else files.push({ name: `${prefix}${entry.name}`, data: await readFile(path) })
      }
    }
    await collectDir(recordDir, '')
    const zipPath = join(recordDir, PACK_FILE)
    const data = makeZip(files)
    await writeFile(zipPath, data)
    return { path: zipPath, bytes: data.length }
  }
}
