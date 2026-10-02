import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Linking, NativeModules, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { normalizeBaseUrl, pair, pairViaRelay, RemoteHttpError, type Connection } from '../api/client'
import type { RelayPairing } from '../api/relay'
import { parsePairingLink, type PairingPrefill } from '../pairLink'
import { font, icon, mono, radius, space, touch, usePalette, weight } from '../theme'
import { Button, Input } from '../ui'
import { Icon, BrandMark } from '../icons'
import { deviceInfo } from '../device'

const TAILSCALE_URL = 'https://tailscale.com/download/android'
const GUIDE_URL = 'https://github.com/Yu-DaTouX/Inkstone/blob/main/docs/MOBILE_ACCESS.md'
const scanner = NativeModules.InkstonePairScanner as {
  scan(): Promise<string | null>
  readClipboard(): Promise<string | null>
} | undefined

export function PairScreen({ onPaired, prefill, onCancel }: {
  onPaired: (connection: Connection) => Promise<void>
  prefill?: PairingPrefill | null
  onCancel?: () => void
}) {
  const p = usePalette()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 扫到的是「中继接入」二维码：不用填地址，经中继连接 */
  const [relay, setRelay] = useState<RelayPairing | null>(null)
  useEffect(() => { void deviceInfo().then((device) => setName((current) => current || device.name)).catch(() => undefined) }, [])

  useEffect(() => {
    if (prefill) {
      setAddress(prefill.address)
      setCode(prefill.code)
      setRelay(prefill.relay ?? null)
      setError(null)
    }
  }, [prefill])

  const open = async (url: string) => {
    try { await Linking.openURL(url) }
    catch { setError('无法打开链接，请在浏览器中访问使用说明') }
  }

  const acceptInput = (value: string) => {
    const parsed = parsePairingLink(value.trim())
    if (parsed) {
      setAddress(parsed.address)
      setCode(parsed.code)
      setRelay(parsed.relay ?? null)
    } else {
      setAddress(value)
      setRelay(null)
    }
    setError(null)
  }

  const scan = async () => {
    try {
      const value = await scanner?.scan()
      if (value === undefined) return setError('此设备暂不支持应用内扫码，请粘贴配对链接。')
      if (value === null) return
      const parsed = parsePairingLink(value.trim())
      if (!parsed) return setError('二维码不是有效的砚配对链接，请在电脑「设备连接」重新生成。')
      setAddress(parsed.address)
      setCode(parsed.code)
      setRelay(parsed.relay ?? null)
      setError(null)
    } catch (err) {
      setError((err as { code?: string })?.code === 'scanner_permission'
        ? '请允许砚使用相机后重试，或粘贴配对链接。'
        : '扫码暂不可用，请粘贴配对链接或手动输入电脑地址。')
    }
  }

  const paste = async () => {
    try {
      const value = await scanner?.readClipboard()
      if (!value?.trim()) return setError('剪贴板里没有链接或地址。')
      acceptInput(value)
    } catch {
      setError('无法读取剪贴板，请长按输入框粘贴。')
    }
  }

  const submit = async (): Promise<void> => {
    if (relay) {
      setBusy(true)
      setError(null)
      try {
        await onPaired(await pairViaRelay(relay, name.trim() || '我的手机'))
      } catch (err) {
        setError(err instanceof RemoteHttpError ? err.message : '经中继配对失败，请在电脑「中继接入」重新生成二维码。')
      } finally {
        setBusy(false)
      }
      return
    }
    const baseUrl = normalizeBaseUrl(address)
    if (!baseUrl) return setError(address.trim().toLowerCase().startsWith('inkstone://')
      ? '配对链接无效或已过期，请在电脑重新生成。'
      : '请输入电脑的 Tailscale 地址，例如 100.101.102.103:37892。')
    if (!/^\d{6}$/.test(code)) return setError('配对码是 6 位数字')
    setBusy(true)
    setError(null)
    try {
      await onPaired(await pair(baseUrl, code, name.trim() || '我的手机'))
    } catch (err) {
      setError(err instanceof RemoteHttpError ? err.message : '配对失败，请在电脑上重新生成配对码。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg0 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.topline}>
          <BrandMark size={40} />
          <Text style={[styles.kicker, { color: p.fgMute }]}>INKSTONE / PHONE</Text>
          {onCancel ? <Button label="返回" variant="ghost" compact onPress={onCancel} /> : null}
        </View>
        <Text style={[styles.headline, { color: p.fg }]}>连接电脑</Text>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>01</Text><Text style={[styles.stepTitle, { color: p.fg }]}>连接同一个网络</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>手机与电脑需连接同一个 Tailscale 网络；电脑开启了「中继接入」时，直接扫它的二维码即可，不需要 Tailscale。</Text>
          <Pressable accessibilityRole="link" onPress={() => void open(TAILSCALE_URL)} style={[styles.linkRow, { borderTopColor: p.borderSoft }]}>
            <Text style={[styles.linkText, { color: p.accent }]}>下载 Tailscale</Text><Icon name="external" size={icon.sm} color={p.accent} />
          </Pressable>
        </View>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>02</Text><Text style={[styles.stepTitle, { color: p.fg }]}>与电脑配对</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>在电脑「设置 → 设备连接」生成配对码。</Text>
          <View style={styles.pairActions}>
            <Button label="扫码配对" variant="secondary" onPress={() => void scan()} style={styles.pairAction} />
            <Button label="粘贴链接" variant="secondary" onPress={() => void paste()} style={styles.pairAction} />
          </View>
          {relay ? <Text style={[styles.scanned, { color: p.ok }]}>{`经中继连接「${relay.computerName}」，不需要 Tailscale`}</Text> : prefill ? <Text style={[styles.scanned, { color: p.ok }]}>已填入配对信息</Text> : null}
          <Text style={[styles.label, { color: p.fgDim }]}>配对链接或 Tailscale 地址</Text>
          <Input code value={address} onChangeText={acceptInput} placeholder="100.101.102.103:37892" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="配对链接或 Tailscale 地址" />
          <Text style={[styles.label, { color: p.fgDim }]}>6 位配对码</Text>
          <Input code style={styles.code} value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" keyboardType="number-pad" maxLength={6} accessibilityLabel="配对码" />
          <Text style={[styles.label, { color: p.fgDim }]}>此手机名称</Text>
          <Input value={name} onChangeText={setName} maxLength={60} accessibilityLabel="此手机名称" />
          {error ? <Text style={[styles.error, { color: p.err }]} accessibilityLiveRegion="polite">{error}</Text> : null}
          <Button label="连接电脑" variant="primary" busy={busy} onPress={() => void submit()} style={styles.submit} />
        </View>

        <Pressable accessibilityRole="link" onPress={() => void open(GUIDE_URL)} style={styles.guide}>
          <Text style={{ color: p.accent, fontSize: font.sm }}>使用说明</Text><Icon name="external" size={icon.sm} color={p.accent} />
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: space[5], paddingTop: space[6], paddingBottom: space[6], gap: space[4] },
  topline: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  kicker: { flex: 1, fontSize: font.xs, fontWeight: weight.strong, fontFamily: mono, letterSpacing: 1.4 },
  headline: { marginTop: space[3], fontSize: font.title, lineHeight: 30, fontWeight: weight.strong },
  step: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  stepHeading: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  number: { fontSize: font.sm, fontWeight: weight.strong, fontFamily: mono, fontVariant: ['tabular-nums'] },
  stepTitle: { fontSize: font.lg, fontWeight: weight.strong },
  stepBody: { fontSize: font.sm, lineHeight: 20 },
  linkRow: { marginTop: space[1], paddingTop: space[3], borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  linkText: { fontSize: font.sm, fontWeight: weight.medium },
  scanned: { fontSize: font.sm, marginTop: space[1] },
  pairActions: { flexDirection: 'row', gap: space[2], marginTop: space[2] },
  pairAction: { flex: 1 },
  label: { fontSize: font.sm, fontWeight: weight.medium, marginTop: space[2] },
  code: { fontSize: font.title, letterSpacing: 7, fontVariant: ['tabular-nums'] },
  error: { fontSize: font.sm, lineHeight: 20 },
  submit: { marginTop: space[2] },
  guide: { flexDirection: 'row', gap: space[2], justifyContent: 'center', alignItems: 'center', minHeight: touch.min, paddingVertical: space[3] }
})
