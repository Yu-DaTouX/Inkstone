import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  consentKeyOf,
  emptyConsentLedger,
  parseConsentLedger,
  recordConsent,
  type ConsentDecision,
  type ConsentKeyParts,
  type ConsentLedger
} from '../shared/tool-consent'
import { YAN_DIR } from './paths'

const LEDGER_PATH = join(YAN_DIR, 'tool-consent.json')

let queue: Promise<unknown> = Promise.resolve()

export function localDeviceId(): string {
  return `host:${hostname().toLowerCase()}`
}

export async function readConsentLedger(path = LEDGER_PATH): Promise<ConsentLedger> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConsentLedger()
    throw error
  }
  return parseConsentLedger(JSON.parse(text))
}

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

