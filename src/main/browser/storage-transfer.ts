import type { CdpChannel } from './CdpChannel'
export type StorageTransferReport = { copied: number; failed: number; kind: 'localStorage' | 'sessionStorage' }
export async function transferPageStorage(source: CdpChannel, target: CdpChannel, kind: StorageTransferReport['kind']): Promise<StorageTransferReport> {
  const expression = `(() => { const s = ${kind}; const out = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k !== null) out[k] = s.getItem(k); } return out })()`
  const result = await source.send<{ result?: { value?: Record<string, string | null> } }>('Runtime.evaluate', { expression, returnByValue: true })
  const values = result.result?.value ?? {}
  const targetExpression = `(() => { const data = ${JSON.stringify(values)}; const s = ${kind}; let copied = 0; for (const [k, v] of Object.entries(data)) { try { if (v === null) s.removeItem(k); else s.setItem(k, v); copied++; } catch {} } return copied })()`
  const written = await target.send<{ result?: { value?: number } }>('Runtime.evaluate', { expression: targetExpression, returnByValue: true })
  const copied = Number(written.result?.value ?? 0)
  return { copied, failed: Object.keys(values).length - copied, kind }
}
