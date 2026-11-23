import type { ReactElement, ReactNode } from 'react'
import { Focusable } from 'react-aria-components'
import { Copy, Minus, PanelRight, Pin, Square, X } from '../ui/icons'
import { useI18n, useT } from '../i18n'
import { useStore } from '../state/store'
import { IconButton, Tooltip, TooltipTrigger } from '../ui'
import { rightPanelText } from '../features/workbench/right-panel-text'
import { v3Text } from './v3-text'

function WinButton({ label, className, testId, onPress, children }: { label: string; className: string; testId: string; onPress: () => void; children: ReactNode }): ReactElement {
  return (
    <TooltipTrigger>
      <Focusable>
        <button type="button" className={className} aria-label={label} onClick={onPress} data-testid={testId}>
          {children}
        </button>
      </Focusable>
      <Tooltip>{label}</Tooltip>
    </TooltipTrigger>
  )
}

export function WindowControls({ panelOpen, onTogglePanel }: { panelOpen: boolean; onTogglePanel?: () => void }): ReactElement {
  const { lang } = useI18n()
  const t = useT()
  const alwaysOnTop = useStore((s) => s.alwaysOnTop)
  const toggleAlwaysOnTop = useStore((s) => s.toggleAlwaysOnTop)
  const panel = rightPanelText(lang)
  const panelLabel = panelOpen ? panel.hidePanel : panel.panel
  const pinLabel = v3Text(lang).keepOnTop
  const maximized = useStore((s) => s.maximized)
  const win = window.yan.win
  const maxLabel = maximized ? t('tb.restore') : t('tb.maximize')
  return (
    <div className="v3-win">
      <div className="v3-win-actions">
        {onTogglePanel ? (
          <IconButton tooltip={panelLabel} aria-label={panelLabel} aria-pressed={panelOpen} pressedTone="mark" onPress={onTogglePanel} data-testid="v3-head-panel-toggle" data-right-panel-toggle>
            <PanelRight size={16} />
          </IconButton>
        ) : null}
        <IconButton tooltip={pinLabel} aria-label={pinLabel} aria-pressed={alwaysOnTop} onPress={() => void toggleAlwaysOnTop()} data-testid="v3-always-on-top">
          <Pin size={16} />
        </IconButton>
      </div>
      <WinButton label={t('tb.minimize')} className="v3-winbtn v3-winbtn-min" testId="v3-min" onPress={() => win.minimize()}>
        <Minus size={14} />
      </WinButton>
      <WinButton label={maxLabel} className="v3-winbtn v3-winbtn-max" testId="v3-max" onPress={() => win.maximize()}>
        {maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} />}
      </WinButton>
      <WinButton label={t('tb.hide')} className="v3-winbtn v3-winbtn-close" testId="v3-close" onPress={() => win.close()}>
        <X size={14} />
      </WinButton>
    </div>
  )
}
