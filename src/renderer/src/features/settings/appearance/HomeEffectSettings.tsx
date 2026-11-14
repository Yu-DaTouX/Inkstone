import type { ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { Button, Slider } from '../../../ui'
import { HOME_PARAM_DEFAULTS, HOME_PARAM_RANGES, updateHomeParams, type HomeEffectParams } from '../../ambient/home-background'
import { Segmented, SettingsRow } from '../root/controls'

type RangeKey = keyof typeof HOME_PARAM_RANGES

const TEXT = {
  'zh-CN': {
    shape: '图案',
    shapeDesc: '网点铺出来的形状。',
    shapes: { warp: '流动', swirl: '漩涡', simplex: '云雾', ripple: '涟漪', wave: '波纹' },
    ink: '颜色',
    inks: { accent: '主题色', ember: '晚霞', cyan: '青', gray: '灰' },
    pixel: '像素大小',
    pixelDesc: '每个网点占几个像素，越大越粗。',
    strength: '浓度',
    strengthDesc: '网点的不透明度。',
    speed: '流动速度',
    speedDesc: '只在新标签页流动，会话里和减弱动效时静止；0 为静止。',
    steps: '色阶',
    stepsDesc: '每个颜色通道保留几档亮度，越少越像旧屏幕。',
    grid: '网格',
    grids: { hex: '六角', square: '方格' },
    dotSize: '网点大小',
    dotSizeDesc: '越小越细密。',
    contrast: '对比度',
    contrastDesc: '越高，亮处点越大、暗处点越小。',
    resetLabel: '效果参数',
    reset: '恢复默认'
  },
  'en-US': {
    shape: 'Pattern',
    shapeDesc: 'The shape the dots trace.',
    shapes: { warp: 'Flow', swirl: 'Swirl', simplex: 'Mist', ripple: 'Ripple', wave: 'Wave' },
    ink: 'Color',
    inks: { accent: 'Accent', ember: 'Ember', cyan: 'Cyan', gray: 'Gray' },
    pixel: 'Pixel size',
    pixelDesc: 'Pixels per dot; larger is coarser.',
    strength: 'Strength',
    strengthDesc: 'Opacity of the dots.',
    speed: 'Flow speed',
    speedDesc: 'Moves only on the new tab; still in sessions and with reduced motion. 0 stops it.',
    steps: 'Color steps',
    stepsDesc: 'Brightness levels kept per channel; fewer looks like an old screen.',
    grid: 'Grid',
    grids: { hex: 'Hex', square: 'Square' },
    dotSize: 'Dot size',
    dotSizeDesc: 'Smaller is finer.',
    contrast: 'Contrast',
    contrastDesc: 'Higher makes light dots larger and dark dots smaller.',
    resetLabel: 'Effect parameters',
    reset: 'Reset'
  }
} as const

function RangeRow({ id, k, label, description, params, format }: { id: string; k: RangeKey; label: string; description: string; params: HomeEffectParams; format: (v: number) => string }): ReactElement {
  const [min, max, step] = HOME_PARAM_RANGES[k]
  return (
    <SettingsRow settingId={id} label={label} description={description}>
      <div className="home-bg-slider">
        <Slider
          className="home-bg-range"
          aria-label={label}
          minValue={min}
          maxValue={max}
          step={step}
          value={params[k]}
          onChange={(value) => updateHomeParams({ [k]: Array.isArray(value) ? value[0] : value })}
          data-testid={`v3-home-param-${k}`}
        />
        <output className="home-bg-value ui-num" aria-hidden>{format(params[k])}</output>
      </div>
    </SettingsRow>
  )
}

const percent = (v: number): string => `${Math.round(v * 100)}%`

export function HomeEffectSettings({ target, params }: { target: 'dither' | 'dither-image' | 'image-dither' | 'image-halftone'; params: HomeEffectParams }): ReactElement {
  const { lang } = useI18n()
  const text = TEXT[lang === 'en-US' ? 'en-US' : 'zh-CN']
  return (
    <>
      {target === 'dither' ? (
        <>
          <SettingsRow settingId="appearance-home-dither-shape" label={text.shape} description={text.shapeDesc}>
            <Segmented
              label={text.shape}
              value={params.shape}
              options={(['warp', 'swirl', 'simplex', 'ripple', 'wave'] as const).map((value) => ({ value, label: text.shapes[value], testId: `v3-home-shape-${value}` }))}
              onChange={(shape) => updateHomeParams({ shape })}
            />
          </SettingsRow>
          <SettingsRow settingId="appearance-home-dither-ink" label={text.ink}>
            <Segmented
              label={text.ink}
              value={params.ink}
              options={(['accent', 'ember', 'cyan', 'gray'] as const).map((value) => ({ value, label: text.inks[value], testId: `v3-home-ink-${value}` }))}
              onChange={(ink) => updateHomeParams({ ink })}
            />
          </SettingsRow>
          <RangeRow id="appearance-home-dither-pixel" k="pixel" label={text.pixel} description={text.pixelDesc} params={params} format={(v) => `${v}px`} />
          <RangeRow id="appearance-home-dither-strength" k="strength" label={text.strength} description={text.strengthDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-dither-speed" k="speed" label={text.speed} description={text.speedDesc} params={params} format={percent} />
        </>
      ) : null}
      {target === 'dither-image' ? (
        <>
          <RangeRow id="appearance-home-dither-pixel" k="pixel" label={text.pixel} description={text.pixelDesc} params={params} format={(v) => `${v}px`} />
          <RangeRow id="appearance-home-image-steps" k="colorSteps" label={text.steps} description={text.stepsDesc} params={params} format={(v) => String(v)} />
          <RangeRow id="appearance-home-dither-strength" k="strength" label={text.strength} description={text.strengthDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-dither-speed" k="speed" label={text.speed} description={text.speedDesc} params={params} format={percent} />
        </>
      ) : null}
      {target === 'image-dither' ? (
        <>
          <RangeRow id="appearance-home-image-pixel" k="pixel" label={text.pixel} description={text.pixelDesc} params={params} format={(v) => `${v}px`} />
          <RangeRow id="appearance-home-image-steps" k="colorSteps" label={text.steps} description={text.stepsDesc} params={params} format={(v) => String(v)} />
        </>
      ) : null}
      {target === 'image-halftone' ? (
        <>
          <SettingsRow settingId="appearance-home-image-grid" label={text.grid}>
            <Segmented
              label={text.grid}
              value={params.grid}
              options={(['hex', 'square'] as const).map((value) => ({ value, label: text.grids[value], testId: `v3-home-grid-${value}` }))}
              onChange={(grid) => updateHomeParams({ grid })}
            />
          </SettingsRow>
          <RangeRow id="appearance-home-image-dot" k="dotSize" label={text.dotSize} description={text.dotSizeDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-image-contrast" k="contrast" label={text.contrast} description={text.contrastDesc} params={params} format={percent} />
        </>
      ) : null}
      <SettingsRow settingId="appearance-home-params-reset" label={text.resetLabel}>
        <Button size="sm" variant="ghost" onPress={() => updateHomeParams(HOME_PARAM_DEFAULTS)} data-testid="v3-home-params-reset">
          {text.reset}
        </Button>
      </SettingsRow>
    </>
  )
}
