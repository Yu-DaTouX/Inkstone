import type { ScrollPosition } from './InputController'

export interface BrowserDialogRecord {
  type: string
  message: string
  accepted: boolean
  unsupported?: boolean
}

export interface BrowserActionOptions {
  dialog?: 'accept' | 'dismiss'
}

export interface BrowserActionReceipt {
  dialogs?: BrowserDialogRecord[]
  openedTabs?: { id: string; url: string }[]
  downloadStarted?: string
  value?: string | null
  picker?: string
  scroll?: ScrollPosition
}

export function receiptSummary(receipt: BrowserActionReceipt | undefined): Record<string, unknown> {
  if (!receipt) return {}
  const out: Record<string, unknown> = {}
  if (receipt.dialogs?.length) out.dialogs = receipt.dialogs
  if (receipt.openedTabs?.length) out.openedTabs = receipt.openedTabs
  if (receipt.downloadStarted) out.downloadStarted = receipt.downloadStarted
  if (receipt.value !== undefined) out.value = receipt.value
  if (receipt.picker) out.picker = receipt.picker
  if (receipt.scroll) out.scroll = receipt.scroll
  return out
}
