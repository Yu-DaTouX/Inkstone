import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { normalizeBaseUrl, pair, RemoteHttpError, type Connection } from '../api/client'
import type { PairingPrefill } from '../pairLink'
import { font, radius, space, touch, usePalette } from '../theme'
import { Button } from '../ui'
import { Icon, BrandMark } from '../icons'
import { deviceInfo } from '../device'

const TAILSCALE_URL = 'https://tailscale.com/download/android'
const GUIDE_URL = 'https://github.com/Yu-DaTouX/Inkstone/blob/main/docs/MOBILE_ACCESS.md'

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
  useEffect(() => { void deviceInfo().then((device) => setName((current) => current || device.name)).catch(() => undefined) }, [])

  useEffect(() => {
    if (prefill) {
      setAddress(prefill.address)
      setCode(prefill.code)
      setError(null)
    }
  }, [prefill])

  const open = async (url: string) => {
    try { await Linking.openURL(url) }
    catch { setError('无法打开链接，请在浏览器中访问使用说明') }
  }

  const submit = async (): Promise<void> => {
    const baseUrl = normalizeBaseUrl(address)
    if (!baseUrl) return setError('请填写有效的电脑地址，不要包含路径、账号或密码')
    if (!/^\d{6}$/.test(code)) return setError('配对码是 6 位数字')
    setBusy(true)
    setError(null)
    try {
      await onPaired(await pair(baseUrl, code, name.trim() || '我的手机'))
    } catch (err) {
      setError(err instanceof RemoteHttpError ? err.message : '配对或保存失败，请在电脑上重新生成配对码')
    } finally {
      setBusy(false)
    }
  }

  const input = [styles.input, { backgroundColor: p.bg2, borderColor: p.border, color: p.fg }]
  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: p.bg0 }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.topline}>
          <BrandMark size={40} />
          <Text style={[styles.kicker, { color: p.fgMute }]}>INKSTONE / PHONE</Text>
          {onCancel ? <Pressable accessibilityRole="button" onPress={onCancel}><Text style={{ color: p.accent, fontSize: font.sm }}>返回</Text></Pressable> : null}
        </View>
        <Text style={[styles.headline, { color: p.fg }]}>连接电脑</Text>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>01</Text><Text style={[styles.stepTitle, { color: p.fg }]}>连接同一个网络</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>手机与电脑登录同一个 Tailscale 网络。</Text>
          <Pressable accessibilityRole="link" onPress={() => void open(TAILSCALE_URL)} style={[styles.linkRow, { borderTopColor: p.borderSoft }]}>
            <Text style={[styles.linkText, { color: p.accent }]}>下载 Tailscale</Text><Icon name="external" size={18} color={p.accent} />
          </Pressable>
        </View>

        <View style={[styles.step, { backgroundColor: p.bg1, borderColor: p.borderSoft }]}>
          <View style={styles.stepHeading}><Text style={[styles.number, { color: p.accent }]}>02</Text><Text style={[styles.stepTitle, { color: p.fg }]}>与电脑配对</Text></View>
          <Text style={[styles.stepBody, { color: p.fgDim }]}>电脑「设置 → 手机接入」，扫码或填写配对码。</Text>
          {prefill ? <Text style={[styles.scanned, { color: p.ok }]}>已填入配对信息</Text> : null}
          <Text style={[styles.label, { color: p.fgDim }]}>电脑地址</Text>
          <TextInput disableFullscreenUI style={input} value={address} onChangeText={setAddress} placeholder="100.101.102.103:37892" placeholderTextColor={p.fgMute} autoCapitalize="none" autoCorrect={false} keyboardType="url" accessibilityLabel="电脑地址" />
          <Text style={[styles.label, { color: p.fgDim }]}>6 位配对码</Text>
          <TextInput disableFullscreenUI style={[input, styles.code]} value={code} onChangeText={(value) => setCode(value.replace(/\D/g, '').slice(0, 6))} placeholder="000000" placeholderTextColor={p.fgMute} keyboardType="number-pad" maxLength={6} accessibilityLabel="配对码" />
          <Text style={[styles.label, { color: p.fgDim }]}>此手机名称</Text>
          <TextInput disableFullscreenUI style={input} value={name} onChangeText={setName} maxLength={60} accessibilityLabel="此手机名称" />
          {error ? <Text style={[styles.error, { color: p.err }]} accessibilityLiveRegion="polite">{error}</Text> : null}
          <Button label="连接电脑" variant="primary" busy={busy} onPress={() => void submit()} style={styles.submit} />
        </View>

        <Pressable accessibilityRole="link" onPress={() => void open(GUIDE_URL)} style={styles.guide}>
          <Text style={{ color: p.accent, fontSize: font.sm }}>使用说明</Text><Icon name="external" size={16} color={p.accent} />
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: { width: '100%', maxWidth: 640, alignSelf: 'center', paddingHorizontal: space[5], paddingTop: space[6], paddingBottom: space[6], gap: space[4] },
  topline: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  mark: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  kicker: { flex: 1, fontSize: font.xs, fontWeight: '700', letterSpacing: 1.4 },
  headline: { marginTop: space[3], fontSize: 29, lineHeight: 38, fontWeight: '700' },
  intro: { fontSize: font.base, lineHeight: 23, marginBottom: space[2] },
  step: { borderWidth: 1, borderRadius: radius.lg, padding: space[4], gap: space[2] },
  stepHeading: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  number: { fontSize: font.sm, fontWeight: '700', letterSpacing: 1 },
  stepTitle: { fontSize: font.lg, fontWeight: '600' },
  stepBody: { fontSize: font.sm, lineHeight: 20 },
  linkRow: { marginTop: space[1], paddingTop: space[3], borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  linkText: { fontSize: font.sm, fontWeight: '600' },
  scanned: { fontSize: font.sm, marginTop: space[1] },
  label: { fontSize: font.sm, fontWeight: '600', marginTop: space[2] },
  input: { minHeight: touch.min, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space[3], fontSize: font.base },
  code: { fontSize: 22, letterSpacing: 7, fontVariant: ['tabular-nums'] },
  error: { fontSize: font.sm, lineHeight: 20 },
  submit: { marginTop: space[2] },
  guide: { flexDirection: 'row', gap: space[2], justifyContent: 'center', alignItems: 'center', minHeight: touch.min, paddingVertical: space[3] }
})
