import { pick } from '../../../src/shared/ui-lang'
import { useCallback, useEffect, useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { Icon } from '../icons'
import { useLifePalette } from '../life'
import { font, icon, radius, space } from '../theme'
import { Button, EmptyState, Header, IconButton, Input, Meta, SectionTitle } from '../ui'
import { listModels } from '../assistant/model'
import { clearSettings, loadSettings, maskKey, saveSettings, type AssistantProvider, type AssistantSettings } from '../assistant/store'

function blankProvider(): AssistantProvider {
  return { id: `p-${Date.now()}`, label: pick('新服务商', 'New provider'), baseUrl: 'https://api.example.com/v1', model: '', apiKey: '', temperature: 0.7 }
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
    catch { setNote(pick('配置保存失败，请重试。', 'Save failed. Try again.')); return false }
  }, [])

  const startEdit = useCallback((provider: AssistantProvider) => {
    setNote(null)
    setDraft({ ...provider })
  }, [])

  const saveDraft = useCallback(async () => {
    if (!settings || !draft) return
    const label = draft.label.trim() || pick('未命名服务商', 'Unnamed provider')
    const baseUrl = draft.baseUrl.trim().replace(/\/+$/, '')
    const model = draft.model.trim()
    if (!baseUrl || !model) { setNote(pick('地址和模型名都要填。', 'URL and model name are required.')); return }
    const exists = settings.providers.some((item) => item.id === draft.id)
    const providers = exists ? settings.providers.map((item) => (item.id === draft.id ? { ...draft, label, baseUrl, model } : item)) : [...settings.providers, { ...draft, label, baseUrl, model }]
    if (!await persist({ ...settings, providers, activeProviderId: exists ? settings.activeProviderId : draft.id })) return
    setDraft(null)
    setNote(pick('已保存。', 'Saved.'))
  }, [draft, persist, settings])

  const testDraft = useCallback(async () => {
    if (!draft) return
    setBusy(true)
    setNote(null)
    try {
      const models = await listModels(draft.baseUrl.trim(), draft.apiKey.trim())
      setNote(models.length ? pick(`连接正常，拿到 ${models.length} 个模型${draft.model.trim() ? '' : `，例如 ${models.slice(0, 3).join('、')}`}`, `Connected. ${models.length} models${draft.model.trim() ? '' : `, e.g. ${models.slice(0, 3).join(', ')}`}`) : pick('连接正常，但模型列表是空的，可能需要手动填模型名。', 'Connected, but the model list is empty. Enter the model name manually.'))
    } catch (error) {
      setNote(error instanceof Error ? error.message : pick('测试失败', 'Test failed'))
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
      <Header title={pick('模型与服务商', 'Models and providers')} left={<IconButton name="back" label={pick('返回', 'Back')} onPress={onBack} />} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {draft ? (
          <>
            <SectionTitle>{pick('编辑服务商', 'Edit provider')}</SectionTitle>
            <Field label={pick('名称', 'Name')}><Input value={draft.label} onChangeText={(text) => setDraft({ ...draft, label: text })} placeholder={pick('例如 Command Code', 'e.g. Command Code')} accessibilityLabel={pick('服务商名称', 'Provider name')} /></Field>
            <Field label={pick('地址', 'URL')} hint={pick('OpenAI 兼容根地址，通常以 /v1 结尾', 'OpenAI-compatible base URL, usually ending in /v1')}><Input code value={draft.baseUrl} onChangeText={(text) => setDraft({ ...draft, baseUrl: text })} autoCapitalize="none" autoCorrect={false} accessibilityLabel={pick('接口地址', 'API URL')} /></Field>
            <Field label={pick('密钥', 'Key')} hint={pick('存系统钥匙串，不会写进普通存储或日志', 'Stored in the system keychain, never in plain storage or logs')}><Input code value={draft.apiKey} onChangeText={(text) => setDraft({ ...draft, apiKey: text })} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel={pick('密钥', 'Key')} placeholder="sk-…" /></Field>
            <Field label={pick('模型', 'Model')}><Input code value={draft.model} onChangeText={(text) => setDraft({ ...draft, model: text })} autoCapitalize="none" autoCorrect={false} accessibilityLabel={pick('模型名', 'Model name')} placeholder={pick('例如 deepseek-v4.1-flash', 'e.g. deepseek-v4.1-flash')} /></Field>
            <View style={styles.row}>
              <Button label={pick('测试连接', 'Test connection')} compact variant="secondary" busy={busy} onPress={() => void testDraft()} />
              <Button label={pick('保存', 'Save')} compact variant="primary" onPress={() => void saveDraft()} />
              <Button label={pick('取消', 'Cancel')} compact variant="ghost" onPress={() => { setDraft(null); setNote(null) }} />
            </View>
          </>
        ) : (
          <>
            <SectionTitle>{pick('服务商', 'Providers')}</SectionTitle>
            {settings && settings.providers.length > 0 ? settings.providers.map((provider) => (
              <View key={provider.id} style={[styles.card, { borderColor: provider.id === settings.activeProviderId ? p.accentLine : p.borderSoft, backgroundColor: p.bg2 }]}>
                <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                  <Text style={{ color: p.fg, fontSize: font.base }}>{provider.label}{provider.id === settings.activeProviderId ? pick(' · 使用中', ' · in use') : ''}</Text>
                  <Meta numberOfLines={1}>{provider.model || pick('未填模型', 'No model')}</Meta>
                  <Meta numberOfLines={1}>{provider.baseUrl} · {provider.apiKey ? maskKey(provider.apiKey) : pick('没有密钥', 'No key')}</Meta>
                </View>
                <IconButton name="pencil" label={pick('编辑', 'Edit')} onPress={() => startEdit(provider)} />
                <IconButton name="close" label={pick('删除', 'Delete')} onPress={() => void removeProvider(provider.id)} />
              </View>
            )) : <EmptyState>{pick('还没有服务商。添加一个之后就能用真实模型对话。', 'No providers yet. Add one to chat with a real model.')}</EmptyState>}
            <View style={styles.row}>
              <Button label={pick('添加服务商', 'Add provider')} compact icon="plus" onPress={() => startEdit(blankProvider())} />
            </View>
            <SectionTitle>{pick('数据', 'Data')}</SectionTitle>
            <View style={styles.row}>
              <Button label={pick('清空助手配置', 'Clear assistant settings')} compact variant="danger" onPress={() => void clearSettings().then(() => { setSettings({ providers: [], activeProviderId: null, remember: true }); setNote(pick('已清空。', 'Cleared.')) }).catch(() => setNote(pick('清空失败，请重试。', 'Clear failed. Try again.')))} />
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
