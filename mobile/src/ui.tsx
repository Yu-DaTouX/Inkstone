/**
 * 手机端的统一控件：与桌面 components/ui 同一套意图（主要 / 次要 / 无框 / 危险、徽标、空状态），
 * 尺寸按触屏放大。页面只组合这些控件，不各自写一套按钮样式。
 */
import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { font, radius, space, touch, usePalette } from './theme'
import { Icon } from './icons'
import type { IconName } from '../../src/renderer/src/icons/sprite'

export function IconButton({ name, label, onPress, disabled, busy, primary = false, back = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; back?: boolean }) {
  const p = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled || !!busy }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ minWidth: touch.min, minHeight: touch.min, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? p.accent : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}>
    {busy ? <ActivityIndicator color={primary ? p.onAccent : p.accent} /> : <View style={back ? { transform: [{ rotate: '180deg' }] } : undefined}><Icon name={name} size={21} color={primary ? p.onAccent : p.fgDim} /></View>}
  </Pressable>
}

type Variant = 'secondary' | 'primary' | 'ghost' | 'danger'

export function Button({
  label,
  onPress,
  variant = 'secondary',
  disabled,
  busy,
  icon,
  style,
  accessibilityHint
}: {
  label: string
  onPress: () => void
  variant?: Variant
  disabled?: boolean
  busy?: boolean
  icon?: IconName
  style?: StyleProp<ViewStyle>
  accessibilityHint?: string
}) {
  const p = usePalette()
  const colors = {
    secondary: { bg: p.bg2, border: p.border, fg: p.fg },
    primary: { bg: p.accent, border: p.accent, fg: p.onAccent },
    ghost: { bg: 'transparent', border: 'transparent', fg: p.fgDim },
    danger: { bg: p.bg2, border: p.border, fg: p.err }
  }[variant]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style
      ]}
    >
      {busy ? <ActivityIndicator color={colors.fg} /> : <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}><Text style={[styles.buttonText, { color: colors.fg }]}>{label}</Text>{icon ? <Icon name={icon} size={18} color={colors.fg} /> : null}</View>}
    </Pressable>
  )
}

export type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err'

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  const p = usePalette()
  const color = { neutral: p.fgDim, accent: p.accent, ok: p.ok, warn: p.warn, err: p.err }[tone]
  return (
    <View style={[styles.badge, { borderColor: tone === 'neutral' ? p.borderSoft : color }]}>
      <Text style={[styles.badgeText, { color }]}>{children}</Text>
    </View>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  const p = usePalette()
  return <Text style={[styles.empty, { color: p.fgMute }]}>{children}</Text>
}

export function Header({ title, left, right }: { title: string; left?: ReactNode; right?: ReactNode }) {
  const p = usePalette()
  return (
    <View style={[styles.header, { borderBottomColor: p.borderSoft, backgroundColor: p.bg1 }]}>
      <View style={styles.headerSide}>{left}</View>
      <Text numberOfLines={1} style={[styles.headerTitle, { color: p.fg }]} accessibilityRole="header">
        {title}
      </Text>
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const p = usePalette()
  return <Text style={[styles.section, { color: p.fgDim }]}>{children}</Text>
}

const styles = StyleSheet.create({
  button: {
    minHeight: touch.min,
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonText: { fontSize: font.base, fontWeight: '500' },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1
  },
  badgeText: { fontSize: font.xs, fontWeight: '500' },
  empty: { fontSize: font.sm, paddingVertical: space[4], textAlign: 'center' },
  header: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerSide: { minWidth: 72, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: font.lg, fontWeight: '600' },
  section: { fontSize: font.sm, fontWeight: '600', marginTop: space[4], marginBottom: space[2] }
})
