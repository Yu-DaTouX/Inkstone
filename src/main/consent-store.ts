/**
 * 普通工具同意记录的落盘（需求稿 4.3）。规则在 `shared/tool-consent.ts`，这里只管读写。
 *
 * 单文件 `YAN_DIR/tool-consent.json`，写入排队 + 临时文件改名，避免并发请求互相覆盖。
 * 不依赖 electron：AgentController 会被纯 Node 单测加载。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  consentKeyOf,
  consentVerdict,
  emptyConsentLedger,
  parseConsentLedger,
  recordConsent,
  type ConsentDecision,
  type ConsentEntryView,
  type ConsentKeyParts,
  type ConsentLedger
} from '../shared/tool-consent'
import { YAN_DIR } from './paths'

const LEDGER_PATH = join(YAN_DIR, 'tool-consent.json')

let queue: Promise<unknown> = Promise.resolve()

/** 本机设备标识：能力记录绑定设备，换一台电脑不沿用 */
export function localDeviceId(): string {
  return `host:${hostname().toLowerCase()}`
}

export async function readConsentLedger(path = LEDGER_PATH): Promise<ConsentLedger> {
  try {
    return parseConsentLedger(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return emptyConsentLedger()
  }
}

/** 串行地读—改—写 */
export function updateConsentLedger(mutate: (ledger: ConsentLedger) => ConsentLedger, path = LEDGER_PATH): Promise<ConsentLedger> {
  const task = queue.then(async () => {
    const next = mutate(await readConsentLedger(path))
    await mkdir(dirname(path), { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    await writeFile(temp, JSON.stringify(next, null, 2), 'utf8')
    try {
      await rename(temp, path)
    } catch {
      await writeFile(path, JSON.stringify(next, null, 2), 'utf8')
    }
    return next
  })
  queue = task.catch(() => undefined)
  return task
}

export function recordConsentAnswer(parts: ConsentKeyParts, decision: ConsentDecision): Promise<ConsentLedger> {
  return updateConsentLedger((ledger) => recordConsent(ledger, parts, decision, Date.now()))
}

export function markConsentAuto(parts: ConsentKeyParts): Promise<ConsentLedger> {
  const key = consentKeyOf(parts)
  return updateConsentLedger((ledger) => ({
    ...ledger,
    entries: ledger.entries.map((entry) => (entry.key === key ? { ...entry, lastAutoAt: Date.now() } : entry))
  }))
}

export async function listConsentViews(): Promise<ConsentEntryView[]> {
  const ledger = await readConsentLedger()
  const now = Date.now()
  return ledger.entries
    .map((entry) => ({
      key: entry.key,
      parts: entry.parts,
      verdict: consentVerdict(entry, entry.parts, now),
      ...(entry.override ? { override: entry.override } : {}),
      ...(entry.lastAutoAt ? { lastAutoAt: entry.lastAutoAt } : {}),
      ...(entry.records.length ? { lastAnswerAt: entry.records[entry.records.length - 1].at } : {})
    }))
    .sort((a, b) => (b.lastAnswerAt ?? 0) - (a.lastAnswerAt ?? 0))
}

/** 用户在设置页：设为始终询问 / 恢复按记录判断 / 清空这一类的记录 */
export function changeConsentEntry(key: string, action: 'always-ask' | 'allow-auto' | 'forget'): Promise<ConsentLedger> {
  return updateConsentLedger((ledger) => ({
    ...ledger,
    entries:
      action === 'forget'
        ? ledger.entries.filter((entry) => entry.key !== key)
        : ledger.entries.map((entry) => {
            if (entry.key !== key) return entry
            if (action === 'always-ask') return { ...entry, override: 'always-ask' as const }
            const { override: _override, ...rest } = entry
            return rest
          })
  }))
}
