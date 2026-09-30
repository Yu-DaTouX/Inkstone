/**
 * 助手设置：模型服务商与密钥。
 *
 * 密钥存系统钥匙串（见 `assistant/store.ts`），这里只显示尾 4 位。
 * 「测试连接」拉一次 /models，比发对话便宜，也不会消耗额度。
 */
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon } from '../icons'
import { useLifePalette } from '../life'
import { font, icon, radius, space } from '../theme'
import { Button, EmptyState, Header, IconButton, Input, Meta, SectionTitle } from '../ui'
import { listModels } from '../assistant/model'
import { clearSettings, loadSettings, maskKey, saveSettings, type AssistantProvider, type AssistantSettings } from '../assistant/store'

/** 新服务商的默认值：只预填地址形状，密钥与模型名必须用户自己填。 */
function blankProvider(): AssistantProvider {
  return { id: `p-${Date.now()}`, label: '新服务商', baseUrl: 'https://api.example.com/v1', model: '', apiKey: '', temperature: 0.7 }
}

export function AssistantSettingsScreen({ onBack }: { onBack: () => void }) {
  const p = useLifePalette()
  const [settings, setSettings] = useState<AssistantSettings | null>(null)
  const [draft, setDraft] = useState<AssistantProvider | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void loadSettings().then((next) => { if (alive) setSettings(next) })
    return () => { alive = false }
  }, [])

  const persist = useCallback(async (next: AssistantSettings) => {
    try { await saveSettings(next); setSettings(next); return true }
    catch { setNote('配置保存失败，请重试。'); return false }
  }, [])

  const startEdit = useCallback((provider: AssistantProvider) => {
    setNote(null)
    setDraft({ ...provider })
  }, [])

  const saveDraft = useCallback(async () => {
    if (!settings || !draft) return
    const label = draft.label.trim() || '未命名服务商'
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, '')
    const model = draft.model.trim()
    if (!baseUrl || !model) { setNote('地址和模型名都要填。'); return }
    const exists = settings.providers.some((item) => item.id === draft.id)
    const providers = exists ? settings.providers.map((item) => (item.id === draft.id ? { ...draft, label, baseUrl, model } : item)) : [...settings.providers, { ...draft, label, baseUrl, model }]
    if (!await persist({ ...settings, providers, activeProviderId: exists ? settings.activeProviderId : draft.id })) return
    setDraft(null)
    setNote('已保存。')
  }, [draft, persist, settings])

  const testDraft = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setNote(null)
    try {
      const models = await listModels(draft.baseUrl.trim(), draft.apiKey.trim())
      setNote(models.length ? `连接正常，拿到 ${models.length} 个模型${draft.model.trim() ? '' : `，例如 ${models.slice(0, 3).join('、')}`}` : '连接正常，但模型列表是空的，可能需要手动填模型名。')
    } catch (error) {
      setNote(error instanceof Error ? error.message : '测试失败')
    } finally {
      setBusy(false)
    }
  }, [draft])

  const removeProvider = useCallback(async (id: string) => {
    if (!settings) return
    const providers = settings.providers.filter((item) => item.id !== id)
    await persist({ ...settings, providers, activeProviderId: providers[0]?.id ?? null })
  }, [persist, settings])

  return (
    <View style={{ flex: 1, backgroundColor: p.bg0 }}>
      <Header title="模型与服务商" left={<IconButton name="back" label="返回" onPress={onBack} />} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {draft ? (
          <>
            <SectionTitle>编辑服务商</SectionTitle>
            <Field label="名称"><Input value={draft.label} onChangeText={(text) => setDraft({ ...draft, label: text })} placeholder="例如 Command Code" accessibilityLabel="服务商名称" /></Field>
            <Field label="地址" hint="OpenAI 兼容根地址，通常以 /v1 结尾"><Input code value={draft.baseUrl} onChangeText={(text) => setDraft({ ...draft, baseUrl: text })} autoCapitalize="none" autoCorrect={false} accessibilityLabel="接口地址" /></Field>
            <Field label="密钥" hint="存系统钥匙串，不会写进普通存储或日志"><Input code value={draft.apiKey} onChangeText={(text) => setDraft({ ...draft, apiKey: text })} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="密钥" placeholder="sk-…" /></Field>
            <Field label="模型"><Input code value={draft.model} onChangeText={(text) => setDraft({ ...draft, model: text })} autoCapitalize="none" autoCorrect={false} accessibilityLabel="模型名" placeholder="例如 deepseek-v4.1-flash" /></Field>
            <View style={styles.row}>
              <Button label="测试连接" compact variant="secondary" busy={busy} onPress={() => void testDraft()} />
              <Button label="保存" compact variant="primary" onPress={() => void saveDraft()} />
              <Button label="取消" compact variant="ghost" onPress={() => { setDraft(null); setNote(null) }} />
            </View>
          </>
        ) : (
          <>
            <SectionTitle>服务商</SectionTitle>
            {settings && settings.providers.length > 0 ? settings.providers.map((provider) => (
              <View key={provider.id} style={[styles.card, { borderColor: provider.id === settings.activeProviderId ? p.accentLine : p.borderSoft, backgroundColor: p.bg2 }]}>
                <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <Text style={{ color: p.fg, fontSize: font.base }}>{provider.label}{provider.id === settings.activeProviderId ? ' · 使用中' : ''}</Text>
                  <Meta numberOfLines={1}>{provider.model || '未填模型'}</Meta>
                  <Meta numberOfLines={1}>{provider.baseUrl} · {provider.apiKey ? maskKey(provider.apiKey) : '没有密钥'}</Meta>
                </View>
                <IconButton name="pencil" label="编辑" onPress={() => startEdit(provider)} />
                <IconButton name="close" label="删除" onPress={() => void removeProvider(provider.id)} />
              </View>
            )) : <EmptyState>还没有服务商。添加一个之后就能用真实模型对话。</EmptyState>}
            <View style={styles.row}>
              <Button label="添加服务商" compact icon="plus" onPress={() => startEdit(blankProvider())} />
            </View>
            <SectionTitle>数据</SectionTitle>
            <View style={styles.row}>
              <Button label="清空助手配置" compact variant="danger" onPress={() => void clearSettings().then(() => { setSettings({ providers: [], activeProviderId: null, remember: true }); setNote('已清空。') }).catch(() => setNote('清空失败，请重试。'))} />
            </View>
          </>
        )}
        {note ? <View style={[styles.note, { backgroundColor: p.bg2, borderColor: p.borderSoft }]}><Icon name="alert-circle" size={icon.sm} color={p.fgDim} /><Text style={{ color: p.fg, fontSize: font.sm, flex: 1 }}>{note}</Text></View> : null}
      </ScrollView>
    </View>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const p = useLifePalette()
  return (
    <View style={{ gap: space[1], marginBottom: space[3] }}>
      <Text style={{ color: p.fgDim, fontSize: font.sm }}>{label}</Text>
      {children}
      {hint ? <Meta>{hint}</Meta> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  body: { padding: space[4], paddingBottom: space[6] },
  card: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: 1, borderRadius: radius.md, padding: space[3], marginBottom: space[2] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], alignItems: 'center' },
  note: { flexDirection: 'row', alignItems: 'center', gap: space[2], borderWidth: 1, borderRadius: radius.md, padding: space[3], marginTop: space[4] }
})
