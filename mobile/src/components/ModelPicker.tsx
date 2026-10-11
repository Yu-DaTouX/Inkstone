import { useEffect, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RemoteModel } from '../../../src/shared/remote-protocol'
import { useRemote } from '../state'
import { Icon } from '../icons'
import { IconButton, Input, Meta } from '../ui'
import { RunDot } from '../motion'
import { font, icon, mono, radius, space, touch, usePalette } from '../theme'

/** 与桌面模型菜单同名：关 / 最低 / 低 / 中 / 高 / 极高 / Max */
const THINK_LABEL: Record<string, string> = { off: '关', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: 'Max' }

/** 文字切换项：淡色字，选中为正文色 + 1px 强调色下划线（桌面启动页同款） */
function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const p = usePalette()
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: touch.min, paddingHorizontal: space[3], justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ fontFamily: mono, fontSize: font.sm, color: selected ? p.fg : p.fgMute, paddingBottom: 2, borderBottomWidth: 1, borderBottomColor: selected ? p.accent : 'transparent' }}>{label}</Text>
  </Pressable>
}

export function ModelPicker({ sessionId, visible, onClose, onChanged }: { sessionId: string; visible: boolean; onClose(): void; onChanged(model: RemoteModel): void }) {
  const p = usePalette()
  const { height } = useWindowDimensions()
  const { client, refresh, info } = useRemote()
  const [models, setModels] = useState<RemoteModel[]>([])
  const [current, setCurrent] = useState<RemoteModel | null>(null)
  const [thinking, setThinking] = useState<{ level: string; levels: string[] } | null>(null)
  const [provider, setProvider] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true); setError(null); setQuery(''); setProvider(null)
    void client.models(sessionId).then((result) => { if (alive) { setModels(result.models); setCurrent(result.current); setThinking(result.thinking ?? null) } })
      .catch((err: Error) => { if (alive) setError(err.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, sessionId, visible])
  const providers = useMemo(() => [...new Set(models.map((model) => model.provider))], [models])
  const shown = useMemo(() => models.filter((model) => (!provider || model.provider === provider)
    && `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query.trim().toLowerCase())), [models, provider, query])
  const choose = async (model: RemoteModel) => {
    if (busy) return
    if (current?.id === model.id && current.provider === model.provider) { onClose(); return }
    setBusy(true); setError(null)
    try { const changed = await client.setModel(sessionId, model); onChanged(changed); onClose(); void refresh() }
    catch (err) { setError(err instanceof Error ? err.message : '切换失败') }
    finally { setBusy(false) }
  }
  const chooseThinking = async (level: string) => {
    if (busy || !thinking || thinking.level === level) return
    setBusy(true); setError(null)
    try { await client.setThinking(sessionId, level); setThinking({ ...thinking, level }); void refresh() }
    catch (err) { setError(err instanceof Error ? err.message : '切换失败') }
    finally { setBusy(false) }
  }
  const canThinking = !!info?.capabilities.includes('thinking') && !!thinking
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityLabel="关闭模型选择" onPress={() => { if (!busy) onClose() }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 640, height: height * 0.78, backgroundColor: p.bg1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space[3] }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: mono, fontSize: font.base, color: p.fgMute }}>{'## 模型'}</Text>
          {busy ? <RunDot label="正在切换" /> : <IconButton name="close" label="关闭模型选择" onPress={onClose} />}
        </View>
        {canThinking ? <View style={{ paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontFamily: mono, fontSize: font.sm, color: p.fgMute, marginRight: space[2] }}>思考</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {thinking!.levels.map((level) => <Choice key={level} label={THINK_LABEL[level] ?? level} selected={thinking!.level === level} disabled={busy} onPress={() => void chooseThinking(level)} />)}
          </ScrollView>
        </View> : null}
        {providers.length > 1 ? <View style={{ paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontFamily: mono, fontSize: font.sm, color: p.fgMute, marginRight: space[2] }}>供应商</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Choice label="全部" selected={!provider} onPress={() => setProvider(null)} />
            {providers.map((name) => <Choice key={name} label={name} selected={provider === name} onPress={() => setProvider(name)} />)}
          </ScrollView>
        </View> : null}
        <Input inset value={query} onChangeText={setQuery} placeholder="搜索模型" accessibilityLabel="搜索模型" style={{ marginHorizontal: space[4], marginTop: space[2] }} />
        {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err, fontSize: font.sm }}>{error}</Text> : null}
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={shown}
          keyExtractor={(model) => `${model.provider}:${model.id}`}
          contentContainerStyle={{ padding: space[4] }}
          ListEmptyComponent={loading ? <View style={{ alignItems: 'center', paddingVertical: space[4] }}><RunDot label="读取模型列表" /></View> : <Meta style={{ fontSize: font.sm }}>{error ? '' : '暂无可用模型'}</Meta>}
          renderItem={({ item }) => {
            const selected = current?.id === item.id && current.provider === item.provider
            return <Pressable disabled={busy || loading} accessibilityRole="button" accessibilityState={{ selected, disabled: busy }} onPress={() => void choose(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 56, paddingHorizontal: space[2], paddingVertical: space[2], borderRadius: radius.sm, backgroundColor: selected ? p.bg3 : 'transparent' }}>
              <View style={{ width: 20 }}>{selected ? <Icon name="check" size={icon.sm} color={p.accent} /> : null}</View>
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text numberOfLines={1} style={{ color: p.fg, fontSize: font.base }}>{item.name || item.id}</Text>
                {provider ? null : <Meta numberOfLines={1}>{item.provider}</Meta>}
              </View>
              {item.input?.includes('image') ? <Icon name="image" size={icon.sm} color={p.fgMute} /> : null}
            </Pressable>
          }}
        />
      </SafeAreaView>
    </View>
  </Modal>
}
