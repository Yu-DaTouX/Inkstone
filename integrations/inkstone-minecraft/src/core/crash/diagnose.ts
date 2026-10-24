import type { LoaderKind } from '../../shared/api.ts'
import type { CrashEvidence, CrashRuleMatch, CrashSuspect } from '../../shared/crash-api.ts'
import type { CrashSourceText } from './collect.ts'
import { type ModFileInfo, modNames } from './mods.ts'
import { applicableRules, type RuleOutcome } from './rules.ts'

const EVIDENCE_LIMIT = 24
const SUSPECT_LIMIT = 5
const KEYWORD_LIMIT = 8

export interface DiagnosisInput {
  text: string
  loader: LoaderKind
  mods: ModFileInfo[]
  sources: CrashSourceText[]
}

export interface DiagnosisResult {
  rule: CrashRuleMatch | null
  outcome: RuleOutcome | null
  suspects: CrashSuspect[]
  keywords: string[]
  evidence: CrashEvidence[]
}

function isStackLine(line: string): boolean {
  return /^\s+at [\w$.]+\(/.test(line) || /^\s+\.\.\. \d+ more/.test(line) || /^Caused by:/.test(line) || /^\s*Suppressed:/.test(line)
}

function pickEvidence(sources: CrashSourceText[], pattern: RegExp): CrashEvidence[] {
  const evidence: CrashEvidence[] = []
  for (const source of sources) {
    const lines = source.text.split(/\r?\n/)
    for (let index = 0; index < lines.length && evidence.length < EVIDENCE_LIMIT; index++) {
      const line = lines[index]
      if (!pattern.test(line)) continue
      evidence.push({ source: source.source, text: line })
      for (let next = index + 1; next < lines.length && next <= index + 4 && evidence.length < EVIDENCE_LIMIT; next++) {
        if (!isStackLine(lines[next])) break
        evidence.push({ source: source.source, text: lines[next] })
      }
    }
    if (evidence.length >= EVIDENCE_LIMIT) break
  }
  return evidence
}

function countHits(lines: string[], needle: string, weight: number): number {
  const lowered = needle.toLowerCase()
  let hits = 0
  for (const line of lines) {
    if (!line.toLowerCase().includes(lowered)) continue
    hits += isStackLine(line) ? weight * 2 : weight
  }
  return hits
}

export function findSuspects(text: string, mods: ModFileInfo[]): CrashSuspect[] {
  const lines = text.split(/\r?\n/)
  const suspects: CrashSuspect[] = []
  for (const mod of mods) {
    let hits = 0
    const reasons: string[] = []
    if (mod.modId && mod.modId.length > 2) {
      const modHits = countHits(lines, mod.modId, 1)
      if (modHits > 0) {
        hits += modHits
        reasons.push('modid 出现在日志里')
      }
    }
    for (const prefix of mod.packages) {
      const hits_ = countHits(lines, prefix, 3)
      if (hits_ > 0) {
        hits += hits_
        reasons.push(`包名 ${prefix} 出现在堆栈`)
        break
      }
    }
    for (const config of mod.mixins) {
      const hits_ = countHits(lines, config, 3)
      if (hits_ > 0) {
        hits += hits_
        reasons.push(`Mixin 配置 ${config} 出现在日志里`)
        break
      }
    }
    if (hits === 0) continue
    suspects.push({ modId: mod.modId ?? mod.fileName, name: mod.name ?? mod.modId ?? mod.fileName, fileName: mod.fileName, hits, reasons })
  }
  return suspects.sort((a, b) => b.hits - a.hits || a.fileName.localeCompare(b.fileName)).slice(0, SUSPECT_LIMIT)
}

export function findKeywords(text: string): string[] {
  const keywords: string[] = []
  const add = (value: string): void => {
    if (keywords.length < KEYWORD_LIMIT && !keywords.includes(value)) keywords.push(value)
  }
  for (const match of text.matchAll(/Caused by: ([\w$.]+(?:Exception|Error|Throwable)[\w$]*)/g)) add(match[1])
  for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:Exception|Error))\b/g)) add(match[1])
  for (const match of text.matchAll(/\b([\w.-]+\.mixins?\.json)\b/g)) add(match[1])
  for (const match of text.matchAll(/^\s*at ([\w$.]+)\(/gm)) add(match[1])
  return keywords
}

export function diagnose(input: DiagnosisInput): DiagnosisResult {
  const text = input.text
  const names = modNames(input.mods)
  const rule = applicableRules(input.loader).find((candidate) => candidate.match.some((pattern) => pattern.test(text))) ?? null
  const outcome = rule ? rule.describe({ text, names }) : null
  const evidence = rule ? pickEvidence(input.sources, new RegExp(rule.evidence.source, rule.evidence.flags)) : []
  return {
    rule: rule
      ? {
          id: rule.id,
          title: rule.title,
          explanation: outcome?.summary ?? rule.title,
          confidence: rule.confidence,
          evidence
        }
      : null,
    outcome,
    suspects: findSuspects(text, input.mods),
    keywords: findKeywords(text),
    evidence
  }
}
