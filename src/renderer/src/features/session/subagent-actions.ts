import { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { useStore } from '../../state/store'
import { useUiV3 } from '../../state/ui-v3'
import { useSubagentStopping } from '../../state/subagent-stopping'
import { subagentPaneId, subagentRunOfPane } from '../workbench/subagent-panes'
import type { TileLayout, TileNode } from '../workbench/tile-tree'
import { buildSubagentTaskRow, isLiveSubagentRun, type SubagentRowLang, type SubagentTaskRow } from '../../../../shared/subagent-task-rows'
import type { SubagentRun } from '../../../../shared/ipc'

type SubagentStopOutcome = 'sent' | 'gone'

export function openSubagentPane(runId: string): void {
  const ui = useUiV3.getState()
  ui.navigate({ name: 'chat' })
  ui.setWorkspaceTab(subagentPaneId(runId))
  ui.setWorkspaceOpen(true)
}

function swapTileIds(node: TileNode, a: string, b: string): TileNode {
  if (node.kind === 'tile') return node.tileId === a ? { ...node, tileId: b } : node.tileId === b ? { ...node, tileId: a } : node
  return { ...node, children: node.children.map((child) => swapTileIds(child, a, b)) }
}

export function swapLayoutTiles(layout: TileLayout, a: string, b: string): TileLayout {
  return { root: swapTileIds(layout.root, a, b) as TileLayout['root'] }
}

export function switchSubagentPane(fromRunId: string, toRunId: string): void {
  const ui = useUiV3.getState()
  const from = subagentPaneId(fromRunId)
  const to = subagentPaneId(toRunId)
  if (from === to) return
  if (!ui.workspacePanes.includes(from) || ui.workspacePanes.includes(to)) {
    openSubagentPane(toRunId)
    return
  }
  ui.setWorkspaceTab(to)
  const next = useUiV3.getState()
  next.setWorkspaceLayout(swapLayoutTiles(next.workspaceLayout, from, to))
  useUiV3.getState().closeWorkspacePane(from)
}

async function freshRun(runId: string): Promise<SubagentRun | undefined> {
  const listed = await window.yan.subagents.list().catch(() => null)
  return (listed ?? useStore.getState().subagents).find((run) => run.id === runId)
}

export async function stopSubagentChecked(runId: string): Promise<SubagentStopOutcome> {
  const run = await freshRun(runId)
  if (!run || !isLiveSubagentRun(run)) {
    useSubagentStopping.getState().clear(runId)
    await useStore.getState().loadSubagents()
    return 'gone'
  }
  await useStore.getState().stopSubagent(runId)
  return 'sent'
}

export async function retrySubagent(run: SubagentRun): Promise<void> {
  await useStore.getState().startSubagent(run.task, run.model, run.isolation)
  await useStore.getState().loadSubagents()
}

export function useSubagentPaneOpen(runId: string): boolean {
  return useUiV3((s) => s.workspaceOpen && s.workspacePanes.includes(subagentPaneId(runId)))
}

export function useFocusedSubagentRun(): string | null {
  return useUiV3((s) => (s.workspaceOpen ? subagentRunOfPane(s.workspaceTab) : null))
}

export function useTicker(active: boolean, everyMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(timer)
  }, [active, everyMs])
  return now
}

export function rowLang(lang: string): SubagentRowLang {
  return lang === 'en-US' ? 'en-US' : 'zh-CN'
}

export function useSubagentRow(run: SubagentRun): SubagentTaskRow {
  const { lang } = useI18n()
  const stopping = useSubagentStopping((s) => s.ids.has(run.id))
  const now = useTicker(isLiveSubagentRun(run))
  return buildSubagentTaskRow(run, { now, lang: rowLang(lang), stopping })
}
