import {
  isPanePopoutTab,
  isPopoutSupported,
  PANE_TRANSFER_MATRIX,
  type PaneActionEvent,
  type PaneBranchRow,
  type PaneChangeRow,
  type PaneContextSegment,
  type PaneFileRow,
  type PanePopoutAnyTabId,
  type PanePopoutLocale,
  type PanePopoutOpenRequest,
  type PanePopoutOpenResult,
  type PanePopoutOwner,
  type PanePopoutTabId,
  type PaneProjection
} from '../../../../shared/pane-popout'
import type { PanePopoutBridge } from '../../../auxwin/pane-bridge'
import type { PaneTerminalBridge, PaneTerminalOpenResult } from '../../../../shared/pane-terminal'
import type { WorkspaceOwner } from './types'

export interface PanePopoutSnapshot {
  locale?: PanePopoutLocale
  files?: { root: string; rows: PaneFileRow[]; truncated?: boolean; note?: string }
  changes?: { repo: string | null; branch?: string; rows: PaneChangeRow[]; note?: string }
  context?: { usedTokens: number; windowTokens: number; known: boolean; segments: PaneContextSegment[]; note?: string }
  branch?: { rows: PaneBranchRow[]; note?: string }
}

export interface PanePopoutDataSource {
  snapshot(): PanePopoutSnapshot
  onAction?(event: PaneActionEvent): void
}

export interface PanePopoutClient {
  canPopout(tab: PanePopoutAnyTabId): boolean
  isOpen(tab: PanePopoutAnyTabId): boolean
  open(tab: PanePopoutAnyTabId, owner: WorkspaceOwner, options?: { viewId?: string; terminalId?: string }): Promise<PanePopoutOpenResult>
  openTerminal(owner: WorkspaceOwner, terminalId: string): Promise<PaneTerminalOpenResult>
  canPopoutTerminal(): boolean
  refresh(tab?: PanePopoutTabId): void
  close(tab: PanePopoutAnyTabId): void
  dispose(): void
}

export function ownerToPanePopout(owner: WorkspaceOwner): PanePopoutOwner {
  return {
    key: owner.key,
    sessionId: owner.sessionId,
    ...(owner.sessionFile ? { sessionFile: owner.sessionFile } : {}),
    cwd: owner.cwd,
    ...(owner.runId ? { runId: owner.runId } : {}),
    ...(owner.generation === undefined ? {} : { generation: owner.generation }),
    active: owner.active
  }
}

export function projectionFromSnapshot(tab: PanePopoutTabId, snapshot: PanePopoutSnapshot): PaneProjection | null {
  switch (tab) {
    case 'files':
      return snapshot.files ? { kind: 'files', ...snapshot.files } : null
    case 'changes':
      return snapshot.changes ? { kind: 'changes', ...snapshot.changes } : null
    case 'context':
      return snapshot.context ? { kind: 'context', ...snapshot.context } : null
    case 'branch':
      return snapshot.branch ? { kind: 'branch', ...snapshot.branch } : null
    default:
      return null
  }
}

export function createPanePopoutClient(options: {
  bridge: PanePopoutBridge
  source: PanePopoutDataSource
  terminalBridge?: PaneTerminalBridge
}): PanePopoutClient {
  const { bridge, source } = options
  const terminal = options.terminalBridge
  const opened = new Map<PanePopoutTabId, { ownerKey: string; epoch: number }>()

  const push = (tab: PanePopoutTabId): void => {
    const entry = opened.get(tab)
    if (!entry) return
    const projection = projectionFromSnapshot(tab, source.snapshot())
    if (!projection) return
    bridge.update({ tab, ownerKey: entry.ownerKey, epoch: entry.epoch, projection })
  }

  const offAction = source.onAction
    ? bridge.onAction((event) => {
        const entry = opened.get(event.tab)
        if (!entry || entry.ownerKey !== event.ownerKey || entry.epoch !== event.epoch) return
        source.onAction?.(event)
      })
    : () => {}

  return {
    canPopout: (tab) => isPopoutSupported(tab) || (tab === 'terminal' && !!terminal),
    canPopoutTerminal: () => !!terminal,
    isOpen: (tab) => isPanePopoutTab(tab) && opened.has(tab),
    async open(tab, owner, options) {
      if (!isPopoutSupported(tab)) {
        const descriptor = PANE_TRANSFER_MATRIX[tab]
        return {
          ok: false,
          code: 'unsupported',
          ...(descriptor.reason ? { reason: descriptor.reason } : {})
        }
      }
      const paneOwner = ownerToPanePopout(owner)
      const request: PanePopoutOpenRequest = {
        tab,
        owner: paneOwner,
        locale: source.snapshot().locale ?? 'zh-CN',
        ...(options?.viewId ? { viewId: options.viewId } : {}),
        ...(options?.terminalId ? { terminalId: options.terminalId } : {})
      }
      const result = await bridge.open(request)
      if (result.ok && result.epoch !== undefined && isPanePopoutTab(tab)) {
        opened.set(tab, { ownerKey: paneOwner.key, epoch: result.epoch })
        push(tab)
      }
      return result
    },
    async openTerminal(owner, terminalId) {
      if (!terminal) return { ok: false, code: 'rejected', reason: '宿主未接入终端弹出桥' }
      return terminal.open({ owner: ownerToPanePopout(owner), terminalId })
    },
    refresh(tab) {
      if (tab) push(tab)
      else for (const key of opened.keys()) push(key)
    },
    close(tab) {
      bridge.close(tab)
      if (isPanePopoutTab(tab)) opened.delete(tab)
    },
    dispose() {
      offAction()
      for (const tab of [...opened.keys()]) bridge.close(tab)
      opened.clear()
    }
  }
}
