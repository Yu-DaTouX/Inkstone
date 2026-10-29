import { useEffect, useId, useState, type CSSProperties, type ReactElement } from 'react'
import { EmptyState, Skeleton, TextField } from '../../ui'
import { useT } from '../../i18n'
import './font-preview.css'

const SAMPLE_SIZES = [12, 16, 24, 32, 48, 64]

const ASCII_GLYPHS = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)).join('')

const CJK_GLYPHS =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处'

const SYMBOLS = '!?&@#%(){}[]<>/*+-=~^|;:,.·—–…“”‘’«»×÷±≤≥∞√∑∏∫∂∆πΩ©®™°€£¥$¢'

interface FontState {
  status: 'loading' | 'ready' | 'failed'
  family: string
}

export function FontPreview({ abs, name, cwd }: { abs: string; name: string; cwd: string }): ReactElement {
  const t = useT()
  const raw = useId()
  const [state, setState] = useState<FontState>({ status: 'loading', family: '' })
  const [sample, setSample] = useState(() => t('preview.font.sample'))

  useEffect(() => {
    let cancelled = false
    let registered: FontFace | null = null
    const family = `yan-font-${raw.replace(/[^a-zA-Z0-9]/g, '')}`
    setState({ status: 'loading', family: '' })
    void window.yan.readPreviewBytes(abs, cwd).then(
      async (result) => {
        if (cancelled) return
        if (!result.ok || !result.bytes) {
          setState({ status: 'failed', family: '' })
          return
        }
        try {
          const bytes = result.bytes
          const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
          const loaded = await new FontFace(family, buffer).load()
          if (cancelled) return
          document.fonts.add(loaded)
          registered = loaded
          setState({ status: 'ready', family: loaded.family || family })
        } catch {
          if (!cancelled) setState({ status: 'failed', family: '' })
        }
      },
      () => {
        if (!cancelled) setState({ status: 'failed', family: '' })
      }
    )
    return () => {
      cancelled = true
      if (registered) document.fonts.delete(registered)
    }
  }, [abs, cwd, raw])

  if (state.status === 'loading') {
    return (
      <div className="v3-font v3-font--loading" data-testid="v3-preview-font-loading" role="status">
        <Skeleton shape="text" />
        <Skeleton shape="text" width="70%" />
        <span className="v3-preview-hint">{t('preview.font.loading')}</span>
      </div>
    )
  }
  if (state.status === 'failed') {
    return (
      <EmptyState
        className="v3-font-empty"
        data-testid="v3-preview-font-error"
        title={t('preview.font.failed')}
        description={t('preview.font.failedHint')}
      />
    )
  }

  const familyStyle: CSSProperties = { fontFamily: `"${state.family}", var(--font-read)` }
  const label = name.replace(/\.[^.]+$/, '') || name
  return (
    <div className="v3-font" data-testid="v3-preview-font" data-font-name={label}>
      <div className="v3-font-head">
        <h3 className="v3-font-name" style={familyStyle} title={name}>
          {label}
        </h3>
        <TextField
          className="v3-font-sample"
          size="sm"
          label={t('preview.font.sampleLabel')}
          value={sample}
          onChange={setSample}
        />
      </div>
      <div className="v3-font-sizes" style={familyStyle} role="group" aria-label={t('preview.font.sizes')}>
        {SAMPLE_SIZES.map((size) => (
          <div key={size} className="v3-font-size-row">
            <span className="v3-font-size-label">{t('preview.font.size', { n: size })}</span>
            <p className="v3-font-size-line" style={{ fontSize: `${size}px` }}>
              {sample || t('preview.font.sample')}
            </p>
          </div>
        ))}
      </div>
      <section className="v3-font-charset">
        <h4 className="v3-font-section">{t('preview.font.charset')}</h4>
        <p className="v3-font-glyphs" style={familyStyle}>
          {ASCII_GLYPHS}
        </p>
        <p className="v3-font-glyphs" style={familyStyle}>
          {CJK_GLYPHS}
        </p>
        <p className="v3-font-glyphs" style={familyStyle}>
          {SYMBOLS}
        </p>
      </section>
    </div>
  )
}
