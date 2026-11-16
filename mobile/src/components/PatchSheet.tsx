import { pick } from '../../../src/shared/ui-lang'
import { useEffect, useMemo, useState } from 'react'
import { Modal, ScrollView, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import type { RemoteSubagentPatch } from '../../../src/shared/remote-protocol'
import { patchLines } from '../activity'
import { RunDot } from '../motion'
import { useRemote } from '../state'
import { font, mono, space, usePalette } from '../theme'
import { IconButton } from '../ui'

export function PatchSheet({ sessionId, runId, title, onClose }: { sessionId: string; runId: string | null; title: string; onClose(): void }) {
  const p = usePalette()
  const { client } = useRemote()
  const [patch, setPatch] = useState<RemoteSubagentPatch | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!runId) return
    let alive = true
    setPatch(null); setError(null)
    client.subagentPatch(sessionId, runId)
      .then((next) => { if (alive) setPatch(next) })
      .catch((err) => { if (alive) setError(err instanceof Error ? err.message : pick('读取补丁失败', 'Could not load the patch')) })
    return () => { alive = false }
  }, [client, runId, sessionId])
  const shown = useMemo(() => (patch ? patchLines(patch.patch) : null), [patch])
  const color = { file: p.fg, hunk: p.accent, add: p.add, del: p.del, ctx: p.fgDim }
  return <Modal visible={!!runId} animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={{ flex: 1, backgroundColor: p.bg0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: space[2], paddingVertical: space[1] }}>
        <IconButton name="back" label={pick('关闭补丁', 'Close patch')} onPress={onClose} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" numberOfLines={1} style={{ color: p.fg, fontSize: font.base }}>{title}</Text>
          {patch ? <Text style={{ color: p.fgMute, fontSize: font.xs, fontFamily: mono }}>{pick(`${patch.files} 个文件`, `${patch.files} files`)} <Text style={{ color: p.add }}>+{patch.additions}</Text> <Text style={{ color: p.del }}>−{patch.deletions}</Text></Text> : null}
        </View>
      </View>
      {error ? <Text accessibilityLiveRegion="polite" style={{ padding: space[4], color: p.err, fontSize: font.sm }}>{error}</Text> : !shown ? <View style={{ padding: space[4] }}><RunDot label={pick('正在读取补丁', 'Loading patch')} /></View> : <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space[5] }}>
        {patch?.truncated || shown.clipped ? <Text style={{ paddingHorizontal: space[3], paddingVertical: space[2], color: p.warn, fontSize: font.xs }}>{pick(`补丁较大（${Math.round((patch?.bytes ?? 0) / 1024)} KB），手机上只显示前一部分，完整内容请在电脑上查看。`, `The patch is large (${Math.round((patch?.bytes ?? 0) / 1024)} KB); only the first part is shown. View it in full on the desktop.`)}</Text> : null}
        <ScrollView horizontal contentContainerStyle={{ paddingHorizontal: space[3] }}>
          <Text selectable>{shown.lines.map((line, index) => <Text key={index} style={{ color: color[line.kind], fontFamily: mono, fontSize: font.xs, lineHeight: 16 }}>{line.text}{'\n'}</Text>)}</Text>
        </ScrollView>
      </ScrollView>}
    </SafeAreaView>
  </Modal>
}
