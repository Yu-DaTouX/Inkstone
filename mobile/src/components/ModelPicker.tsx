import { useEffect, useState } from 'react'
import { ActivityIndicator, FlatList, Modal, Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RemoteModel } from '../../../src/shared/remote-protocol'
import { useRemote } from '../state'
import { Icon } from '../icons'
import { IconButton } from '../ui'
import { font, mono, radius, space, touch, usePalette } from '../theme'

export function ModelPicker({ sessionId, visible, onClose, onChanged }: { sessionId: string; visible: boolean; onClose(): void; onChanged(model: RemoteModel): void }) {
  const p = usePalette()
  const { height } = useWindowDimensions()
  const { client, refresh } = useRemote()
  const [models, setModels] = useState<RemoteModel[]>([])
  const [current, setCurrent] = useState<RemoteModel | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true); setError(null); setQuery('')
    void client.models(sessionId).then((result) => { if (alive) { setModels(result.models); setCurrent(result.current) } })
      .catch((err: Error) => { if (alive) setError(err.message) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [client, sessionId, visible])
  const choose = async (model: RemoteModel) => {
    if (busy) return
    if (current?.id === model.id && current.provider === model.provider) { onClose(); return }
    setBusy(true); setError(null)
    try { const changed = await client.setModel(sessionId, model); onChanged(changed); onClose(); void refresh() }
    catch (err) { setError(err instanceof Error ? err.message : '切换失败') }
    finally { setBusy(false) }
  }
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityLabel="关闭模型选择" onPress={() => { if (!busy) onClose() }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 640, height: Math.min(height * 0.72, Math.max(280, 190 + models.length * 68)), backgroundColor: p.bg1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space[3] }}><Text accessibilityRole="header" style={{ flex: 1, fontSize: font.lg, fontWeight: '600', color: p.fg }}>模型</Text>{busy ? <ActivityIndicator color={p.accent} /> : <IconButton name="close" label="关闭模型选择" onPress={onClose} />}</View>
        <TextInput disableFullscreenUI value={query} onChangeText={setQuery} placeholder="搜索模型" placeholderTextColor={p.fgMute} accessibilityLabel="搜索模型" style={{ marginHorizontal: space[4], minHeight: touch.min, paddingHorizontal: space[3], color: p.fg, fontFamily: mono, backgroundColor: p.bg0, borderRadius: radius.md }} />
        {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err }}>{error}</Text> : null}
        <FlatList keyboardShouldPersistTaps="handled" data={models.filter((model) => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query.trim().toLowerCase()))} keyExtractor={(model) => `${model.provider}:${model.id}`} contentContainerStyle={{ padding: space[4] }} ListEmptyComponent={loading ? <ActivityIndicator color={p.accent} /> : <Text style={{ color: p.fgMute }}>{error ? '' : '暂无可用模型'}</Text>} renderItem={({ item }) => {
          const selected = current?.id === item.id && current.provider === item.provider
          return <Pressable disabled={busy || loading} accessibilityRole="button" accessibilityState={{ selected, disabled: busy }} onPress={() => void choose(item)} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 68, padding: space[3], borderRadius: radius.md, backgroundColor: selected ? p.accentSoft : 'transparent' }}><View style={{ flex: 1, gap: 4 }}><Text numberOfLines={1} style={{ color: p.fg, fontSize: font.base }}>{item.name || item.id}</Text><Text numberOfLines={1} style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{item.provider} / {item.id}</Text></View>{item.input?.includes('image') ? <Icon name="image" size={16} color={p.fgMute} /> : null}{selected ? <Icon name="check" size={18} color={p.accent} /> : null}</Pressable>
        }} />
      </SafeAreaView>
    </View>
  </Modal>
}
