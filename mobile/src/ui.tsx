import { forwardRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native'
import { font, icon, lineHeight, mono, radius, space, touch, usePalette, weight } from './theme'
import { Icon } from './icons'
import { GlyphSpinner, RunDot } from './motion'
import type { IconName } from '../../src/renderer/src/icons/sprite'

export const STATUS_TEXT = {
  run: '运行中',
  wait: '等你回答',
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重新连接中'
} as const

export function IconButton({ name, label, onPress, disabled, busy, primary = false, back = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; back?: boolean }) {
  const p = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ minWidth: touch.min, minHeight: touch.min, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? (p.ink ?? p.accent) : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}>
    {busy ? <RunDot color={primary ? (p.onInk ?? p.onAccent) : undefined} /> : <View style={back ? { transform: [{ rotate: '180deg' }] } : undefined}><Icon name={name} size={icon.md} color={primary ? (p.onInk ?? p.onAccent) : p.fgDim} /></View>}
  </Pressable>
}

type Variant = 'secondary' | 'primary' | 'ghost' | 'danger'

export function Button({
  label,
  onPress,
  variant = 'secondary',
  compact = false,
  disabled,
  busy,
  icon: iconName,
  style,
  accessibilityHint
}: {
  label: string
  onPress: () => void
  variant?: Variant
  compact?: boolean
  disabled?: boolean
  busy?: boolean
  icon?: IconName
  style?: StyleProp<ViewStyle>
  accessibilityHint?: string
}) {
  const p = usePalette()
  const colors = {
    secondary: { bg: p.bg2, border: p.border, fg: p.fg },
    primary: { bg: p.ink ?? p.accent, border: p.ink ?? p.accent, fg: p.onInk ?? p.onAccent },
    ghost: { bg: 'transparent', border: 'transparent', fg: p.fgDim },
    danger: { bg: p.bg2, border: p.border, fg: p.err }
  }[variant]
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      accessibilityHint={accessibilityHint}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        style
      ]}
    >
      {busy ? <View style={styles.buttonInner}><RunDot color={variant === 'primary' ? colors.fg : undefined} /><Text style={[styles.buttonText, { color: colors.fg }]}>{label}</Text></View> : <View style={styles.buttonInner}><Text style={[styles.buttonText, { color: colors.fg }]}>{label}</Text>{iconName ? <Icon name={iconName} size={icon.sm} color={colors.fg} /> : null}</View>}
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

export function Header({ title, subtitle, left, right }: { title: string; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode }) {
  const p = usePalette()
  return (
    <View style={[styles.header, { borderBottomColor: p.borderSoft, backgroundColor: p.bg1 }, !left && styles.headerBare]}>
      {left}
      <View style={styles.headerMain}>
        <Text numberOfLines={1} style={[styles.headerTitle, subtitle ? styles.headerTitleTwoLine : null, { color: p.fg }]} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? <View style={styles.headerSub}>{typeof subtitle === 'string' ? <Meta numberOfLines={1}>{subtitle}</Meta> : subtitle}</View> : null}
      </View>
      {right}
    </View>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const p = usePalette()
  return <Text accessibilityRole="header" style={[styles.section, { color: p.fgMute }]}>{children}</Text>
}

export function Meta({ children, color, numberOfLines, style }: { children: ReactNode; color?: string; numberOfLines?: number; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return <Text numberOfLines={numberOfLines} style={[styles.meta, { color: color ?? p.fgMute }, style]}>{children}</Text>
}

export const Input = forwardRef<TextInput, TextInputProps & { code?: boolean; inset?: boolean }>(function Input({ code = false, inset = false, style, ...props }, ref) {
  const p = usePalette()
  return <TextInput
    ref={ref}
    disableFullscreenUI
    placeholderTextColor={p.fgMute}
    {...props}
    style={[styles.input, { backgroundColor: inset ? p.bg0 : p.bg2, borderColor: p.border, color: p.fg }, code && styles.inputCode, style]}
  />
})

export type ActivityState = 'run' | 'wait' | 'done' | 'fail' | 'stop' | 'offline'

export function ActivityLine({ state, text, meta }: { state: ActivityState; text: string; meta?: string }) {
  const p = usePalette()
  const color = { run: p.accent, wait: p.warn, done: p.ok, fail: p.err, stop: p.fgMute, offline: p.warn }[state]
  return <View style={styles.activityLine}>
    {state === 'run' ? <GlyphSpinner color={color} /> : <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.glyph, { color }]}>{ { wait: '◆', done: '✓', fail: '✕', stop: '■', offline: '●' }[state] }</Text>}
    <Text accessibilityLiveRegion={state === 'run' || state === 'wait' ? 'polite' : 'none'} numberOfLines={1} style={[styles.activityText, { color: state === 'run' || state === 'done' ? p.fgDim : color }]}>{text}</Text>
    {meta ? <Text numberOfLines={1} style={[styles.meta, { color: p.fgMute }]}>{meta}</Text> : null}
  </View>
}

export function StatusDot({ color, label }: { color: string; label?: string }) {
  return <View accessibilityLabel={label} style={[styles.dot, { backgroundColor: color }]} />
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
  buttonCompact: { minHeight: touch.compact, paddingHorizontal: space[3] },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  buttonText: { fontSize: font.base, fontWeight: weight.medium },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1
  },
  badgeText: { fontSize: font.xs, fontWeight: weight.medium },
  empty: { fontSize: font.sm, paddingVertical: space[4], textAlign: 'center' },
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  headerBare: { paddingLeft: space[4] },
  headerMain: { flex: 1, minWidth: 0, gap: 2 },
  headerTitle: { fontSize: font.lg, fontWeight: weight.strong },
  headerTitleTwoLine: { fontSize: font.body },
  headerSub: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  section: { fontFamily: mono, fontSize: font.xs, marginTop: space[5], marginBottom: space[1] },
  meta: { fontFamily: mono, fontSize: font.xs, fontVariant: ['tabular-nums'] },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: font.base },
  inputCode: { fontFamily: mono },
  activityLine: { minHeight: lineHeight.row, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  glyph: { width: 14, textAlign: 'center', fontFamily: mono, fontSize: font.sm },
  activityText: { flex: 1, minWidth: 0, fontFamily: mono, fontSize: font.sm },
  dot: { width: 6, height: 6, borderRadius: 3 }
})
