import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useState } from 'react'
import { Alert, KeyboardAvoidingView, Linking, NativeModules, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { pair, pairViaRelay, RemoteHttpError, type Connection, type HostIdentity } from '../api/client'
import { normalizeBaseUrl } from '../api/base-url'
import type { RelayPairing } from '../api/relay'
import { parsePairingLink, type PairingPrefill } from '../pairLink'
import { font, icon, mono, radius, space, touch, usePalette, weight } from '../theme'
import { Button, Input } from '../ui'
import { Icon, BrandMark } from '../icons'
import { deviceInfo } from '../device'
import { useBottomInset } from '../insets'

const TAILSCALE_URL = 'https://tailscale.com/download/android'
const GUIDE_URL = 'https://github.com/Yu-DaTouX/Inkstone'
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
  const bottomInset = useBottomInset()
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
    catch { setError(pick('无法打开链接，请在浏览器中访问使用说明', 'Cannot open the link. Visit the guide in a browser.')) }
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
      if (value === undefined) return setError(pick('此设备暂不支持应用内扫码，请粘贴配对链接。', 'In-app scanning is unsupported. Paste the pairing link.'))
      if (value === null) return
      const parsed = parsePairingLink(value.trim())
      if (!parsed) return setError(pick('二维码不是有效的砚配对链接，请在电脑「设备连接」重新生成。', 'Not a valid Inkstone pairing code. Regenerate it in Device connection on the desktop.'))
      setAddress(parsed.address)
      setCode(parsed.code)
      setRelay(parsed.relay ?? null)
      setError(null)
    } catch (err) {
      setError((err as { code?: string })?.code === 'scanner_permission'
        ? pick('请允许砚使用相机后重试，或粘贴配对链接。', 'Allow camera access and retry, or paste the pairing link.')
        : pick('扫码暂不可用，请粘贴配对链接或手动输入电脑地址。', 'Scanning unavailable. Paste the link or enter the desktop address.'))
    }
  }

  const paste = async () => {
    try {
      const value = await scanner?.readClipboard()
      if (!value?.trim()) return setError(pick('剪贴板里没有链接或地址。', 'No link or address on the clipboard.'))
      acceptInput(value)
    } catch {
      setError(pick('无法读取剪贴板，请长按输入框粘贴。', 'Cannot read the clipboard. Long-press the field to paste.'))
    }
  }

  const confirmHostIdentity = (identity: HostIdentity): Promise<boolean> => new Promise((resolve) => {
    Alert.alert(
      pick('核对电脑身份', 'Confirm the desktop'),
      pick(`电脑「${identity.computer}」上显示的身份指纹应当与下面一致：\n\n${identity.fingerprint}\n\n不一致就取消：可能有人在中间冒充这台电脑。`, `The identity fingerprint shown on "${identity.computer}" should match:\n\n${identity.fingerprint}\n\nCancel if it does not: someone may be impersonating that desktop.`),
      [
        { text: pick('取消', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: pick('一致，连接', 'Matches, connect'), onPress: () => resolve(true) }
      ],
      { cancelable: false }
    )
  })

  const submit = async (): Promise<void> => {
    if (relay) {
      setBusy(true)
      setError(null)
      try {
        await onPaired(await pairViaRelay(relay, name.trim() || pick('我的手机', 'My phone')))
      } catch (err) {
        setError(err instanceof RemoteHttpError ? err.message : pick('经中继配对失败，请在电脑「中继接入」重新生成二维码。', 'Relay pairing failed. Regenerate the code in Relay access on the desktop.'))
      } finally {
        setBusy(false)
      }
      return
    }
    const baseUrl = normalizeBaseUrl(address)
    if (!baseUrl) return setError(address.trim().toLowerCase().startsWith('inkstone://')
      ? pick('配对链接无效或已过期，请在电脑重新生成。', 'Pairing link invalid or expired. Regenerate it on the desktop.')
      : pick('请输入电脑的 Tailscale 地址，例如 100.101.102.103:37892。', 'Enter the desktop Tailscale address, e.g. 100.101.102.103:37892.'))
    if (!/^\d{6}$/.test(code)) return setError(pick('配对码是 6 位数字', 'The pairing code is 6 digits'))
    setBusy(true)
    setError(null)
    try {
      await onPaired(await pair(baseUrl, code, name.trim() || pick('我的手机', 'My phone'), confirmHostIdentity))
    } catch (err) {
      setError(err instanceof RemoteHttpError ? err.message : pick('配对失败，请在电脑上重新生成配对码。', 'Pairing failed. Regenerate the code on the desktop.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg0 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: space[6] + bottomInset }]} keyboardShouldPersistTaps="handled">
        <View style={styles.topline}>
          <BrandMark size={40} />
          <Text style={[styles.kicker, { color: p.fgMute }]}>INKSTONE / PHONE</Text>
          {onCancel ? <Button label={pick('返回', 'Back')} variant="ghost" compact onPress={onCancel} /> : null}
        </View>
        <Text style={[styles.headline, { color: p.fg }]}>{pick('连接电脑', 'Connect to desktop')}</Text>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>01</Text><Text style={[styles.stepTitle, { color: p.fg }]}>{pick('连接同一个网络', 'Join the same network')}</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>{pick('手机与电脑需连接同一个 Tailscale 网络；电脑开启了「中继接入」时，直接扫它的二维码即可，不需要 Tailscale。', 'Phone and desktop need the same Tailscale network. With Relay access on, just scan its code; Tailscale is not needed.')}</Text>
          <Pressable accessibilityRole="link" onPress={() => void open(TAILSCALE_URL)} style={[styles.linkRow, { borderTopColor: p.borderSoft }]}>
            <Text style={[styles.linkText, { color: p.accent }]}>{pick('下载 Tailscale', 'Get Tailscale')}</Text><Icon name="external" size={icon.sm} color={p.accent} />
          </Pressable>
        </View>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>02</Text><Text style={[styles.stepTitle, { color: p.fg }]}>{pick('与电脑配对', 'Pair with desktop')}</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>{pick('在电脑「设置 → 设备连接」生成配对码。', 'Generate a code in Settings → Device connection on the desktop.')}</Text>
          <View style={styles.pairActions}>
            <Button label={pick('扫码配对', 'Scan code')} variant="secondary" onPress={() => void scan()} style={styles.pairAction} />
            <Button label={pick('粘贴链接', 'Paste link')} variant="secondary" onPress={() => void paste()} style={styles.pairAction} />
          </View>
          {relay ? <Text style={[styles.scanned, { color: p.ok }]}>{(relay.join ? pick(`加密连接「${relay.computerName}」，在外也能经中继连上`, `Encrypted link to ${relay.computerName}; works away from home via relay`) : pick(`加密连接「${relay.computerName}」，需与电脑在同一网络或同一个 Tailscale`, `Encrypted link to ${relay.computerName}; needs the same network or Tailscale`))}</Text> : prefill ? <Text style={[styles.scanned, { color: p.ok }]}>{pick('已填入配对信息', 'Pairing info filled in')}</Text> : null}
          <Text style={[styles.label, { color: p.fgDim }]}>{pick('配对链接或 Tailscale 地址', 'Pairing link or Tailscale address')}</Text>
          <Input code value={address} onChangeText={acceptInput} placeholder="100.101.102.103:37892" autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel={pick('配对链接或 Tailscale 地址', 'Pairing link or Tailscale address')} />
          <Text style={[styles.label, { color: p.fgDim }]}>{pick('6 位配对码', '6-digit code')}</Text>
          <Input code style={styles.code} value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" keyboardType="number-pad" maxLength={6} accessibilityLabel={pick('配对码', 'Pairing code')} />
          <Text style={[styles.label, { color: p.fgDim }]}>{pick('此手机名称', 'This phone name')}</Text>
          <Input value={name} onChangeText={setName} maxLength={60} accessibilityLabel={pick('此手机名称', 'This phone name')} />
          {error ? <Text style={[styles.error, { color: p.err }]} accessibilityLiveRegion="polite">{error}</Text> : null}
          <Button label={pick('连接电脑', 'Connect')} variant="primary" busy={busy} onPress={() => void submit()} style={styles.submit} />
        </View>

        <Pressable accessibilityRole="link" onPress={() => void open(GUIDE_URL)} style={styles.guide}>
          <Text style={{ color: p.accent, fontSize: font.sm }}>{pick('使用说明', 'Guide')}</Text><Icon name="external" size={icon.sm} color={p.accent} />
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
