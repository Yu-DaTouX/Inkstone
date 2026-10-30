import type { ReactElement } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useT } from '../i18n'
import { useStore } from '../state/store'

export function WindowControls({ className }: { className?: string }): ReactElement {
  const t = useT()
  const maximized = useStore((s) => s.maximized)
  const win = window.yan.win
  return (
    <div className={className ? `v3-win ${className}` : 'v3-win'}>
      <button type="button" className="v3-winbtn v3-winbtn-min" aria-label={t('tb.minimize')} title={t('tb.minimize')} onClick={() => win.minimize()} data-testid="v3-min">
        <Minus size={14} />
      </button>
      <button
        type="button"
        className="v3-winbtn v3-winbtn-max"
        aria-label={maximized ? t('tb.restore') : t('tb.maximize')}
        title={maximized ? t('tb.restore') : t('tb.maximize')}
        onClick={() => win.maximize()}
        data-testid="v3-max"
      >
        {maximized ? <Copy size={13} style={{ transform: 'scaleX(-1)' }} /> : <Square size={13} />}
      </button>
      <button type="button" className="v3-winbtn v3-winbtn-close" aria-label={t('tb.hide')} title={t('tb.hide')} onClick={() => win.close()} data-testid="v3-close">
        <X size={14} />
      </button>
    </div>
  )
}
