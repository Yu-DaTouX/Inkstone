import { useEffect, useMemo, useRef, type ReactElement } from 'react'
import { AUTO_COMPACT_STEPS } from '../../../../shared/context-limits'
import { contextMarkerY, startIllustration, type IllustrationEngine, type IllustrationState } from './illustration-engine'
import { stepIndexOf, type OnboardingStepId } from './onboarding-model'
import type { OnboardingText } from './onboarding-text'

export interface OnboardingIllustrationProps {
  step: OnboardingStepId
  text: OnboardingText
  light: boolean
  soundOn: boolean
  volume: number
  authed: boolean
  limit: number
}

const kTokens = (n: number): string => `${Math.round(n / 1000)}k`

function nearestLimitIndex(limit: number): number {
  let best = 0
  AUTO_COMPACT_STEPS.forEach((value, i) => {
    if (Math.abs(value - limit) < Math.abs(AUTO_COMPACT_STEPS[best] - limit)) best = i
  })
  return best
}

function waveLevel(soundOn: boolean, volume: number): number {
  if (!soundOn || volume <= 0) return 0
  if (volume < 0.4) return 1
  if (volume < 0.75) return 2
  return 3
}

function artLabel(text: OnboardingText, step: OnboardingStepId): string {
  switch (step) {
    case 'welcome':
      return text.artWelcome
    case 'theme':
      return text.artTheme
    case 'sound':
      return text.artSound
    case 'auth':
      return text.artAuth
    case 'context':
      return text.artContext
    case 'done':
      return text.artDone
  }
}

const sameState = (a: IllustrationState, b: IllustrationState): boolean =>
  a.scene === b.scene && a.light === b.light && a.soundOn === b.soundOn && a.authed === b.authed && a.limitIndex === b.limitIndex

export function OnboardingIllustration({ step, text, light, soundOn, volume, authed, limit }: OnboardingIllustrationProps): ReactElement {
  const boxRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const engineRef = useRef<IllustrationEngine | null>(null)
  const limitIndex = nearestLimitIndex(limit)
  const scene = stepIndexOf(step)
  const state = useMemo<IllustrationState>(
    () => ({ scene, light, soundOn, authed, limitIndex }),
    [scene, light, soundOn, authed, limitIndex]
  )
  const stateRef = useRef(state)

  useEffect(() => {
    const svg = svgRef.current
    const box = boxRef.current
    if (!svg || !box) return
    const engine = startIllustration(svg, box, stateRef.current)
    engineRef.current = engine
    return () => {
      engine.dispose()
      engineRef.current = null
    }
  }, [])

  useEffect(() => {
    if (sameState(stateRef.current, state)) return
    stateRef.current = state
    engineRef.current?.update(state)
  }, [state])

  const waves = waveLevel(soundOn, volume)
  const on = (id: OnboardingStepId): '1' | '0' => (step === id ? '1' : '0')

  return (
    <div className="v3-ob-art" ref={boxRef} data-testid="v3-ob-art">
      <svg ref={svgRef} className="v3-ob-art__svg" viewBox="0 0 240 200" role="img" aria-label={artLabel(text, step)}>
        <g data-actors="" />
        <g className="v3-ob-art-scene" data-scene="welcome" data-on={on('welcome')}>
          <g data-anchor="0">
            <g transform="scale(1.6) translate(-50 -50)">
              <path className="v3-ob-art-mark" data-draw="frame" pathLength={1} d="M70 22H25Q22 22 22 25V75Q22 78 25 78H75Q78 78 78 75V53" />
              <path className="v3-ob-art-prompt" data-draw="chevron" pathLength={1} d="M36 40L47 50L36 60" />
              <path className="v3-ob-art-cursor" d="M57 62H69" />
            </g>
          </g>
        </g>
        <g className="v3-ob-art-scene" data-scene="theme" data-on={on('theme')}>
          <g data-anchor="3">
            <g className="v3-ob-art-rays">
              <path d="M0 -16V-21M0 16V21M-16 0H-21M16 0H21M-11.3 -11.3L-14.8 -14.8M11.3 11.3L14.8 14.8M-11.3 11.3L-14.8 14.8M11.3 -11.3L14.8 -14.8" />
            </g>
          </g>
        </g>
        <g className="v3-ob-art-scene" data-scene="sound" data-on={on('sound')}>
          <path className="v3-ob-art-wave" data-live={waves >= 1 ? '1' : '0'} d="M163.3 69A50 50 0 0 1 163.3 119M76.7 69A50 50 0 0 0 76.7 119" />
          <path className="v3-ob-art-wave" data-live={waves >= 2 ? '1' : '0'} d="M175.4 62A64 64 0 0 1 175.4 126M64.6 62A64 64 0 0 0 64.6 126" />
          <path className="v3-ob-art-wave" data-live={waves >= 3 ? '1' : '0'} d="M187.5 55A78 78 0 0 1 187.5 133M52.5 55A78 78 0 0 0 52.5 133" />
          <path className="v3-ob-art-mute" data-on={soundOn ? '0' : '1'} d="M84 54L156 142" />
        </g>
        <g className="v3-ob-art-scene" data-scene="auth" data-on={on('auth')}>
          <g className="v3-ob-art-flow" data-on={authed ? '1' : '0'}>
            <circle cx="0" cy="110" r="2" />
            <circle cx="0" cy="110" r="2" />
            <circle cx="0" cy="110" r="2" />
          </g>
          <g data-anchor="1">
            <path className="v3-ob-art-prompt-sm" d="M-17 -9L-10 -3L-17 3" />
          </g>
          <g data-anchor="5">
            <path className="v3-ob-art-prong" d="M8 -4.5h8M8 4.5h8" />
          </g>
          <g data-anchor="3">
            <circle className="v3-ob-art-pulse" data-live={authed ? '1' : '0'} cx="0" cy="0" r="26" />
            <path
              className="v3-ob-art-spark"
              data-on={authed ? '1' : '0'}
              d="M0 -12C1 -3 3 -1 12 0C3 1 1 3 0 12C-1 3 -3 1 -12 0C-3 -1 -1 -3 0 -12Z"
            />
          </g>
        </g>
        <g className="v3-ob-art-scene" data-scene="context" data-on={on('context')}>
          <path d="M210 40V168" />
          <path className="v3-ob-art-faint" d="M206 52h8M206 72h8M206 92h8M206 112h8M206 132h8M206 152h8" />
          <path className="v3-ob-art-faint" d="M28 164H180" />
          <g className="v3-ob-art-marker" style={{ transform: `translateY(${contextMarkerY(limitIndex)}px)` }}>
            <path className="v3-ob-art-threshold" data-ctx-threshold="" d="M28 0H210" />
            <path className="v3-ob-art-pointer" d="M210 0l8 -5v10z" />
            <text className="v3-ob-art-label" x="206" y="-7" textAnchor="end">
              {kTokens(AUTO_COMPACT_STEPS[limitIndex])}
            </text>
          </g>
          <g data-anchor="6">
            <g className="v3-ob-art-zip" data-ctx-zip="">
              <path d="M-56 0H-14" />
              <path d="M36 -4l5 4l-5 4M44 -4l5 4l-5 4" />
            </g>
          </g>
        </g>
        <g className="v3-ob-art-scene" data-scene="done" data-on={on('done')}>
          <g data-anchor="4">
            <circle className="v3-ob-art-pulse" data-live="1" cx="0" cy="0" r="36" />
            <path className="v3-ob-art-check" data-draw="check" pathLength={1} d="M-17 1L-5 13L19 -12" />
          </g>
        </g>
      </svg>
    </div>
  )
}
