import { useEffect, useState, useSyncExternalStore, type JSX } from 'react'
import { Dithering, HalftoneDots, ImageDithering } from '@paper-design/shaders-react'
import { prefersReducedMotion, subscribeReducedMotion } from '../../lib/reduced-motion'
import type { HomeEffectParams, HomeImageEffect, HomeInk } from './home-background'
import { FlowImageDither } from './FlowImageDither'

const PIXEL_BUDGET = { minPixelRatio: 1, maxPixelCount: 1920 * 1080 * 2 }
const LIGHT_CONTRAST = 0.55
const INK: Record<Exclude<HomeInk, 'accent'>, string> = { ember: '#ec6930', cyan: '#22c3d6', gray: '#9a9aa2' }

function resolveColor(token: string): string {
  const probe = document.createElement('canvas')
  probe.width = 1
  probe.height = 1
  const ctx = probe.getContext('2d')
  if (!ctx) return '#888888'
  const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  ctx.fillStyle = value || '#888888'
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

interface ThemeColors { accent: string; back: string; ink: string; glow: string; light: boolean }

function useThemeColors(): ThemeColors {
  const read = (): ThemeColors => ({ accent: resolveColor('--accent'), back: resolveColor('--bg'), ink: resolveColor('--home-print-ink'), glow: resolveColor('--home-print-glow'), light: document.documentElement.dataset.theme === 'light' })
  const [colors, setColors] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
    return () => observer.disconnect()
  }, [])
  return colors
}

function useMotion(): boolean {
  return !useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => true)
}

export default function ShaderBackdrop({ kind, image, effect, params, animate }: { kind: 'dither' | 'image'; image?: string | null; effect?: HomeImageEffect; params: HomeEffectParams; animate: boolean }): JSX.Element | null {
  const colors = useThemeColors()
  const motion = useMotion()
  const style = { position: 'absolute', inset: 0 } as const
  if (kind === 'dither' && image) {
    const speed = animate && motion ? params.speed : 0
    if (colors.light) {
      return <FlowImageDither className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} pixel={params.pixel} colorSteps={params.colorSteps} speed={speed} originalColors={false} colorBack="rgba(0, 0, 0, 0)" colorFront={colors.ink} colorHighlight={colors.glow} />
    }
    return <FlowImageDither className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} pixel={params.pixel} colorSteps={params.colorSteps} speed={speed} originalColors colorBack="rgba(0, 0, 0, 0)" colorFront={colors.ink} colorHighlight={colors.glow} />
  }
  if (kind === 'dither') {
    return (
      <Dithering
        className="v3-home-shader"
        style={style}
        {...PIXEL_BUDGET}
        colorBack="rgba(0, 0, 0, 0)"
        colorFront={params.ink === 'accent' ? colors.accent : INK[params.ink]}
        shape={params.shape}
        type="8x8"
        size={params.pixel}
        scale={1.1}
        speed={animate && motion ? params.speed : 0}
      />
    )
  }
  if (!image) return null
  if (effect === 'dither') {
    if (colors.light) {
      return <ImageDithering className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} fit="cover" type="8x8" size={params.pixel} colorSteps={params.colorSteps} colorBack="rgba(0, 0, 0, 0)" colorFront={colors.ink} colorHighlight={colors.glow} originalColors={false} />
    }
    return <ImageDithering className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} fit="cover" type="8x8" size={params.pixel} colorSteps={params.colorSteps} originalColors />
  }
  if (effect === 'halftone') {
    if (colors.light) {
      return <HalftoneDots className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} fit="cover" colorBack="rgba(0, 0, 0, 0)" colorFront={colors.ink} originalColors={false} inverted grid={params.grid} type="classic" size={params.dotSize} radius={1.25} contrast={params.contrast * LIGHT_CONTRAST} grainMixer={0} grainOverlay={0} />
    }
    return <HalftoneDots className="v3-home-shader" style={style} {...PIXEL_BUDGET} image={image} fit="cover" colorBack={colors.back} originalColors grid={params.grid} type="classic" size={params.dotSize} radius={1.25} contrast={params.contrast} grainMixer={0} grainOverlay={0} />
  }
  return null
}
