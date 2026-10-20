import { useState, type ComponentType, type JSX } from 'react'
import { useI18n } from '../../i18n'
import { EmptyState } from '../../ui'
import { WORKBENCH_PANES } from './panes'
import { useWorkspaceOwner } from './use-owner'
import { activateWorkspaceOwner, captureActivationTarget } from './activation'
import { showPreview, usePreviewPath } from './tool-tiles'
import type { PreviewOpenOptions } from './preview-state'
import { workbenchText } from './workbench-text'
import { WORKBENCH_ACTIVE_TABS, type PreviewPaneProps, type WorkbenchTabId, type WorkspaceOwner } from './types'

interface LeafProps {
  owner: WorkspaceOwner
  visible?: boolean
  onPreview?: (path: string, options?: PreviewOpenOptions) => void
  path?: string
  Preview?: ComponentType<PreviewPaneProps>
}

export function ToolTileBody({ tab }: { tab: WorkbenchTabId }): JSX.Element {
  const { lang } = useI18n()
  const text = workbenchText(lang)
  const owner = useWorkspaceOwner()
  const previewPath = usePreviewPath(owner.key)
  const [activating, setActivating] = useState(false)
  const Body = WORKBENCH_PANES[tab] as ComponentType<LeafProps> | undefined
  const blocked = !owner.active && WORKBENCH_ACTIVE_TABS.has(tab)

  const activate = (): void => {
    if (activating) return
    setActivating(true)
    void activateWorkspaceOwner(captureActivationTarget()).finally(() => setActivating(false))
  }

  return (
    <div className="v3-tool-tile-body">
      <div className="wb-pane" data-tab={tab} data-visible="1" data-testid={`tool-tile-pane-${tab}`}>
        {Body ? (
          <Body owner={owner} visible={!blocked} onPreview={(path, options) => showPreview(owner.key, path, options)} path={previewPath} Preview={tab === 'files' ? WORKBENCH_PANES.preview : undefined} />
        ) : (
          <EmptyState className="wb-nowire" title={text.notWired} description={text.notWiredHint} />
        )}
        {blocked ? (
          <div className="wb-pane-block">
            <p>{text.activateHint}</p>
            <button type="button" onClick={activate} disabled={activating} data-testid="tool-tile-activate">
              {text.activate}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
