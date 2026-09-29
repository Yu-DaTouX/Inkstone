import { SvgXml } from 'react-native-svg'
import { ICON_SPRITE, type IconName } from '../../src/renderer/src/icons/sprite'
import { BRAND_MARK } from './brandMark'

/**
 * 手机端描边取 1.5dp（设计规范 §7：像素密度高、常在户外看，比桌面的 1.25px 粗一档）。
 * 几何与语义名和桌面同一份生成物，只替换 symbol 上的描边宽度。
 */
const MOBILE_STROKE = '1.5'

const icons = new Map<string, string>()
for (const match of ICON_SPRITE.matchAll(/<symbol id="i-([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)) {
  const attrs = match[2].replace(/stroke-width="[^"]*"/, `stroke-width="${MOBILE_STROKE}"`)
  icons.set(match[1], `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${match[3]}</svg>`)
}

/** 与桌面同一份「砚线」几何和语义名 */
export function Icon({ name, color, size = 20 }: { name: IconName; color: string; size?: number }) {
  return <SvgXml xml={icons.get(name) ?? ''} color={color} width={size} height={size} />
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return <SvgXml xml={BRAND_MARK} width={size} height={size} accessibilityLabel="砚 Inkstone" />
}
