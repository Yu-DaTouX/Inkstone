import { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { pick } from '../../../src/shared/ui-lang'
import { checkForUpdate, currentVersion, downloadUpdate, installUpdate, updatesSupported, type AppUpdate } from '../appUpdate'
import { font, radius, space, usePalette } from '../theme'
import { Button, Meta } from '../ui'

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'latest' } | { kind: 'available'; update: AppUpdate } | { kind: 'downloading'; update: AppUpdate; fraction: number } | { kind: 'ready'; update: AppUpdate; path: string }

export function UpdateCard({ initial }: { initial?: AppUpdate | null }) {
  const p = usePalette()
  const [phase, setPhase] = useState<Phase>(initial ? { kind: 'available', update: initial } : { kind: 'idle' })
  if (!updatesSupported()) return null
  const fail = (title: string, error: unknown, next: Phase) => {
    setPhase(next)
    Alert.alert(title, error instanceof Error ? error.message : String(error))
  }
  const check = async () => {
    setPhase({ kind: 'checking' })
    try {
      const update = await checkForUpdate()
      setPhase(update ? { kind: 'available', update } : { kind: 'latest' })
    } catch (error) {
      fail(pick('检查更新失败', 'Update check failed'), error, { kind: 'idle' })
    }
  }
  const install = async (update: AppUpdate, path: string) => {
    try {
      const result = await installUpdate(path)
      setPhase({ kind: 'ready', update, path })
      if (result === 'permission') Alert.alert(pick('需要安装权限', 'Permission needed'), pick('请在打开的页面允许砚安装应用，返回后再点「安装」。', 'Allow Inkstone to install apps on the page that opened, then come back and tap Install.'))
    } catch (error) {
      fail(pick('无法安装', 'Cannot install'), error, { kind: 'ready', update, path })
    }
  }
  const download = async (update: AppUpdate) => {
    setPhase({ kind: 'downloading', update, fraction: 0 })
    try {
      const path = await downloadUpdate(update, (fraction) => setPhase({ kind: 'downloading', update, fraction }))
      await install(update, path)
    } catch (error) {
      fail(pick('下载失败', 'Download failed'), error, { kind: 'available', update })
    }
  }
  const size = (bytes: number) => (bytes > 0 ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB` : '')
  return (
    <View style={[styles.card, { borderColor: p.borderSoft, backgroundColor: p.bg1 }]}>
      <Text style={{ color: p.fg, fontSize: font.base }}>{pick(`当前版本 ${currentVersion()}`, `Current version ${currentVersion()}`)}</Text>
      {phase.kind === 'latest' ? <Meta style={{ fontSize: font.sm }}>{pick('已是最新版本', 'You are up to date')}</Meta> : null}
      {phase.kind === 'available' || phase.kind === 'downloading' || phase.kind === 'ready' ? (
        <Meta color={p.accent} style={{ fontSize: font.sm }}>{pick(`新版本 ${phase.update.version}${size(phase.update.size)}`, `New version ${phase.update.version}${size(phase.update.size)}`)}</Meta>
      ) : null}
      {phase.kind === 'downloading' ? <Meta style={{ fontSize: font.sm }}>{pick(`正在下载 ${Math.round(phase.fraction * 100)}%`, `Downloading ${Math.round(phase.fraction * 100)}%`)}</Meta> : null}
      {phase.kind === 'available' ? <Button label={pick('下载并安装', 'Download and install')} variant="primary" onPress={() => void download(phase.update)} />
        : phase.kind === 'downloading' ? <Button label={pick('下载中…', 'Downloading…')} busy disabled onPress={() => undefined} />
          : phase.kind === 'ready' ? <Button label={pick('安装', 'Install')} variant="primary" onPress={() => void install(phase.update, phase.path)} />
            : <Button label={pick('检查更新', 'Check for updates')} busy={phase.kind === 'checking'} disabled={phase.kind === 'checking'} onPress={() => void check()} />}
      <Meta style={{ fontSize: font.sm }}>{pick('从 GitHub 发布页下载，安装前核对包名与签名；安卓会弹出系统安装确认。', 'Downloads from GitHub Releases and checks the package name and signature; Android shows its own install prompt.')}</Meta>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { padding: space[4], borderWidth: 1, borderRadius: radius.lg, gap: space[3] }
})
