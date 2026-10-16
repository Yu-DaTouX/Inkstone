/**
 * 页签弹出窗的**主窗口客户端**（v3 · WP-30 弹出）。
 *
 * 这是唯一持有「打开时锁定的 owner + epoch」的主窗口侧对象，负责：
 *   · 把正式 `WorkspaceOwner` 折成弹出窗契约的 `PanePopoutOwner`；
 *   · 打开后立刻把当前受限投影推给主进程（再由主进程转给弹出窗）；
 *   · 订阅弹出窗动作，按 `ownerKey + epoch` 丢弃过期事件后交给注入的数据源。
 *
 * 本文件**不 import store**：投影从注入的 `PanePopoutDataSource.snapshot()` 取。
 * 这样它既能在没有 store 的情况下单测，也避免弹出链路把主窗口的整套状态机
 * 复制进第二个 renderer。Workbench / Shell 整合者只需提供一个快照函数。
 */
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

/** 主窗口能提供给弹出窗的受限投影快照；由整合者从 store 映射而来。 */
export interface PanePopoutSnapshot {
  locale?: PanePopoutLocale
  files?: { root: string; rows: PaneFileRow[]; truncated?: boolean; note?: string }
  changes?: { repo: string | null; branch?: string; rows: PaneChangeRow[]; note?: string }
  context?: { usedTokens: number; windowTokens: number; known: boolean; segments: PaneContextSegment[]; note?: string }
  branch?: { rows: PaneBranchRow[]; note?: string }
}

export interface PanePopoutDataSource {
  snapshot(): PanePopoutSnapshot
  /** 弹出窗通过主进程回投的动作；已通过 ownerKey + epoch 校验。 */
  onAction?(event: PaneActionEvent): void
}

export interface PanePopoutClient {
  canPopout(tab: PanePopoutAnyTabId): boolean
  isOpen(tab: PanePopoutAnyTabId): boolean
  open(tab: PanePopoutAnyTabId, owner: WorkspaceOwner, options?: { viewId?: string; terminalId?: string }): Promise<PanePopoutOpenResult>
  /** 终端页签：把主窗口已打开的 terminalId 交同 PTY 弹出（不 start/kill）。 */
  openTerminal(owner: WorkspaceOwner, terminalId: string): Promise<PaneTerminalOpenResult>
  /** 宿主是否接入了终端弹出桥；未接入时终端页签按钮保持禁用。 */
  canPopoutTerminal(): boolean
  /** 重新推送投影；缺省推所有已打开页签。 */
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

/** 从快照取对应页签的投影；缺数据返回 null（弹出窗显示等待态，不伪造空列表）。 */
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
  /** 终端同 PTY 弹桥；缺省时终端页签仍按不支持处理，不画假按钮。 */
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
        /* 归属或代次对不上：这是切换 owner 前的迟到动作，丢弃。 */
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
