import { memo, type CSSProperties, type JSX } from 'react'
import { ShaderMount } from '@paper-design/shaders-react'
import { DitheringTypes, HalftoneDotsGrids, HalftoneDotsTypes, ShaderFitOptions, defaultObjectSizing, getShaderColorFromString, halftoneDotsFragmentShader, imageDitheringFragmentShader } from '@paper-design/shaders'

function patch(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`paper shader changed: ${anchor}`)
  return source.replace(anchor, replacement)
}

const FLOW_UV = `vec2 imageUV = getImageUV(normalizedUV);
  float flowT = .5 * u_time;
  vec2 flow = normalizedUV * vec2(u_resolution.x / u_resolution.y, 1.) * 2.5;
  for (float i = 1.0; i < 5.0; i++) {
    flow.x += .6 / i * cos(i * 2.5 * flow.y + flowT);
    flow.y += .6 / i * cos(i * 1.5 * flow.x + flowT);
  }
  imageUV += .008 * vec2(cos(flow.y), sin(flow.x));
  float flowWave = .5 + .5 * sin(1.3 * flowT - flow.x - flow.y);`

const FLOW_LUM = `lum = u_inverted ? (1. - lum) : lum;
  lum = clamp(lum * (.7 + .6 * flowWave), 0., 1.);`

export const flowImageDitherShader = patch(
  patch(patch(imageDitheringFragmentShader, 'uniform float u_colorSteps;', 'uniform float u_colorSteps;\nuniform float u_time;'), 'vec2 imageUV = getImageUV(normalizedUV);', FLOW_UV),
  'lum = u_inverted ? (1. - lum) : lum;',
  FLOW_LUM
)

const HALFTONE_FLOW = `float lum = getLumAtPx(samplingUV, contrast);
  float cellSeed = fract(sin(dot(uv_i - inCellOffset, vec2(12.9898, 78.233))) * 43758.5453);
  float twinkle = .5 + .5 * sin(u_time * (1.2 + 1.6 * cellSeed) + 6.2832 * cellSeed);
  float breath = .5 + .5 * sin(.6 * u_time - 3. * (samplingUV.x + samplingUV.y));
  float bright = u_inverted ? 1. - lum : lum;
  float edge = 1. - smoothstep(.25, .85, bright);
  bright *= (1. + u_twinkle * edge * (1.1 * twinkle - .65)) * (1. + u_breath * (.4 * breath - .2));
  bright = clamp(bright, 0., 1.);
  lum = u_inverted ? 1. - bright : bright;
  float rawLum = dot(vec3(.2126, .7152, .0722), texture(u_image, samplingUV).rgb);`

export const flowHalftoneShader = patch(
  patch(
    patch(halftoneDotsFragmentShader, 'return ball * outOfFrame;', 'return ball * outOfFrame * step(.07, rawLum);'), 'uniform float u_type;', 'uniform float u_type;\nuniform float u_time;\nuniform float u_twinkle;\nuniform float u_breath;'
  ),
  'float lum = getLumAtPx(samplingUV, contrast);',
  HALFTONE_FLOW
)

const SIZING = {
  u_fit: ShaderFitOptions.cover,
  u_rotation: defaultObjectSizing.rotation,
  u_scale: defaultObjectSizing.scale,
  u_offsetX: defaultObjectSizing.offsetX,
  u_offsetY: defaultObjectSizing.offsetY,
  u_originX: defaultObjectSizing.originX,
  u_originY: defaultObjectSizing.originY,
  u_worldWidth: defaultObjectSizing.worldWidth,
  u_worldHeight: defaultObjectSizing.worldHeight
}

interface Placement {
  scale?: number
  offsetX?: number
  offsetY?: number
}

function placement({ scale = 1, offsetX = 0, offsetY = 0 }: Placement): typeof SIZING {
  return { ...SIZING, u_scale: scale, u_offsetX: offsetX, u_offsetY: offsetY }
}

interface FlowHalftoneProps extends Placement {
  image: string
  shape: 'classic' | 'gooey' | 'holes' | 'soft'
  twinkle: number
  breath: number
  dotSize: number
  contrast: number
  grid: 'hex' | 'square'
  speed: number
  colorFront: string
  className?: string
  style?: CSSProperties
  minPixelRatio?: number
  maxPixelCount?: number
}

export const FlowHalftone = memo(function FlowHalftone({ image, shape, twinkle, breath, dotSize, contrast, grid, speed, scale, offsetX, offsetY, colorFront, ...props }: FlowHalftoneProps): JSX.Element {
  return (
    <ShaderMount
      {...props}
      speed={speed}
      fragmentShader={flowHalftoneShader}
      uniforms={{
        u_image: image,
        u_colorFront: getShaderColorFromString(colorFront),
        u_colorBack: getShaderColorFromString('rgba(0, 0, 0, 0)'),
        u_size: dotSize,
        u_radius: 1.25,
        u_contrast: contrast,
        u_originalColors: false,
        u_inverted: true,
        u_grainMixer: 0,
        u_grainOverlay: 0,
        u_grainSize: 0.5,
        u_grid: HalftoneDotsGrids[grid],
        u_type: HalftoneDotsTypes[shape],
        u_twinkle: twinkle,
        u_breath: breath,
        ...placement({ scale, offsetX, offsetY })
      }}
    />
  )
})

interface FlowImageDitherProps extends Placement {
  image: string
  pixel: number
  colorSteps: number
  speed: number
  originalColors: boolean
  colorFront: string
  colorBack: string
  colorHighlight: string
  className?: string
  style?: CSSProperties
  minPixelRatio?: number
  maxPixelCount?: number
}

export const FlowImageDither = memo(function FlowImageDither({ image, pixel, colorSteps, speed, originalColors, colorFront, colorBack, colorHighlight, scale, offsetX, offsetY, ...props }: FlowImageDitherProps): JSX.Element {
  return (
    <ShaderMount
      {...props}
      speed={speed}
      fragmentShader={flowImageDitherShader}
      uniforms={{
        u_image: image,
        u_colorFront: getShaderColorFromString(colorFront),
        u_colorBack: getShaderColorFromString(colorBack),
        u_colorHighlight: getShaderColorFromString(colorHighlight),
        u_type: DitheringTypes['8x8'],
        u_pxSize: pixel,
        u_colorSteps: colorSteps,
        u_originalColors: originalColors,
        u_inverted: false,
        ...placement({ scale, offsetX, offsetY })
      }}
    />
  )
})
