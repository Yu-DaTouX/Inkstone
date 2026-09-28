import { SvgXml } from 'react-native-svg'
import { ICON_SPRITE, type IconName } from '../../src/renderer/src/icons/sprite'
import { BRAND_MARK } from './brandMark'

const icons = new Map<string, string>()
for (const match of ICON_SPRITE.matchAll(/<symbol id="i-([^"]+)"([^>]*)>([\s\S]*?)<\/symbol>/g)) {
  icons.set(match[1], `<svg xmlns="http://www.w3.org/2000/svg"${match[2]}>${match[3]}</svg>`)
}

/** Uses the same generated Lucide geometry and semantic names as the desktop. */
export function Icon({ name, color, size = 20 }: { name: IconName; color: string; size?: number }) {
  return <SvgXml xml={icons.get(name) ?? ''} color={color} width={size} height={size} />
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return <SvgXml xml={BRAND_MARK} width={size} height={size} accessibilityLabel="砚 Inkstone" />
}
