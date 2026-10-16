import { SvgXml } from 'react-native-svg'
import { ICON_SPRITE, type IconName } from '../../src/renderer/src/icons/sprite'
import { BRAND_MARK } from './brandMark'

const MOBILE_STROKE = '1.5'

const icons = new Map<string, string>()
for (const match of ICON_SPRITE.matchAll(/<symbol id="i-([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)) {
  const attrs = match[2].replace(/stroke-width="[^"]*"/, `stroke-width="${MOBILE_STROKE}"`)
  icons.set(match[1], `<svg xmlns="http://www.w3.org/2000/svg"${attrs}>${match[3]}</svg>`)
}

export function Icon({ name, color, size = 20 }: { name: IconName; color: string; size?: number }) {
  return <SvgXml xml={icons.get(name) ?? ''} color={color} width={size} height={size} />
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return <SvgXml xml={BRAND_MARK} width={size} height={size} accessibilityLabel="砚 Inkstone" />
}
