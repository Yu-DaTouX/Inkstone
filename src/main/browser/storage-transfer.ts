import type { CdpChannel } from './CdpChannel'
export type StorageTransferReport = { copied: number; failed: number; kind: 'localStorage' | 'sessionStorage' }
export async function transferPageStorage(source: CdpChannel, target: CdpChannel, kind: StorageTransferReport['kind']): Promise<StorageTransferReport> {
  const expression = `(() => { const s = ${kind}; const out = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k !== null) out[k] = s.getItem(k); } return out })()`
  const result = await source.send<{
    result?: { value?: Record<string, string | null> }
    exceptionDetails?: { text?: string }
  }>('Runtime.evaluate', { expression, returnByValue: true })
  if (result.exceptionDetails) {
    throw new Error(`读取 ${kind} 失败：${result.exceptionDetails.text ?? '页面脚本异常'}`)
  }
  const values = result.result?.value
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new Error(`读取 ${kind} 失败：页面未返回存储数据`)
  }
  const targetExpression = `(() => { const data = ${JSON.stringify(values)}; const s = ${kind}; let copied = 0; for (const [k, v] of Object.entries(data)) { try { if (v === null) s.removeItem(k); else s.setItem(k, v); copied++; } catch {} } return copied })()`
  const written = await target.send<{
    result?: { value?: number }
    exceptionDetails?: { text?: string }
  }>('Runtime.evaluate', { expression: targetExpression, returnByValue: true })
  if (written.exceptionDetails) return { copied: 0, failed: Object.keys(values).length, kind }
  const copied = Number(written.result?.value ?? 0)
  const total = Object.keys(values).length
  return { copied, failed: Math.max(0, total - (Number.isFinite(copied) ? copied : 0)), kind }
}
