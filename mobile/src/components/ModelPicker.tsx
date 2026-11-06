import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useMemo, useState } from 'react'
import { FlatList, Modal, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RemoteModel } from '../../../src/shared/remote-protocol'
import { useRemote } from '../state'
import { Icon } from '../icons'
import { IconButton, Input, Meta } from '../ui'
import { RunDot } from '../motion'
import { font, icon, mono, radius, space, touch, usePalette } from '../theme'

const THINK_LABEL: Record<string, string> = {
  get off() { return pick('关', 'Off') },
  get minimal() { return pick('最低', 'Minimal') },
  get low() { return pick('低', 'Low') },
  get medium() { return pick('中', 'Medium') },
  get high() { return pick('高', 'High') },
  get xhigh() { return pick('极高', 'Extra high') },
  max: 'Max'
}

function Choice({ label, selected, disabled, onPress }: { label: string; selected: boolean; disabled?: boolean; onPress: () => void }) {
  const p = usePalette()
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress} style={{ minHeight: touch.min, paddingHorizontal: space[3], justifyContent: 'center', opacity: disabled ? 0.5 : 1 }}>
    <Text style={{ fontFamily: mono, fontSize: font.sm, color: selected ? p.fg : p.fgMute, paddingBottom: 2, borderBottomWidth: 1, borderBottomColor: selected ? p.accent : 'transparent' }}>{label}</Text>
  </Pressable>
}

export function ModelPicker({ sessionId, visible, running = false, onClose, onChanged }: { sessionId: string; visible: boolean; running?: boolean; onClose(): void; onChanged(model: RemoteModel): void }) {
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
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) return
    let alive = true
    setLoading(true); setError(null); setQuery(''); setProvider(null); setPending(false)
    void client.models(sessionId).then((result) => { if (alive) { setModels(result.models); setCurrent(result.current); setThinking(result.thinking ?? null); setPending(!!result.pending) } })
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
    try { const changed = await client.setModel(sessionId, model); onChanged(changed); void refresh(); if (running) { setCurrent(changed); setPending(true) } else onClose() }
    catch (err) { setError(err instanceof Error ? err.message : pick('切换失败', 'Switch failed')) }
    finally { setBusy(false) }
  }
  const chooseThinking = async (level: string) => {
    if (busy || !thinking || thinking.level === level) return
    setBusy(true); setError(null)
    try { await client.setThinking(sessionId, level); setThinking({ ...thinking, level }); if (running) setPending(true); void refresh() }
    catch (err) { setError(err instanceof Error ? err.message : pick('切换失败', 'Switch failed')) }
    finally { setBusy(false) }
  }
  const canThinking = !!info?.capabilities.includes('thinking') && !!thinking
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={() => { if (!busy) onClose() }} statusBarTranslucent navigationBarTranslucent>
    <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end', alignItems: 'center' }}>
      <Pressable accessibilityLabel={pick('关闭模型选择', 'Close model picker')} onPress={() => { if (!busy) onClose() }} style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} />
      <SafeAreaView edges={['bottom', 'left', 'right']} style={{ width: '100%', maxWidth: 640, height: height * 0.78, backgroundColor: p.bg1, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', padding: space[3] }}>
          <Text accessibilityRole="header" style={{ flex: 1, fontFamily: mono, fontSize: font.base, color: p.fgMute }}>{pick('模型', 'Model')}</Text>
          {pending || running ? <Text style={{ fontSize: font.xs, color: pending ? p.accent : p.fgMute, marginRight: space[2] }}>{pending ? pick('下一条消息生效', 'Applies to next message') : pick('运行中，下一条消息生效', 'Running; applies to next message')}</Text> : null}
          {busy ? <RunDot label={pick('正在切换', 'Switching')} /> : <IconButton name="close" label={pick('关闭模型选择', 'Close model picker')} onPress={onClose} />}
        </View>
        {canThinking ? <View style={{ paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontFamily: mono, fontSize: font.sm, color: p.fgMute, marginRight: space[2] }}>{pick('思考', 'Thinking')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            {thinking!.levels.map((level) => <Choice key={level} label={THINK_LABEL[level] ?? level} selected={thinking!.level === level} disabled={busy} onPress={() => void chooseThinking(level)} />)}
          </ScrollView>
        </View> : null}
        {providers.length > 1 ? <View style={{ paddingHorizontal: space[4], flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ fontFamily: mono, fontSize: font.sm, color: p.fgMute, marginRight: space[2] }}>{pick('供应商', 'Provider')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <Choice label={pick('全部', 'All')} selected={!provider} onPress={() => setProvider(null)} />
            {providers.map((name) => <Choice key={name} label={name} selected={provider === name} onPress={() => setProvider(name)} />)}
          </ScrollView>
        </View> : null}
        <Input inset value={query} onChangeText={setQuery} placeholder={pick('搜索模型', 'Search models')} accessibilityLabel={pick('搜索模型', 'Search models')} style={{ marginHorizontal: space[4], marginTop: space[2] }} />
        {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err, fontSize: font.sm }}>{error}</Text> : null}
        <FlatList
          keyboardShouldPersistTaps="handled"
          data={shown}
          keyExtractor={(model) => `${model.provider}:${model.id}`}
          contentContainerStyle={{ padding: space[4] }}
          ListEmptyComponent={loading ? <View style={{ alignItems: 'center', paddingVertical: space[4] }}><RunDot label={pick('读取模型列表', 'Loading models')} /></View> : <Meta style={{ fontSize: font.sm }}>{error ? '' : pick('暂无可用模型', 'No models available')}</Meta>}
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
