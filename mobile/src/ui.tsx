/**
 * 手机端的统一控件：与桌面 components/ui 同一套意图（主要 / 次要 / 无框 / 危险、徽标、空状态、输入框），
 * 尺寸按触屏放大。页面只组合这些控件，不各自写一套按钮、输入框或状态行。
 *
 * 字体分工与桌面一致：界面汉字用系统无衬线，代码与纯命令用等宽。
 */
import { forwardRef, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type TextStyle, type ViewStyle } from 'react-native'
import { font, icon, mono, radius, space, touch, usePalette, weight } from './theme'
import { Icon } from './icons'
import { RunDot, Spinner } from './motion'
import type { IconName } from '../../src/renderer/src/icons/sprite'

/** 状态用词与桌面状态栏一致（设计规范 §7） */
export const STATUS_TEXT = {
  run: '运行中',
  wait: '等你回答',
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重新连接中',
  closed: '已断开'
} as const

export function IconButton({ name, label, onPress, disabled, busy, primary = false, back = false }: { name: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; primary?: boolean; back?: boolean }) {
  const p = usePalette()
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }} onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ minWidth: touch.min, minHeight: touch.min, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', backgroundColor: primary ? p.accent : 'transparent', opacity: disabled ? 0.4 : pressed ? 0.65 : 1 })}>
    {busy ? <RunDot color={primary ? p.onAccent : undefined} /> : <View style={back ? { transform: [{ rotate: '180deg' }] } : undefined}><Icon name={name} size={icon.md} color={primary ? p.onAccent : p.fgDim} /></View>}
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
  /** 紧凑按钮 36dp，只用于行内次要操作；主要操作保持 44dp */
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
    primary: { bg: p.accent, border: p.accent, fg: p.onAccent },
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

/**
 * 页头：左侧返回或品牌 · 标题（可带一行等宽副标题：目录、电脑、连接状态）· 右侧操作。
 * 各页共用同一高度与对齐，切换页面时标题不跳位。
 */
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
  return <Text accessibilityRole="header" style={[styles.section, { color: p.fgDim }]}>{children}</Text>
}

/** 元数据：等宽、淡色、表格数字（时间、计数、路径、电脑名） */
export function Meta({ children, color, numberOfLines, style }: { children: ReactNode; color?: string; numberOfLines?: number; style?: StyleProp<TextStyle> }) {
  const p = usePalette()
  return <Text numberOfLines={numberOfLines} style={[styles.meta, { color: color ?? p.fgMute }, style]}>{children}</Text>
}

/** 输入框：44dp、1px 描边；`code` 用于地址、配对码这类逐字核对的值，其余用正文字体 */
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

/**
 * 运行条：会话页输入区上方的一行状态（桌面运行条与状态栏的手机版）。
 * 运行中是方点阵，等你回答是提醒图标，断线是警告色点；文字始终在，不只靠颜色或动画表达。
 */
export function RunBar({ mode, text }: { mode: 'run' | 'wait' | 'offline'; text?: string }) {
  const p = usePalette()
  const label = text ?? (mode === 'run' ? STATUS_TEXT.run : mode === 'wait' ? STATUS_TEXT.wait : STATUS_TEXT.reconnecting)
  return <View style={styles.runbar}>
    {mode === 'run' ? <Spinner /> : mode === 'wait' ? <Icon name="bell" size={icon.sm} color={p.warn} /> : <StatusDot color={p.warn} />}
    <Text accessibilityLiveRegion="polite" numberOfLines={1} style={[styles.runbarText, { color: mode === 'wait' ? p.warn : p.fgDim }]}>{label}</Text>
  </View>
}

/** 列表里的状态点：未读、连接状态；运行中由 RunDot 表达。 */
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
  section: { fontSize: font.sm, fontWeight: weight.strong, marginTop: space[4], marginBottom: space[2] },
  meta: { fontSize: font.xs, fontVariant: ['tabular-nums'] },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: font.base },
  inputCode: { fontFamily: mono },
  runbar: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: space[2] },
  runbarText: { flexShrink: 1, fontSize: font.sm },
  dot: { width: 6, height: 6, borderRadius: 3 }
})
