import type { ReactNode } from 'react'
import { Icon } from '../../icons/Icon'
import { Tip } from '../ui'
import { KEY_BINDINGS } from '../../lib/host-actions'
import { BrandMark } from './BrandMark'
import { useI18n } from '../../i18n'
import { menuAnchor } from '../workbench/Workspace'
import { SubagentIndicator } from './SubagentIndicator'

export type Theme = 'dark' | 'light'

interface Props {
  onToggleRail: () => void
  railOpen?: boolean
  onRailHover?: (inside: boolean) => void
  onToggleBrowser?: () => void
  browserOpen?: boolean
  onSettings?: () => void
  alwaysOnTop?: boolean
  onToggleAlwaysOnTop?: () => void
  maximized?: boolean
  center?: ReactNode
}

export function TitleBar({
  onToggleRail,
  railOpen,
  onRailHover,
  onToggleBrowser,
  browserOpen,
  alwaysOnTop,
  onToggleAlwaysOnTop,
  maximized,
  center
}: Props) {
  const { t } = useI18n()
  const win = window.yan.win

  return (
    <header className="titlebar">
      <div className="tb-left">
        <Tip label={railOpen ? t('rail.collapse') : t('rail.expand')} shortcut={KEY_BINDINGS.toggleRail.keys}>
          <button
            className={`tb-icon ${railOpen ? 'on' : ''}`}
            onClick={onToggleRail}
            onPointerEnter={() => { if (!railOpen) onRailHover?.(true) }}
            onPointerLeave={() => { if (!railOpen) onRailHover?.(false) }}
            data-testid="rail-toggle"
            data-open={railOpen ? '1' : '0'}
            aria-label={railOpen ? t('rail.collapse') : t('rail.expand')}
            aria-expanded={railOpen}
          >
            <Icon name="sidebar-left" size={14} />
          </button>
        </Tip>
        <span className="tb-brand" data-testid="app-brand">
          <BrandMark size={16} />
          <span className="tb-name">砚</span>
          <span className="tb-word" aria-hidden>INKSTONE</span>
        </span>
      </div>

      {center ? <div className="tb-center">{center}</div> : <div className="tb-center" aria-hidden />}

      <div className="tb-right">
        <SubagentIndicator />
        <Tip label={alwaysOnTop ? t('tb.unpin') : t('tb.pin')}>
          <button
            className={`tb-icon tb-pin ${alwaysOnTop ? 'on' : ''}`}
            onClick={onToggleAlwaysOnTop}
            aria-pressed={!!alwaysOnTop}
            aria-label={alwaysOnTop ? t('tb.unpin') : t('tb.pin')}
            data-testid="win-pin"
            data-on={alwaysOnTop ? '1' : '0'}
          >
            <Icon name="pin" size={14} />
          </button>
        </Tip>

        <Tip label={t('tb.openTools')}>
          <button
            className="tb-icon"
            aria-label={t('tb.openTools')}
            aria-haspopup="menu"
            onClick={(e) => window.dispatchEvent(new CustomEvent('inkstone-workspace-open-tool', { detail: menuAnchor(e.currentTarget) }))}
            data-testid="right-tool-menu"
          >
            <Icon name="tile" size={14} />
          </button>
        </Tip>

        <Tip label={browserOpen ? t('browser.close') : t('browser.open')}>
          <button
            className={`tb-icon ${browserOpen ? 'on' : ''}`}
            onClick={onToggleBrowser}
            data-testid="browser-view-toggle"
            data-open={browserOpen ? '1' : '0'}
            aria-pressed={!!browserOpen}
            aria-label={browserOpen ? t('browser.close') : t('browser.open')}
          >
            <Icon name="globe" size={14} />
          </button>
        </Tip>

        <div className="wctrl">
          <Tip label={t('tb.minimize')}>
            <button
              className="wbtn min"
              aria-label={t('tb.minimize')}
              onClick={() => win.minimize()}
              data-testid="win-min"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </Tip>

          <Tip label={maximized ? t('tb.restore') : t('tb.maximize')}>
            <button
              className="wbtn max"
              aria-label={maximized ? t('tb.restore') : t('tb.maximize')}
              onClick={() => win.maximize()}
              data-testid="win-max"
            >
              {maximized ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <path d="M2.5 2.5h6v6h-6z" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M1.5 1.5h6" fill="none" stroke="currentColor" strokeWidth="1" />
                  <path d="M1.5 1.5v6" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              ) : (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                  <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1" />
                </svg>
              )}
            </button>
          </Tip>

          <Tip label={t('tb.hide')}>
            <button
              className="wbtn close"
              aria-label={t('tb.hide')}
              onClick={() => win.close()}
              data-testid="win-close"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1" />
              </svg>
            </button>
          </Tip>
        </div>
      </div>
    </header>
  )
}
