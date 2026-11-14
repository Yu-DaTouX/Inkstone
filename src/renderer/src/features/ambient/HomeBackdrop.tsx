import { lazy, Suspense, useLayoutEffect, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { UsageLandscape } from './UsageLandscape'
import { homeBackgroundMode, homeImageSource, useHomeBackground, type HomeMaskTone } from './home-background'

const ShaderBackdrop = lazy(() => import('./ShaderBackdrop'))

const MASK_COLOR: Record<HomeMaskTone, string> = { page: 'var(--bg)', dark: 'black', light: 'white' }

const SESSION_FADE_SHARE = 0.5

function sessionFade(fade: number): number {
  return fade + (1 - fade) * SESSION_FADE_SHARE
}

function useMainLayer(enabled: boolean): HTMLElement | null {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    setTarget(enabled ? document.querySelector<HTMLElement>('.v3-main') : null)
  }, [enabled])
  return target
}

function Lifted({ target, children }: { target: HTMLElement | null; children: ReactNode }): JSX.Element {
  return target ? createPortal(<div className="v3-home-layer" aria-hidden>{children}</div>, target) : <>{children}</>
}

export function HomeBackdrop({ active, asciiEnabled, lift = false }: { active: boolean; asciiEnabled: boolean; lift?: boolean }): JSX.Element {
  const background = useHomeBackground()
  const mode = homeBackgroundMode(background, asciiEnabled)
  const shaded = mode === 'image' && background.image && background.effect !== 'none'
  const target = useMainLayer(lift && (mode === 'dither' || (mode === 'image' && !!background.image)))
  return (
    <>
      <UsageLandscape active={active} enabled={mode === 'ascii'} />
      <Lifted target={target}>
      {mode === 'dither' ? (
        <div
          className="v3-home-image"
          aria-hidden
          data-kind="dither"
          data-in-session={active ? undefined : ''}
          style={{ '--home-fade': active ? 0 : SESSION_FADE_SHARE, '--home-mask': 'var(--bg)', '--home-strength': background.params.strength } as CSSProperties}
          data-testid="v3-home-dither"
        >
          <Suspense fallback={null}>
            <ShaderBackdrop kind="dither" image={background.flowImage && background.image ? homeImageSource(background.image) : null} params={background.params} animate={active} />
          </Suspense>
        </div>
      ) : null}
      {mode === 'image' && background.image ? (
        <div
          className="v3-home-image"
          aria-hidden
          data-in-session={active ? undefined : ''}
          data-blur={background.blur > 0 ? '' : undefined}
          data-effect={shaded ? background.effect : undefined}
          style={{
            '--home-src': `url("${homeImageSource(background.image)}")`,
            '--home-fade': active ? background.fade : sessionFade(background.fade),
            '--home-blur': `${background.blur}px`,
            '--home-mask': MASK_COLOR[background.tone]
          } as CSSProperties}
          data-testid="v3-home-image"
        >
          {shaded ? (
            <Suspense fallback={null}>
              <ShaderBackdrop kind="image" image={homeImageSource(background.image)} effect={background.effect} params={background.params} animate={false} />
            </Suspense>
          ) : null}
        </div>
      ) : null}
      </Lifted>
    </>
  )
}
