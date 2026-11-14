import type { ReactElement } from 'react'
import { useI18n } from '../../../i18n'
import { Button, Slider } from '../../../ui'
import { HOME_PARAM_DEFAULTS, HOME_PARAM_RANGES, updateHomeParams, type HomeEffectParams } from '../../ambient/home-background'
import { Segmented, SettingsRow } from '../root/controls'

type RangeKey = keyof typeof HOME_PARAM_RANGES
type Target = 'dither' | 'dither-image' | 'dither-halftone' | 'image-dither' | 'image-halftone'

const TEXT = {
  'zh-CN': {
    shape: '图案',
    shapeDesc: '网点铺出来的形状。',
    shapes: { warp: '流动', swirl: '漩涡', simplex: '云雾', ripple: '涟漪', wave: '波纹' },
    ink: '颜色',
    inks: { mono: '黑白', accent: '主题色', ember: '晚霞', cyan: '青', gray: '灰' },
    pixel: '像素大小',
    pixelDesc: '每个网点占几个像素，越大越粗。',
    strength: '浓度',
    strengthDesc: '网点的不透明度。',
    speed: '流动速度',
    speedDesc: '减弱动效时静止；0 为静止。',
    sessionStrength: '会话里浓度',
    sessionStrengthDesc: '会话里单独设置，调低保证文字可读。',
    sessionSpeed: '会话里流动速度',
    sessionSpeedDesc: '0 为静止。',
    steps: '色阶',
    stepsDesc: '每个颜色通道保留几档亮度，越少越像旧屏幕。',
    grid: '网格',
    grids: { hex: '六角', square: '方格' },
    dotShape: '点形状',
    dotShapes: { classic: '圆点', gooey: '融合', holes: '空心', soft: '柔边' },
    dotSize: '网点大小',
    dotSizeDesc: '越小越细密。',
    contrast: '对比度',
    contrastDesc: '越高，亮处点越大、暗处点越小。',
    twinkle: '闪烁',
    twinkleDesc: '边缘和暗部的网点各自明灭，亮处保持稳定。',
    breath: '呼吸',
    breathDesc: '整片网点随一道缓慢的明暗波起伏。',
    scale: '画面大小',
    scaleDesc: '图片在背景里的大小，小于 100% 时四周留空。',
    offsetX: '水平位置',
    offsetY: '垂直位置',
    offsetDesc: '0 为居中。',
    resetLabel: '效果参数',
    reset: '恢复默认'
  },
  'en-US': {
    shape: 'Pattern',
    shapeDesc: 'The shape the dots trace.',
    shapes: { warp: 'Flow', swirl: 'Swirl', simplex: 'Mist', ripple: 'Ripple', wave: 'Wave' },
    ink: 'Color',
    inks: { mono: 'Mono', accent: 'Accent', ember: 'Ember', cyan: 'Cyan', gray: 'Gray' },
    pixel: 'Pixel size',
    pixelDesc: 'Pixels per dot; larger is coarser.',
    strength: 'Strength',
    strengthDesc: 'Opacity of the dots.',
    speed: 'Flow speed',
    speedDesc: 'Still with reduced motion. 0 stops it.',
    sessionStrength: 'Strength in sessions',
    sessionStrengthDesc: 'Set separately for sessions; keep it low so text stays readable.',
    sessionSpeed: 'Flow speed in sessions',
    sessionSpeedDesc: '0 stops it.',
    steps: 'Color steps',
    stepsDesc: 'Brightness levels kept per channel; fewer looks like an old screen.',
    grid: 'Grid',
    grids: { hex: 'Hex', square: 'Square' },
    dotShape: 'Dot shape',
    dotShapes: { classic: 'Round', gooey: 'Gooey', holes: 'Hollow', soft: 'Soft' },
    dotSize: 'Dot size',
    dotSizeDesc: 'Smaller is finer.',
    contrast: 'Contrast',
    contrastDesc: 'Higher makes light dots larger and dark dots smaller.',
    twinkle: 'Twinkle',
    twinkleDesc: 'Dots at edges and in shadow flicker on their own; highlights stay steady.',
    breath: 'Breathing',
    breathDesc: 'A slow wave of light passes over all dots.',
    scale: 'Image size',
    scaleDesc: 'How large the image sits; below 100% leaves space around it.',
    offsetX: 'Horizontal position',
    offsetY: 'Vertical position',
    offsetDesc: '0 is centered.',
    resetLabel: 'Effect parameters',
    reset: 'Reset'
  }
} as const

type Text = (typeof TEXT)['zh-CN'] | (typeof TEXT)['en-US']

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
const signed = (v: number): string => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`

function InkRow({ text, params }: { text: Text; params: HomeEffectParams }): ReactElement {
  return (
    <SettingsRow settingId="appearance-home-dither-ink" label={text.ink}>
      <Segmented
        label={text.ink}
        value={params.ink}
        options={(['mono', 'accent', 'ember', 'cyan', 'gray'] as const).map((value) => ({ value, label: text.inks[value], testId: `v3-home-ink-${value}` }))}
        onChange={(ink) => updateHomeParams({ ink })}
      />
    </SettingsRow>
  )
}

function GridRow({ text, params, order }: { text: Text; params: HomeEffectParams; order: readonly ['hex', 'square'] | readonly ['square', 'hex'] }): ReactElement {
  return (
    <SettingsRow settingId="appearance-home-image-grid" label={text.grid}>
      <Segmented
        label={text.grid}
        value={params.grid}
        options={order.map((value) => ({ value, label: text.grids[value], testId: `v3-home-grid-${value}` }))}
        onChange={(grid) => updateHomeParams({ grid })}
      />
    </SettingsRow>
  )
}

function PlacementRows({ text, params }: { text: Text; params: HomeEffectParams }): ReactElement {
  return (
    <>
      <RangeRow id="appearance-home-flow-scale" k="scale" label={text.scale} description={text.scaleDesc} params={params} format={percent} />
      <RangeRow id="appearance-home-flow-x" k="offsetX" label={text.offsetX} description={text.offsetDesc} params={params} format={signed} />
      <RangeRow id="appearance-home-flow-y" k="offsetY" label={text.offsetY} description={text.offsetDesc} params={params} format={signed} />
    </>
  )
}

function MotionRows({ text, params }: { text: Text; params: HomeEffectParams }): ReactElement {
  return (
    <>
      <RangeRow id="appearance-home-dither-strength" k="strength" label={text.strength} description={text.strengthDesc} params={params} format={percent} />
      <RangeRow id="appearance-home-dither-speed" k="speed" label={text.speed} description={text.speedDesc} params={params} format={percent} />
      <RangeRow id="appearance-home-session-strength" k="sessionStrength" label={text.sessionStrength} description={text.sessionStrengthDesc} params={params} format={percent} />
      <RangeRow id="appearance-home-session-speed" k="sessionSpeed" label={text.sessionSpeed} description={text.sessionSpeedDesc} params={params} format={percent} />
    </>
  )
}

export function HomeEffectSettings({ target, params, preset }: { target: Target; params: HomeEffectParams; preset?: Partial<HomeEffectParams> }): ReactElement {
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
          <InkRow text={text} params={params} />
          <RangeRow id="appearance-home-dither-pixel" k="pixel" label={text.pixel} description={text.pixelDesc} params={params} format={(v) => `${v}px`} />
          <MotionRows text={text} params={params} />
        </>
      ) : null}
      {target === 'dither-image' ? (
        <>
          <RangeRow id="appearance-home-dither-pixel" k="pixel" label={text.pixel} description={text.pixelDesc} params={params} format={(v) => `${v}px`} />
          <RangeRow id="appearance-home-image-steps" k="colorSteps" label={text.steps} description={text.stepsDesc} params={params} format={(v) => String(v)} />
          <PlacementRows text={text} params={params} />
          <MotionRows text={text} params={params} />
        </>
      ) : null}
      {target === 'dither-halftone' ? (
        <>
          <InkRow text={text} params={params} />
          <SettingsRow settingId="appearance-home-dot-shape" label={text.dotShape}>
            <Segmented
              label={text.dotShape}
              value={params.dotShape}
              options={(['classic', 'gooey', 'holes', 'soft'] as const).map((value) => ({ value, label: text.dotShapes[value], testId: `v3-home-dot-${value}` }))}
              onChange={(dotShape) => updateHomeParams({ dotShape })}
            />
          </SettingsRow>
          <GridRow text={text} params={params} order={['square', 'hex']} />
          <RangeRow id="appearance-home-image-dot" k="dotSize" label={text.dotSize} description={text.dotSizeDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-image-contrast" k="contrast" label={text.contrast} description={text.contrastDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-flow-twinkle" k="twinkle" label={text.twinkle} description={text.twinkleDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-flow-breath" k="breath" label={text.breath} description={text.breathDesc} params={params} format={percent} />
          <PlacementRows text={text} params={params} />
          <MotionRows text={text} params={params} />
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
          <GridRow text={text} params={params} order={['hex', 'square']} />
          <RangeRow id="appearance-home-image-dot" k="dotSize" label={text.dotSize} description={text.dotSizeDesc} params={params} format={percent} />
          <RangeRow id="appearance-home-image-contrast" k="contrast" label={text.contrast} description={text.contrastDesc} params={params} format={percent} />
        </>
      ) : null}
      <SettingsRow settingId="appearance-home-params-reset" label={text.resetLabel}>
        <Button size="sm" variant="ghost" onPress={() => updateHomeParams({ ...HOME_PARAM_DEFAULTS, ...preset })} data-testid="v3-home-params-reset">
          {text.reset}
        </Button>
      </SettingsRow>
    </>
  )
}
