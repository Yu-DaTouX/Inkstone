import { memo, type CSSProperties, type JSX } from 'react'
import { ShaderMount } from '@paper-design/shaders-react'
import { DitheringTypes, ShaderFitOptions, defaultObjectSizing, getShaderColorFromString, imageDitheringFragmentShader } from '@paper-design/shaders'

function patch(source: string, anchor: string, replacement: string): string {
  if (!source.includes(anchor)) throw new Error(`image dithering shader changed: ${anchor}`)
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

interface FlowImageDitherProps {
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

export const FlowImageDither = memo(function FlowImageDither({ image, pixel, colorSteps, speed, originalColors, colorFront, colorBack, colorHighlight, ...props }: FlowImageDitherProps): JSX.Element {
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
        u_fit: ShaderFitOptions.cover,
        u_rotation: defaultObjectSizing.rotation,
        u_scale: defaultObjectSizing.scale,
        u_offsetX: defaultObjectSizing.offsetX,
        u_offsetY: defaultObjectSizing.offsetY,
        u_originX: defaultObjectSizing.originX,
        u_originY: defaultObjectSizing.originY,
        u_worldWidth: defaultObjectSizing.worldWidth,
        u_worldHeight: defaultObjectSizing.worldHeight
      }}
    />
  )
})
