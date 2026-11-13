import type { ReactElement, ReactNode } from 'react'
import { Focusable } from 'react-aria-components'
import { Copy, Minus, Square, X } from '../ui/icons'
import { useT } from '../i18n'
import { useStore } from '../state/store'
import { Tooltip, TooltipTrigger } from '../ui'

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

export function WindowControls({ className }: { className?: string }): ReactElement {
  const t = useT()
  const maximized = useStore((s) => s.maximized)
  const win = window.yan.win
  const maxLabel = maximized ? t('tb.restore') : t('tb.maximize')
  return (
    <div className={className ? `v3-win ${className}` : 'v3-win'}>
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
