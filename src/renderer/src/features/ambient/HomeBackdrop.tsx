import type { CSSProperties, JSX } from 'react'
import { UsageLandscape } from './UsageLandscape'
import { homeBackgroundMode, useHomeBackground, type HomeMaskTone } from './home-background'

const MASK_COLOR: Record<HomeMaskTone, string> = { page: 'var(--bg)', dark: 'black', light: 'white' }

const SESSION_FADE_SHARE = 0.5

function sessionFade(fade: number): number {
  return fade + (1 - fade) * SESSION_FADE_SHARE
}

export function HomeBackdrop({ active, asciiEnabled }: { active: boolean; asciiEnabled: boolean }): JSX.Element {
  const background = useHomeBackground()
  const mode = homeBackgroundMode(background, asciiEnabled)
  return (
    <>
      <UsageLandscape active={active} enabled={mode === 'ascii'} />
      {mode === 'image' && background.image ? (
        <div
          className="v3-home-image"
          aria-hidden
          data-in-session={active ? undefined : ''}
          data-blur={background.blur > 0 ? '' : undefined}
          style={{
            '--home-src': `url("${background.image}")`,
            '--home-fade': active ? background.fade : sessionFade(background.fade),
            '--home-blur': `${background.blur}px`,
            '--home-mask': MASK_COLOR[background.tone]
          } as CSSProperties}
          data-testid="v3-home-image"
        />
      ) : null}
    </>
  )
}
