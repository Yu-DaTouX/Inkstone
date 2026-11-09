import { pick } from '../../src/shared/ui-lang'
import { forwardRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native'
import { font, icon, lineHeight, mono, radius, space, touch, usePalette, weight } from './theme'
import { Icon } from './icons'
import { GlyphSpinner, RunDot } from './motion'
import type { IconName } from '../../src/renderer/src/icons/sprite'

export const STATUS_TEXT = {
  get run() { return pick('运行中', 'Running') },
  get wait() { return pick('等你回答', 'Needs you') },
  get connecting() { return pick('连接中', 'Connecting') },
  get open() { return pick('已连接', 'Connected') },
  get reconnecting() { return pick('重新连接中', 'Reconnecting') }
}

export function IconButton({ name, label, onPress, disabled, busy, primary = false, danger = false, back = false, selected = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; danger?: boolean; back?: boolean; selected?: boolean }) {
  const p = usePalette()
  const filled = primary || danger
  const off = filled && !!disabled
  const fg = danger ? p.onFill : off ? p.fgMute : filled ? p.onBtnPrimary : selected ? p.accent : p.fgDim
  const glyph = busy ? <RunDot color={filled ? fg : undefined} /> : <View style={back ? { transform: [{ rotate: '180deg' }] } : undefined}><Icon name={name} size={filled ? icon.sm : icon.md} color={fg} /></View>
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy, selected }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ minWidth: touch.min, minHeight: touch.min, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', opacity: disabled && !filled ? 0.4 : pressed ? 0.65 : 1 })}>
    {filled ? <View style={[styles.primaryDot, { backgroundColor: danger ? p.fail : off ? p.bubble : p.btnPrimary }]}>{glyph}</View> : selected ? <View style={[styles.selected, { backgroundColor: p.accentSoft }]}>{glyph}</View> : glyph}
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
    secondary: { bg: p.field, border: p.border, fg: p.fg },
    primary: { bg: p.ink ?? p.accent, border: p.ink ?? p.accent, fg: p.onInk ?? p.onAccent },
    ghost: { bg: 'transparent', border: 'transparent', fg: p.fgDim },
    danger: { bg: p.field, border: p.border, fg: p.err }
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

export function EmptyState({ children }: { children: ReactNode }) {
  const p = usePalette()
  return <Text style={[styles.empty, { color: p.fgMute }]}>{children}</Text>
}

export function Header({ title, crumb, subtitle, left, right, background, onTitleLongPress }: { title: string; crumb?: string; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode; background?: string; onTitleLongPress?: () => void }) {
  const p = usePalette()
  return (
    <View style={[styles.header, { backgroundColor: background ?? p.bg0 }, !left && styles.headerBare]}>
      {left}
      <Pressable disabled={!onTitleLongPress} onLongPress={onTitleLongPress} accessibilityActions={onTitleLongPress ? [{ name: 'longpress', label: pick('重命名会话', 'Rename session') }] : undefined} onAccessibilityAction={onTitleLongPress ? () => onTitleLongPress() : undefined} style={styles.headerMain}>
        <Text numberOfLines={1} style={[styles.headerTitle, { color: p.fg }]} accessibilityRole="header">
          {crumb ? <Text style={{ color: p.fgDim, fontWeight: weight.regular }}>{crumb} / </Text> : null}{title}
        </Text>
        {subtitle ? <View style={styles.headerSub}>{typeof subtitle === 'string' ? <Meta numberOfLines={1}>{subtitle}</Meta> : subtitle}</View> : null}
      </Pressable>
      {right}
    </View>
  )
}

export function SectionTitle({ children, count }: { children: ReactNode; count?: number }) {
  const p = usePalette()
  return <View style={styles.sectionRow}>
    <Text accessibilityRole="header" style={[styles.section, { color: p.fgDim }]}>{children}</Text>
    {count !== undefined ? <Text style={[styles.meta, { color: p.fgMute, fontFamily: mono }]}>{count}</Text> : null}
  </View>
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
    style={[styles.input, { backgroundColor: inset ? p.bg0 : p.field, borderColor: p.border, color: p.fg }, code && styles.inputCode, style]}
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
  empty: { fontSize: font.sm, paddingVertical: space[4], textAlign: 'center' },
  header: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2]
  },
  headerBare: { paddingLeft: space[4] },
  headerMain: { flex: 1, minWidth: 0, gap: 1 },
  headerTitle: { fontSize: font.lg, fontWeight: weight.strong },
  headerSub: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: space[3], marginBottom: space[1], paddingHorizontal: space[3], minHeight: 28 },
  section: { fontSize: font.sm },
  meta: { fontSize: font.xs, fontVariant: ['tabular-nums'] },
  primaryDot: { width: 34, height: 34, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center' },
  selected: { width: 36, height: 36, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: font.base },
  inputCode: { fontFamily: mono },
  activityLine: { minHeight: lineHeight.row, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  glyph: { width: 14, textAlign: 'center', fontFamily: mono, fontSize: font.sm },
  activityText: { flex: 1, minWidth: 0, fontSize: font.sm },
  dot: { width: 7, height: 7, borderRadius: 4 }
})
